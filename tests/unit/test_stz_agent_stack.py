import json
import re
from fnmatch import fnmatchcase

import aws_cdk as core
import aws_cdk.assertions as assertions
import pytest
from aws_cdk.assertions import Match

from stz_agent.stz_agent_stack import StzAgentStack

STACK = "StzAgent-test"
NAMES = {f: f"{STACK}-{f}" for f in ("doorman", "prime", "com")}


@pytest.fixture(scope="module")
def template():
    app = core.App()
    stack = StzAgentStack(app, STACK)
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
    extra = {"doorman": {"API_TOKEN_SECRET_ARN"}, "prime": {"MODEL_PROVIDER", "MODEL_NAME"}, "com": {"MODEL_SECRET_ARN"}}
    for key in NAMES:
        _, fn = fn_resource(template, key)
        env = fn["Properties"]["Environment"]["Variables"]
        assert set(env) == common | extra[key], key
        assert env["PRIME_FUNCTION_NAME"] == NAMES["prime"]


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


def secret_id(template, construct):
    found = [i for i in template.find_resources("AWS::SecretsManager::Secret") if i.startswith(construct)]
    assert len(found) == 1, found
    return found[0]


def secret_readers(template):
    """Secret logical ID (or raw JSON of any other resource) -> role logical IDs that may read it."""
    out = {}
    for pol in template.find_resources("AWS::IAM::Policy").values():
        for s in pol["Properties"]["PolicyDocument"]["Statement"]:
            if not any(fnmatchcase("secretsmanager:getsecretvalue", a.lower()) for a in as_list(s["Action"])):
                continue
            for r in as_list(s["Resource"]):
                key = r["Ref"] if isinstance(r, dict) and "Ref" in r else json.dumps(r)
                out.setdefault(key, set()).update(x["Ref"] for x in pol["Properties"]["Roles"])
    return out


def role_of(template, key):
    return fn_resource(template, key)[1]["Properties"]["Role"]["Fn::GetAtt"][0]


def test_each_secret_has_one_reader(template):
    assert secret_readers(template) == {
        secret_id(template, "ModelKeys"): {role_of(template, "com")},
        secret_id(template, "ApiToken"): {role_of(template, "doorman")},
    }


def test_api_token_is_generated_and_never_in_the_template(template):
    tok = secret_id(template, "ApiToken")
    props = template.find_resources("AWS::SecretsManager::Secret")[tok]["Properties"]
    assert props["GenerateSecretString"] == {"ExcludePunctuation": True, "PasswordLength": 48}
    assert "SecretString" not in props
    text = json.dumps(template.to_json())
    assert "test-token" not in text and "build-placeholder" not in text
    assert '"API_TOKEN"' not in text
    _, doorman = fn_resource(template, "doorman")
    assert doorman["Properties"]["Environment"]["Variables"]["API_TOKEN_SECRET_ARN"] == {"Ref": tok}


QUEUE_CONSTRUCTS = {"doorman": "DoormanMessages", "prime": "PrimeMessages", "com": "ComMessages"}
CONSUME_ACTIONS = ("sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility")
SENDS = {"doorman": {"prime"}, "prime": {"doorman", "com"}, "com": {"prime"}}


def queue_ids(template):
    """Function key -> logical ID of its main queue (never a DLQ)."""
    queues = template.find_resources("AWS::SQS::Queue")
    out = {}
    for key, construct in QUEUE_CONSTRUCTS.items():
        path = f"{STACK}/{construct}/Resource"
        found = [i for i, q in queues.items() if q.get("Metadata", {}).get("aws:cdk:path") == path]
        if not found:  # no path metadata: CDK logical IDs are the construct id + 8 hex digits
            found = [i for i in queues if re.fullmatch(construct + r"[0-9A-F]{8}", i)]
        assert len(found) == 1, f"{construct}: {found}"
        out[key] = found[0]
    return out


