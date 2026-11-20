#!/usr/bin/env bash
# Build, then deploy one stack with the stz-dev profile. Needs AWS SSO
# credentials, so a person runs this (agents can't read AWS credentials).
#
# Usage: scripts/deploy.sh [env]      # default env = your OS username
#        scripts/deploy.sh demo --yes # the shared demo stack needs --yes
# Output: one line per step plus the stack outputs (API URL etc.).
source "$(dirname "$0")/lib.sh"

env_name="${1:-$(id -un)}"
if [ "$env_name" = demo ] && [ "${2:-}" != --yes ]; then
  echo "refusing to deploy the shared demo stack without --yes" >&2; exit 2
fi

"$ROOT/scripts/build.sh" || exit 1

# The CDK CLI pinned in functions/package-lock.json, never a global or npx one.
CDK="$(cdk_cli)" || exit 1
venv_python >/dev/null || exit 1
step aws-identity aws sts get-caller-identity --profile stz-dev || {
  echo "     run: aws sso login --profile stz-dev"; exit 1; }
# --app runs the venv's Python: cdk.json's `python3 app.py` would pick up
# whatever python3 is on PATH outside an activated venv.
# --require-approval never: this is a personal dev stack (or demo with --yes).
step "cdk-deploy-$env_name" "$CDK" deploy --app ".venv/bin/python app.py" -c env="$env_name" \
  --require-approval never --outputs-file "$ROOT/cdk.out/outputs-$env_name.json" || finish
cat "$ROOT/cdk.out/outputs-$env_name.json"

finish
