from pathlib import Path
from typing import Optional

from aws_cdk import (
    ArnFormat,
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_apigatewayv2 as apigwv2,
    aws_apigatewayv2_integrations as integrations,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_s3 as s3,
    aws_secretsmanager as secretsmanager,
    aws_sqs as sqs,
)
from constructs import Construct

from stz_agent.config import validate_model_provider

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ("doorman", "prime", "com")


class StzAgentStack(Stack):
    """Scale-to-zero agent stack (spec §2, §8; protocol §2, §4.2).

    Functions get explicit names and reference each other only by string
    name/ARN: Prime<->Com and Prime->Prime invokes would otherwise form a
    CloudFormation dependency cycle.
    """

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        spike_s2: bool = False,
        spike_s1: bool = False,
        model_provider: str = "mock",
        model_name: str = "mock",
        openai_base_url: Optional[str] = None,
        mock_delay_scale: Optional[str] = None,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        names = {f: f"{self.stack_name}-{f}" for f in FUNCTIONS}
        arns = {
            f: self.format_arn(
                service="lambda",
                resource="function",
                resource_name=n,
                arn_format=ArnFormat.COLON_RESOURCE_NAME,
            )
            for f, n in names.items()
        }

        # --- Storage -------------------------------------------------------
        bucket = s3.Bucket(
            self,
            "Bucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            encryption=s3.BucketEncryption.S3_MANAGED,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # --- Queues (no event source mappings: functions poll themselves) ---
        def dlq(name: str) -> sqs.DeadLetterQueue:
            q = sqs.Queue(self, f"{name}Dlq", retention_period=Duration.days(14))
            return sqs.DeadLetterQueue(queue=q, max_receive_count=5)

        queues = {
            "doorman": sqs.Queue(
                self,
                "DoormanMessages",
                visibility_timeout=Duration.seconds(30),
                retention_period=Duration.seconds(60),
            ),
            "prime": sqs.Queue(
                self,
                "PrimeMessages",
                visibility_timeout=Duration.minutes(15),
                dead_letter_queue=dlq("PrimeMessages"),
            ),
            "com": sqs.Queue(
                self,
                "ComMessages",
                visibility_timeout=Duration.seconds(30),
                dead_letter_queue=dlq("ComMessages"),
            ),
        }

        secret = secretsmanager.Secret(
            self, "ModelKeys", description="Model API keys JSON; set by a person"
        )

        # Generated at deploy time, so the value is never in the template.
        api_token_secret = secretsmanager.Secret(
            self,
            "ApiToken",
            description="Doorman bearer token",
            generate_secret_string=secretsmanager.SecretStringGenerator(
                password_length=48, exclude_punctuation=True
            ),
        )

        common_env = {
            "BUCKET_NAME": bucket.bucket_name,
            "DOORMAN_QUEUE_URL": queues["doorman"].queue_url,
            "PRIME_QUEUE_URL": queues["prime"].queue_url,
            "COM_QUEUE_URL": queues["com"].queue_url,
            "DOORMAN_FUNCTION_NAME": names["doorman"],
            "PRIME_FUNCTION_NAME": names["prime"],
            "COM_FUNCTION_NAME": names["com"],
        }

        # --- Functions -----------------------------------------------------
        def make_fn(
            key: str,
            memory: int,
            timeout: Duration,
            extra_env: dict,
            *,
            name: str | None = None,
            bundle: str | None = None,
            reserved: int | None = 1,
            env: dict | None = None,
        ) -> lambda_.Function:
            name = name or names[key]
            dist = ROOT / "functions" / "dist" / (bundle or key)
            if not (dist / "index.mjs").exists():
                raise FileNotFoundError(f"{dist}/index.mjs missing: run scripts/build.sh first")
            log_group = logs.LogGroup(
                self,
                f"{key.capitalize()}Logs",
                log_group_name=f"/aws/lambda/{name}",
                retention=logs.RetentionDays.ONE_WEEK,
                removal_policy=RemovalPolicy.DESTROY,
            )
            return lambda_.Function(
                self,
                key.capitalize(),
                function_name=name,
                runtime=lambda_.Runtime.NODEJS_22_X,
                architecture=lambda_.Architecture.X86_64,
                handler="index.handler",
                code=lambda_.Code.from_asset(str(dist)),
                memory_size=memory,
                timeout=timeout,
                reserved_concurrent_executions=reserved,
                log_group=log_group,
                environment={**(common_env if env is None else env), **extra_env},
            )

        # Doorman: HTTP API integrations cap at 30 s.
        doorman = make_fn(
            "doorman", 128, Duration.seconds(29), {"API_TOKEN_SECRET_ARN": api_token_secret.secret_arn}
        )
        prime_env = {"MODEL_PROVIDER": validate_model_provider(model_provider), "MODEL_NAME": model_name}
        if openai_base_url:
            prime_env["OPENAI_BASE_URL"] = openai_base_url
        com_env = {"MODEL_SECRET_ARN": secret.secret_arn}
        if mock_delay_scale is not None:
            com_env["MOCK_DELAY_SCALE"] = str(mock_delay_scale)
        prime = make_fn("prime", 2048, Duration.minutes(15), prime_env)
        com = make_fn("com", 128, Duration.minutes(15), com_env)
        fns = {"doorman": doorman, "prime": prime, "com": com}

        prime.configure_async_invoke(max_event_age=Duration.seconds(60), retry_attempts=0)

        # --- IAM -----------------------------------------------------------
        invokes = {"doorman": ["prime"], "prime": ["com", "prime"], "com": ["prime"]}
        for caller, targets in invokes.items():
            fns[caller].add_to_role_policy(
                iam.PolicyStatement(
                    actions=["lambda:InvokeFunction"],
                    resources=[arns[t] for t in targets],
                )
            )

        sends = {"doorman": ["prime"], "prime": ["doorman", "com"], "com": ["prime"]}
        for key, fn in fns.items():
            queues[key].grant_consume_messages(fn)
            for target in sends[key]:
                queues[target].grant_send_messages(fn)

        bucket.grant_read_write(prime)
        bucket.grant_read_write(com)
        bucket.grant_read(doorman)
        secret.grant_read(com)
        api_token_secret.grant_read(doorman)
        # Bedrock (auth "bedrock", #0025): Com signs with its own role. Cross-region
        # inference profiles fan out, so foundation models are allowed in any region.
        com.add_to_role_policy(
            iam.PolicyStatement(
                actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources=[
                    "arn:aws:bedrock:*::foundation-model/*",
                    self.format_arn(service="bedrock", resource="inference-profile", resource_name="*"),
                ],
            )
        )

        # --- Spike S2 (#0004): driver + target, not in demo --------------------
        if spike_s2:
            self._add_spike_s2(make_fn, bucket)

        # --- Spike S1 (#0020): off unless asked for ------------------------------
        if spike_s1:
            s1 = make_fn(
                "s1spike",
                2048,
                Duration.seconds(60),
                {},
                name=f"{self.stack_name}-s1-spike",
                reserved=None,
                env={"SPIKE_BUCKET": bucket.bucket_name},
            )
            bucket.grant_read_write(s1, "spikes/s1/*")
            CfnOutput(self, "S1SpikeFunctionName", value=s1.function_name)

        # --- HTTP API ------------------------------------------------------
        api = apigwv2.HttpApi(self, "Api")
        integration = integrations.HttpLambdaIntegration("DoormanIntegration", doorman)
        for method, path in (
            (apigwv2.HttpMethod.POST, "/messages"),
            (apigwv2.HttpMethod.POST, "/wake"),
            (apigwv2.HttpMethod.GET, "/events"),
        ):
            api.add_routes(path=path, methods=[method], integration=integration)

        # --- Outputs -------------------------------------------------------
        CfnOutput(self, "ApiUrl", value=api.api_endpoint)
        CfnOutput(self, "ApiTokenSecretArn", value=api_token_secret.secret_arn)
        CfnOutput(self, "BucketName", value=bucket.bucket_name)
        for key in FUNCTIONS:
            CfnOutput(self, f"{key.capitalize()}FunctionName", value=names[key])

    def _add_spike_s2(self, make_fn, bucket: s3.Bucket) -> None:
        """Driver runs the three wake checks against a reserved-concurrency-1 target."""

        def arn(n: str) -> str:
            return self.format_arn(
                service="lambda",
                resource="function",
                resource_name=n,
                arn_format=ArnFormat.COLON_RESOURCE_NAME,
            )

        target_name = f"{self.stack_name}-s2-target"
        driver_name = f"{self.stack_name}-s2-driver"
        env = {
            "SPIKE_BUCKET": bucket.bucket_name,
            "TARGET_FUNCTION_NAME": target_name,
        }
        target = make_fn(
            "s2target",
            128,
            Duration.seconds(60),
            {"SELF_FUNCTION_NAME": target_name},
            name=target_name,
            bundle="s2spike",
            env=env,
        )
        driver = make_fn(
            "s2driver",
            128,
            Duration.minutes(3),
            {"SELF_FUNCTION_NAME": driver_name},
            name=driver_name,
            bundle="s2spike",
            reserved=None,
            env=env,
        )
        target.configure_async_invoke(max_event_age=Duration.seconds(60), retry_attempts=0)
        for fn in (target, driver):
            fn.add_to_role_policy(
                iam.PolicyStatement(actions=["lambda:InvokeFunction"], resources=[arn(target_name)])
            )
            bucket.grant_read_write(fn, "spikes/s2/*")
        CfnOutput(self, "S2DriverFunctionName", value=driver_name)