def sqs_targets(template, key, action):
    """Queues on which the function's role is granted `action`.

    A resource that isn't a main queue (a DLQ, a wildcard) is returned as raw
    JSON, so it can never match an expected set. Wildcard actions count too.
    """
    by_id = {i: k for k, i in queue_ids(template).items()}
    out = set()
    for s in role_statements(template, key):
        if s["Effect"] != "Allow":
            continue
        # IAM action names are case-insensitive.
        if not any(fnmatchcase(action.lower(), a.lower()) for a in as_list(s["Action"])):
            continue
        for r in as_list(s["Resource"]):
            arn = r.get("Fn::GetAtt") if isinstance(r, dict) else None
            known = arn and arn[1] == "Arn" and arn[0] in by_id
            out.add(by_id[arn[0]] if known else json.dumps(r))
    return out


def test_queue_ids_skip_dlqs(template):
    ids = queue_ids(template)
    assert len(set(ids.values())) == 3
    assert not any("Dlq" in i for i in ids.values())


def test_queue_permissions(template):
    for key in NAMES:
        for action in CONSUME_ACTIONS:
            assert sqs_targets(template, key, action) == {key}, (key, action)
        assert sqs_targets(template, key, "sqs:SendMessage") == SENDS[key], key


# --- API & outputs ------------------------------------------------------


def test_http_api_routes(template):
    template.resource_count_is("AWS::ApiGatewayV2::Api", 1)
    for route in ("POST /messages", "POST /wake", "GET /events"):
        template.has_resource_properties("AWS::ApiGatewayV2::Route", {"RouteKey": route})
    template.resource_count_is("AWS::ApiGatewayV2::Route", 3)
    template.resource_count_is("AWS::ApiGatewayV2::Authorizer", 0)


def test_outputs(template):
    outputs = template.find_outputs("*")
    for key in ("ApiUrl", "ApiTokenSecretArn", "BucketName", "DoormanFunctionName", "PrimeFunctionName", "ComFunctionName"):
        assert key in outputs


# --- Spike S2 (#0004) ---------------------------------------------------

S2 = {"s2-target": f"{STACK}-s2-target", "s2-driver": f"{STACK}-s2-driver"}


@pytest.fixture(scope="module")
def spike_template():
    app = core.App()
    stack = StzAgentStack(app, STACK, spike_s2=True)
    return assertions.Template.from_stack(stack)


def s2_fn(template, key):
    found = template.find_resources(
        "AWS::Lambda::Function", {"Properties": {"FunctionName": S2[key]}}
    )
    assert len(found) == 1, f"function {S2[key]} not found"
    return next(iter(found.items()))


def s2_invoke_resources(template, key):
    _, fn = s2_fn(template, key)
    role_ref = fn["Properties"]["Role"]["Fn::GetAtt"][0]
    out = []
    for pol in template.find_resources("AWS::IAM::Policy").values():
        if {"Ref": role_ref} not in pol["Properties"]["Roles"]:
            continue
        for s in pol["Properties"]["PolicyDocument"]["Statement"]:
            if "lambda:InvokeFunction" in as_list(s["Action"]):
                out += [json.dumps(r) for r in as_list(s["Resource"])]
    return out


def test_spike_s2_absent_by_default(template):
    for name in S2.values():
        assert not template.find_resources(
            "AWS::Lambda::Function", {"Properties": {"FunctionName": name}}
        )
    assert "S2DriverFunctionName" not in template.find_outputs("*")


def test_spike_s2_functions(spike_template):
    _, target = s2_fn(spike_template, "s2-target")
    _, driver = s2_fn(spike_template, "s2-driver")
    t, d = target["Properties"], driver["Properties"]
    assert (t["MemorySize"], t["Timeout"], t["ReservedConcurrentExecutions"]) == (128, 60, 1)
    assert (d["MemorySize"], d["Timeout"]) == (128, 180)
    assert "ReservedConcurrentExecutions" not in d
    for p in (t, d):
        env = p["Environment"]["Variables"]
        assert set(env) == {"SPIKE_BUCKET", "TARGET_FUNCTION_NAME", "SELF_FUNCTION_NAME"}
        assert env["TARGET_FUNCTION_NAME"] == S2["s2-target"]
    assert t["Environment"]["Variables"]["SELF_FUNCTION_NAME"] == S2["s2-target"]
    assert "S2DriverFunctionName" in spike_template.find_outputs("*")


