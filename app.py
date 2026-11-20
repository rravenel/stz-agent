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
    env=cdk.Environment(
        account=os.getenv("CDK_DEFAULT_ACCOUNT"),
        region=os.getenv("CDK_DEFAULT_REGION"),
    ),
)
cdk.Tags.of(stack).add("project", "stz-agent")
cdk.Tags.of(stack).add("env", env_name)

app.synth()
