#!/usr/bin/env bash
# 냉장고를 부탁해 - Azure 최초 배포 (이후 배포는 GitHub Actions가 한다)
#
#   az login
#   bash infra/deploy.sh
#
# 환경 변수로 바꿀 수 있는 값:
#   RESOURCE_GROUP (기본 rg-fridge-chef), LOCATION (기본 koreacentral), PREFIX (기본 fridgechef)
#   OPENROUTER_API_KEY (없으면 .env에서 이 한 줄만 읽는다)
#   SESSION_SECRET (없으면 새로 만든다. .env의 로컬 값은 쓰지 않는다)
set -euo pipefail
cd "$(dirname "$0")/.."

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-fridge-chef}"
LOCATION="${LOCATION:-koreacentral}"
PREFIX="${PREFIX:-fridgechef}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

if [[ -z "${OPENROUTER_API_KEY:-}" && -f .env ]]; then
  OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
fi
# 운영용 세션 키는 로컬(.env)과 다르게 새로 만든다. 이 스크립트를 다시 실행하면 키가 바뀌어 모든 사용자가 로그아웃된다.
# 유지하려면 기존 값을 SESSION_SECRET 환경 변수로 넘긴다.
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32)}"
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY가 없습니다. 환경 변수나 .env에 넣어 주세요." >&2
  exit 1
fi

echo "구독: $(az account show --query name -o tsv)"
echo "리소스 그룹: $RESOURCE_GROUP ($LOCATION), 이미지 태그: $TAG"

az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

echo "[1/3] 기반 리소스 (ACR, Cosmos DB, Container Apps 환경, 관리 ID)"
az deployment group create -g "$RESOURCE_GROUP" -n fridge-chef-base -f infra/main.bicep \
  -p prefix="$PREFIX" deployApp=false -o none
ACR_NAME="$(az deployment group show -g "$RESOURCE_GROUP" -n fridge-chef-base --query properties.outputs.acrName.value -o tsv)"

echo "[2/3] 이미지 빌드 → $ACR_NAME (ACR에서 빌드하므로 로컬 Docker 불필요)"
az acr build -r "$ACR_NAME" -t "fridge-chef:$TAG" . -o none

echo "[3/3] Container App"
# API 키가 명령줄(프로세스 목록)에 보이지 않도록 임시 매개변수 파일로 넘긴다
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
chmod 600 "$PARAMS"
printf '{"openRouterApiKey":{"value":"%s"},"sessionSecret":{"value":"%s"}}' "$OPENROUTER_API_KEY" "$SESSION_SECRET" > "$PARAMS"
az deployment group create -g "$RESOURCE_GROUP" -n fridge-chef-app -f infra/main.bicep \
  -p prefix="$PREFIX" deployApp=true containerImage="$ACR_NAME.azurecr.io/fridge-chef:$TAG" -p "@$PARAMS" -o none

APP_URL="$(az deployment group show -g "$RESOURCE_GROUP" -n fridge-chef-app --query properties.outputs.appUrl.value -o tsv)"
echo "확인: $APP_URL/healthz"
curl -fsS --retry 10 --retry-delay 6 --retry-all-errors "$APP_URL/healthz" && echo
echo "배포 완료: $APP_URL"
echo "GitHub Actions 설정용 값 → ACR_NAME=$ACR_NAME RESOURCE_GROUP=$RESOURCE_GROUP CONTAINER_APP=${PREFIX}-app"
