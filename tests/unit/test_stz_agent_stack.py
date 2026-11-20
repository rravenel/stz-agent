import json

import aws_cdk as core
import aws_cdk.assertions as assertions
import pytest
from aws_cdk.assertions import Match

from stz_agent.config import BUILD_PLACEHOLDER_TOKEN, resolve_api_token
from stz_agent.stz_agent_stack import StzAgentStack

STACK = "StzAgent-test"
NAMES = {f: f"{STACK}-{f}" for f in ("doorman", "prime", "com")}


@pytest.fixture(scope="module")
def template():
    app = core.App()
    stack = StzAgentStack(app, STACK, api_token="test-token")
    return assertions.Template.from_stack(stack)


def fn_resource(template, key):
    found = template.find_resources(
        "AWS::Lambda::Function", {"Properties": {"FunctionName": NAMES[key]}}
    )
    assert len(found) == 1, f"function {NAMES[key]} not found"
    return next(iter(found.items()))


def role_statements(template, key):
    """All IAM statements in policies attached to the function's role."""
    _, fn = fn_resource(template, key)
    role_ref = fn["Properties"]["Role"]["Fn::GetAtt"][0]
    stmts = []
    for pol in template.find_resources("AWS::IAM::Policy").values():
        roles = [r.get("Ref") for r in pol["Properties"]["Roles"]]
        if role_ref in roles:
            stmts += pol["Properties"]["PolicyDocument"]["Statement"]
    return stmts


def as_list(x):
    return x if isinstance(x, list) else [x]


def invoke_targets(template, key):
    out = set()
    for s in role_statements(template, key):
        if "lambda:InvokeFunction" in as_list(s["Action"]):
            for r in as_list(s["Resource"]):
                text = json.dumps(r)
                out |= {f for f, n in NAMES.items() if f':function:{n}"' in text}
    return out


# --- Bucket -------------------------------------------------------------


def test_bucket_blocks_public_access_and_enforces_ssl(template):
    template.has_resource_properties(
        "AWS::S3::Bucket",
        {
            "PublicAccessBlockConfiguration": {
                "BlockPublicAcls": True,
                "BlockPublicPolicy": True,
                "IgnorePublicAcls": True,
                "RestrictPublicBuckets": True,
            }
        },
    )
    template.has_resource_properties(
        "AWS::S3::BucketPolicy",
        {
            "PolicyDocument": {
                "Statement": Match.array_with(
                    [
                        Match.object_like(
                            {
                                "Effect": "Deny",
                                "Condition": {"Bool": {"aws:SecureTransport": "false"}},
                            }
                        )
                    ]
                )
            }
        },
    )
    template.has_resource("AWS::S3::Bucket", {"DeletionPolicy": "Delete"})


# --- Queues -------------------------------------------------------------


def test_queues(template):
    template.has_resource_properties(
        "AWS::SQS::Queue",
        {"VisibilityTimeout": 30, "MessageRetentionPeriod": 60, "RedrivePolicy": Match.absent()},
    )
    template.has_resource_properties(
        "AWS::SQS::Queue",
        {"VisibilityTimeout": 900, "RedrivePolicy": Match.object_like({"maxReceiveCount": 5})},
    )
    template.has_resource_properties(
        "AWS::SQS::Queue",
        {"VisibilityTimeout": 30, "RedrivePolicy": Match.object_like({"maxReceiveCount": 5})},
    )
    dlqs = template.find_resources(
        "AWS::SQS::Queue", {"Properties": {"MessageRetentionPeriod": 14 * 24 * 3600}}
    )
    assert len(dlqs) == 2
    template.resource_count_is("AWS::SQS::Queue", 5)


def test_no_event_source_mappings(template):
    template.resource_count_is("AWS::Lambda::EventSourceMapping", 0)


# --- Functions ----------------------------------------------------------