def test_spike_s2_async_invoke_config(spike_template):
    target_id, _ = s2_fn(spike_template, "s2-target")
    spike_template.has_resource_properties(
        "AWS::Lambda::EventInvokeConfig",
        {"FunctionName": {"Ref": target_id}, "MaximumEventAgeInSeconds": 60, "MaximumRetryAttempts": 0},
    )


def test_spike_s2_invoke_permissions(spike_template):
    for key in ("s2-target", "s2-driver"):
        res = s2_invoke_resources(spike_template, key)
        assert res and all(f':function:{S2["s2-target"]}"' in r for r in res), key


def test_spike_s2_bucket_scoped(spike_template):
    _, target = s2_fn(spike_template, "s2-target")
    role_ref = target["Properties"]["Role"]["Fn::GetAtt"][0]
    s3_res = []
    for pol in spike_template.find_resources("AWS::IAM::Policy").values():
        if {"Ref": role_ref} in pol["Properties"]["Roles"]:
            for s in pol["Properties"]["PolicyDocument"]["Statement"]:
                if any(a.startswith("s3:") for a in as_list(s["Action"])):
                    s3_res += [json.dumps(r) for r in as_list(s["Resource"])]
    assert any("spikes/s2/*" in r for r in s3_res)


def test_spike_s2_has_no_sqs(spike_template):
    for key in S2:
        _, fn = s2_fn(spike_template, key)
        role_ref = fn["Properties"]["Role"]["Fn::GetAtt"][0]
        actions = []
        for pol in spike_template.find_resources("AWS::IAM::Policy").values():
            if {"Ref": role_ref} in pol["Properties"]["Roles"]:
                for s in pol["Properties"]["PolicyDocument"]["Statement"]:
                    actions += as_list(s["Action"])
        assert actions, key
        assert not [a for a in actions if a == "*" or a.lower().startswith("sqs:")], key


def test_spike_s2_keeps_core_tests(spike_template):
    test_queue_permissions(spike_template)
    test_each_secret_has_one_reader(spike_template)
    test_invoke_permissions(spike_template)


# --- Model config (#0008) -------------------------------------------------


def env_of(template, key):
    _, fn = fn_resource(template, key)
    return fn["Properties"]["Environment"]["Variables"]


def test_prime_model_defaults_to_mock(template):
    env = env_of(template, "prime")
    assert env["MODEL_PROVIDER"] == "mock" and env["MODEL_NAME"] == "mock"
    assert "OPENAI_BASE_URL" not in env
    assert "MOCK_DELAY_SCALE" not in env_of(template, "com")


def test_model_config_passes_through():
    app = core.App()
    stack = StzAgentStack(
        app,
        STACK,
        model_provider="openai",
        model_name="gpt-x",
        openai_base_url="https://llm.example/v1",
        mock_delay_scale="0.1",
    )
    t = assertions.Template.from_stack(stack)
    env = env_of(t, "prime")
    assert (env["MODEL_PROVIDER"], env["MODEL_NAME"], env["OPENAI_BASE_URL"]) == (
        "openai",
        "gpt-x",
        "https://llm.example/v1",
    )
    assert env_of(t, "com")["MOCK_DELAY_SCALE"] == "0.1"


def test_invalid_model_provider_raises():
    with pytest.raises(ValueError, match="model_provider"):
        StzAgentStack(core.App(), STACK, model_provider="gemini")


# --- Bedrock (#0025) ------------------------------------------------------

BEDROCK_ACTIONS = {"bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"}


def bedrock_statements(template, key):
    return [s for s in role_statements(template, key) if BEDROCK_ACTIONS & set(as_list(s["Action"]))]


def test_only_com_invokes_bedrock(template):
    (stmt,) = bedrock_statements(template, "com")
    assert set(as_list(stmt["Action"])) == BEDROCK_ACTIONS
    res = [json.dumps(r) for r in as_list(stmt["Resource"])]
    assert '"arn:aws:bedrock:*::foundation-model/*"' in res
    assert any(":inference-profile/*" in r and "AWS::AccountId" in r for r in res)
    assert len(res) == 2
    for key in ("prime", "doorman"):
        assert bedrock_statements(template, key) == [], key
