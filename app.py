#!/usr/bin/env python3
import getpass
import os
import re

import aws_cdk as cdk

from stz_agent.stz_agent_stack import StzAgentStack


app = cdk.App()

# Each developer gets their own copy of the stack, named by "env".
# Defaults to your OS username; override with e.g. `cdk deploy -c env=demo`.
env_name = app.node.try_get_context("env") or getpass.getuser()
if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9-]{0,30}", env_name):
    raise ValueError(f"env name {env_name!r} must be letters, digits, or hyphens")

stack = StzAgentStack(
    app,
    f"StzAgent-{env_name}",
    # Deploy to the account/region of the CLI profile in use (e.g. --profile stz-dev).
    # Spike S2 (#0004) driver/target: never in demo; turn off with -c spike_s2=off.
    spike_s2=env_name != "demo" and app.node.try_get_context("spike_s2") != "off",
    # Spike S1 in Lambda (#0020): only with -c spike_s1=on, never in demo.
    spike_s1=env_name != "demo" and app.node.try_get_context("spike_s1") == "on",
    # Prime's model: -c model_provider=mock|anthropic|openai|bedrock -c model_name=… [-c openai_base_url=…].
    model_provider=app.node.try_get_context("model_provider") or "mock",
    model_name=app.node.try_get_context("model_name") or "mock",
    openai_base_url=app.node.try_get_context("openai_base_url"),
    # Com's mock delays, e.g. -c mock_delay_scale=0.1 for a fast smoke run.
    mock_delay_scale=app.node.try_get_context("mock_delay_scale"),
    env=cdk.Environment(
        account=os.getenv("CDK_DEFAULT_ACCOUNT"),
        region=os.getenv("CDK_DEFAULT_REGION"),
    ),
)
cdk.Tags.of(stack).add("project", "stz-agent")
cdk.Tags.of(stack).add("env", env_name)

app.synth()
