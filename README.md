# stz-agent
Scale to Zero cloud agent architecture

Infrastructure is defined with the AWS CDK (Python) and deploys to `us-west-2`.

## One-time setup

Prerequisites: AWS CLI v2, Node 22 (`.nvmrc`), and Python 3.12 (`.python-version`; `uv python install 3.12` works). The CDK CLI is pinned in `functions/package.json` and installed by `scripts/setup.sh`, so don't install it globally.

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
3. **Install dependencies**, from the repo root:
   ```
   scripts/setup.sh
   ```
   It creates `.venv` with Python 3.12 and installs exactly what the lock files say: `requirements.lock` (hash-checked) and `functions/package-lock.json` (`npm ci`). To add or upgrade a dependency, edit `requirements.txt`/`requirements-dev.txt` or a `package.json`, run `scripts/lock.sh` (`--upgrade` for newest allowed versions), and commit the lock files with the change.

The account is already bootstrapped for CDK, so you don't need to run `cdk bootstrap`.

## Daily use

```
source .venv/bin/activate
aws sso login --profile stz-dev     # when your 8-hour session expires
scripts/deploy.sh                   # deploys your own stack, StzAgent-<your username>
```

`scripts/deploy.sh` uses the pinned CDK CLI and the venv's Python. If you run `cdk` by hand, use `functions/node_modules/.bin/cdk` with the venv activated.

Each developer gets their own stack, named from your OS username. Override the name with `-c env=<name>`. For example, the shared demo stack is deployed with `cdk deploy -c env=demo`.

`cdk` uses the `stz-dev` profile from `cdk.json`. Plain `aws` commands need `--profile stz-dev`, or `export AWS_PROFILE=stz-dev` in your shell.

## Useful commands

* `cdk ls`: list stacks in the app
* `cdk synth`: emit the synthesized CloudFormation template
* `cdk diff`: compare the deployed stack with the current code
* `cdk deploy`: deploy your stack
* `cdk destroy`: delete your stack
* `pytest`: run unit tests