@pytest.mark.parametrize(
    "key,memory,timeout",
    [("doorman", 128, 29), ("prime", 2048, 900), ("com", 128, 900)],
)
def test_function_config(template, key, memory, timeout):
    _, fn = fn_resource(template, key)
    p = fn["Properties"]
    assert p["MemorySize"] == memory
    assert p["Timeout"] == timeout
    assert p["Runtime"] == "nodejs22.x"
    assert p["Handler"] == "index.handler"
    assert p["ReservedConcurrentExecutions"] == 1


def test_function_env_vars(template):
    common = {
        "BUCKET_NAME",
        "DOORMAN_QUEUE_URL",
        "PRIME_QUEUE_URL",
        "COM_QUEUE_URL",
        "DOORMAN_FUNCTION_NAME",
        "PRIME_FUNCTION_NAME",
        "COM_FUNCTION_NAME",
    }
    extra = {"doorman": {"API_TOKEN"}, "prime": set(), "com": {"MODEL_SECRET_ARN"}}
    for key in NAMES:
        _, fn = fn_resource(template, key)
        env = fn["Properties"]["Environment"]["Variables"]
        assert set(env) == common | extra[key], key
        assert env["PRIME_FUNCTION_NAME"] == NAMES["prime"]
    _, doorman = fn_resource(template, "doorman")
    assert doorman["Properties"]["Environment"]["Variables"]["API_TOKEN"] == "test-token"


def test_prime_async_invoke_config(template):
    prime_id, _ = fn_resource(template, "prime")
    template.has_resource_properties(
        "AWS::Lambda::EventInvokeConfig",
        {
            "FunctionName": {"Ref": prime_id},
            "MaximumEventAgeInSeconds": 60,
            "MaximumRetryAttempts": 0,
        },
    )


def test_log_groups(template):
    for name in NAMES.values():
        template.has_resource_properties(
            "AWS::Logs::LogGroup", {"LogGroupName": f"/aws/lambda/{name}", "RetentionInDays": 7}
        )


# --- IAM ----------------------------------------------------------------


def test_invoke_permissions(template):
    assert invoke_targets(template, "doorman") == {"prime"}
    assert invoke_targets(template, "prime") == {"prime", "com"}
    assert invoke_targets(template, "com") == {"prime"}


def test_only_com_reads_secret(template):
    holders = []
    for pid, pol in template.find_resources("AWS::IAM::Policy").items():
        for s in pol["Properties"]["PolicyDocument"]["Statement"]:
            if "secretsmanager:GetSecretValue" in as_list(s["Action"]):
                holders.append(pol)
    assert len(holders) == 1
    _, com = fn_resource(template, "com")
    role_ref = com["Properties"]["Role"]["Fn::GetAtt"][0]
    assert {"Ref": role_ref} in holders[0]["Properties"]["Roles"]


def test_queue_permissions(template):
    def actions(key):
        return {a for s in role_statements(template, key) for a in as_list(s["Action"])}

    for key in NAMES:
        acts = actions(key)
        assert "sqs:ReceiveMessage" in acts and "sqs:SendMessage" in acts, key


# --- API & outputs ------------------------------------------------------


def test_http_api_routes(template):
    template.resource_count_is("AWS::ApiGatewayV2::Api", 1)
    for route in ("POST /messages", "POST /wake", "GET /events"):
        template.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": route})
    template.resource_count_is("AWS::ApiGatewayV2::Route", 3)
    template.resource_count_is("AWS::ApiGatewayV2::Authorizer", 0)


def test_outputs(template):
    outputs = template.find_outputs("*")
    for key in ("ApiUrl", "BucketName", "DoormanFunctionName", "PrimeFunctionName", "ComFunctionName"):
        assert key in outputs


# --- Token resolution ---------------------------------------------------


def test_resolve_api_token(monkeypatch):
    monkeypatch.delenv("STZ_API_TOKEN", raising=False)
    assert resolve_api_token("build", None) == BUILD_PLACEHOLDER_TOKEN
    assert resolve_api_token("rene", "ctx") == "ctx"
    with pytest.raises(ValueError):
        resolve_api_token("rene", None)
    monkeypatch.setenv("STZ_API_TOKEN", "envtok")
    assert resolve_api_token("rene", None) == "envtok"
