# stz-agent
Scale to Zero cloud agent architecture

Infrastructure is defined with the AWS CDK (Python) and deploys to `us-west-2`.

## One-time setup

Prerequisites: AWS CLI v2, Node 22+ (24 recommended), Python 3.12, and the CDK CLI:

```
npm install -g aws-cdk
```

1. **Accept your IAM Identity Center invite** (email) and set your password and MFA.
2. **Create the CLI profile.** It must be named `stz-dev`, because `cdk.json` uses that name:
   ```
   aws configure sso
   ```
   | Prompt | Answer |
   |---|---|
   | SSO session name | `stz` |
   | SSO start URL | the access portal URL you were sent |
   | SSO region | `us-east-2` (Identity Center lives here; resources are in us-west-2) |
   | Role | `Sr-Developer` |
   | Default client Region | `us-west-2` |
   | Profile name | `stz-dev` |

   Verify with `aws sts get-caller-identity --profile stz-dev`.
3. **Create the Python venv**, from the repo root:
   ```
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt -r requirements-dev.txt
   ```

The account is already bootstrapped for CDK, so you don't need to run `cdk bootstrap`.

## Daily use

```
source .venv/bin/activate
aws sso login --profile stz-dev     # when your 8-hour session expires
cdk deploy                          # deploys your own stack, StzAgent-<your username>
```

Each developer gets their own stack, named from your OS username. Override the name with `-c env=<name>`. For example, the shared demo stack is deployed with `cdk deploy -c env=demo`.

`cdk` uses the `stz-dev` profile from `cdk.json`. Plain `aws` commands need `--profile stz-dev`, or `export AWS_PROFILE=stz-dev` in your shell.

## Useful commands

* `cdk ls`: list stacks in the app
* `cdk synth`: emit the synthesized CloudFormation template
* `cdk diff`: compare the deployed stack with the current code
* `cdk deploy`: deploy your stack
* `cdk destroy`: delete your stack
* `pytest`: run unit tests
