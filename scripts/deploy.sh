#!/usr/bin/env bash
# Деплой boulder-plan на boulder.dtcdev.click (как fitness-tracker/scripts/deploy.sh).
# Локально ничего из этого не нужно: npm run dev работает без AUTH_*.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-eu-west-1}"
STACK="${STACK:-boulder-plan}"
AUTH_STACK="${AUTH_STACK:-dtcdev-shared-auth}"
DOMAIN="${DOMAIN:-boulder.dtcdev.click}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${ARTIFACT_BUCKET:-boulder-plan-deploy-${ACCOUNT_ID}-${REGION}}"

auth_output() {
  aws cloudformation describe-stacks --region us-east-1 --stack-name "$AUTH_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

AUTH_CLIENT_ID="${AUTH_CLIENT_ID:-$(auth_output BoulderClientId)}"
AUTH_ISSUER="${AUTH_ISSUER:-$(auth_output IssuerUrl)}"
AUTH_JWKS_URL="${AUTH_JWKS_URL:-$(auth_output JwksUrl)}"
if [[ -z "$AUTH_CLIENT_ID" || "$AUTH_CLIENT_ID" == "None" ]]; then
  echo "No BoulderClientId in $AUTH_STACK — deploy sandbox/auth first." >&2
  exit 1
fi

if [[ -z "${JWT_SECRET:-}" ]]; then
  FUNCTION_NAME="$(aws cloudformation describe-stack-resource --region "$REGION" --stack-name "$STACK" \
    --logical-resource-id BoulderFunction --query StackResourceDetail.PhysicalResourceId --output text 2>/dev/null || true)"
  if [[ -n "${FUNCTION_NAME:-}" && "$FUNCTION_NAME" != "None" ]]; then
    JWT_SECRET="$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
      --query 'Environment.Variables.JWT_SECRET' --output text)"
  else
    JWT_SECRET="$(openssl rand -hex 48)"
  fi
fi

npm --workspace backend run build
npm --workspace frontend run build
rm -rf backend/frontend && cp -r frontend/dist backend/frontend

SHA="$(git rev-parse --short HEAD)"
KEY="boulder-plan-${SHA}.zip"
rm -rf .tmp/artifact ".tmp/${KEY}"
mkdir -p .tmp/artifact/content
cp -r backend/dist .tmp/artifact/dist
cp -r frontend/dist .tmp/artifact/frontend
cp content/plan.json .tmp/artifact/content/plan.json
(cd .tmp/artifact && zip -qr "../${KEY}" .)
unzip -l ".tmp/${KEY}" | head -8

aws s3 mb "s3://${BUCKET}" --region "$REGION" 2>/dev/null || true
aws s3 cp ".tmp/${KEY}" "s3://${BUCKET}/${KEY}" --region "$REGION"

aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file infra/template.yaml --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset --parameter-overrides \
    CodeBucket="$BUCKET" CodeKey="$KEY" JwtSecret="$JWT_SECRET" DomainName="$DOMAIN" \
    AuthBaseUrl=https://auth.dtcdev.click AuthClientId="$AUTH_CLIENT_ID" \
    AuthIssuer="$AUTH_ISSUER" AuthJwksUrl="$AUTH_JWKS_URL"

echo "Deployed https://${DOMAIN}"
