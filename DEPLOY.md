# 배포 가이드 (Azure Container Apps)

**냉장고를 부탁해**를 Azure에 처음 배포하고, 이후 GitHub Actions로 자동 배포하는 방법이다. 설계 배경은 [PRD_step3.md](PRD_step3.md) 10장에 있다.

## 구성

| 리소스 | 용도 | 인증 |
|---|---|---|
| Container App (`fridgechef-app`) | 앱 실행. 외부 HTTPS, 포트 8080, 복제본 0~2개 | OpenRouter 키와 세션 서명 키(`SESSION_SECRET`)는 secret으로 넣음 |
| Container Registry (Basic) | 이미지 저장 | 관리 ID로 이미지 받기(AcrPull). admin 계정 끔 |
| Cosmos DB for NoSQL (서버리스) | DB `fridge-chef`. 컨테이너 `recipes`(파티션 키 `/clientId` = 사용자 ID), `users`(파티션 키 `/id` = 이메일, 비밀번호는 해시만 저장) | 관리 ID(데이터 기여자 역할). 키 인증 끔 |
| 사용자 할당 관리 ID | ACR과 Cosmos DB 접근 | — |
| Container Apps 환경 + Log Analytics | 실행 환경, 로그 | — |

모든 리소스는 [infra/main.bicep](infra/main.bicep)에 정의되어 있다.

## 1. 최초 배포

준비물: [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), 리소스를 만들 수 있는 구독. 로컬 Docker는 필요 없다(이미지는 ACR에서 빌드한다).

```bash
az login
az account set --subscription "<구독 이름 또는 ID>"
bash infra/deploy.sh
```

- 기본값은 리소스 그룹 `rg-fridge-chef`, 지역 `koreacentral`이다. 바꾸려면 `RESOURCE_GROUP`, `LOCATION`, `PREFIX` 환경 변수를 설정한다.
- OpenRouter 키는 `.env`의 `OPENROUTER_API_KEY` 한 줄만 읽어서 Container App secret으로 넣는다.
- 세션 서명 키(`SESSION_SECRET`)는 운영용으로 새로 만든다. 로컬 `.env`의 값은 쓰지 않는다.
  - 스크립트를 다시 실행하면 키가 바뀌어 모든 사용자가 로그아웃된다.
  - 기존 키를 유지하려면 그 값을 `SESSION_SECRET` 환경 변수로 넘긴다.
- 배포가 끝나면 앱 주소와 GitHub Actions에 넣을 값(`ACR_NAME` 등)이 출력된다.

## 2. GitHub Actions 자동 배포 설정 (OIDC)

[.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml)이 하는 일:
- PR을 올리면 테스트와 Docker 빌드를 한다.
- `main`에 병합되면 ACR에서 이미지를 빌드하고, Container App에 새 리비전으로 배포한 뒤 `/healthz`로 확인한다.
- Azure 로그인은 OIDC로 하므로 비밀번호를 GitHub에 저장하지 않는다.

```bash
REPO="<GitHub 계정>/<저장소>"           # 예: someone/fridge-chef
RG=rg-fridge-chef
SUB_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
ACR_ID="$(az acr list -g "$RG" --query '[0].id' -o tsv)"

APP_ID="$(az ad app create --display-name fridge-chef-github --query appId -o tsv)"
az ad sp create --id "$APP_ID" -o none

# production 환경에서 실행되는 워크플로만 로그인 허용
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"github-production\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:$REPO:environment:production\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

# 권한: 리소스 그룹 안에서만 (이미지 빌드, Container App 수정)
az role assignment create --assignee "$APP_ID" --role Contributor --scope "/subscriptions/$SUB_ID/resourceGroups/$RG" -o none
az role assignment create --assignee "$APP_ID" --role AcrPush --scope "$ACR_ID" -o none

echo "AZURE_CLIENT_ID=$APP_ID AZURE_TENANT_ID=$TENANT_ID AZURE_SUBSCRIPTION_ID=$SUB_ID"
```

GitHub 저장소에서 할 일:

1. **Environment 만들기:** Settings → Environments에서 `production`을 만든다.
   - 필요하면 배포 승인자를 지정한다.
2. **변수 등록:** Settings → Secrets and variables → Actions → **Variables**에 아래 값을 넣는다. 비밀 값이 아니므로 Variables에 둔다.

| 변수 | 값 |
|---|---|
| `AZURE_CLIENT_ID` | 위에서 출력된 값 |
| `AZURE_TENANT_ID` | 위에서 출력된 값 |
| `AZURE_SUBSCRIPTION_ID` | 위에서 출력된 값 |
| `ACR_NAME` | `deploy.sh` 출력값 |
| `RESOURCE_GROUP` | `rg-fridge-chef` |
| `CONTAINER_APP` | `fridgechef-app` |

## 3. 운영

- **OpenRouter 키 교체:**
  ```bash
  az containerapp secret set -n fridgechef-app -g rg-fridge-chef --secrets openrouter-api-key=<새 키>
  az containerapp revision restart -n fridgechef-app -g rg-fridge-chef --revision <리비전>
  ```
- **세션 키 교체:** 아래 명령으로 바꾼 뒤 재시작한다. 교체하면 모든 사용자가 다시 로그인해야 한다.
  ```bash
  az containerapp secret set -n fridgechef-app -g rg-fridge-chef --secrets session-secret=$(openssl rand -hex 32)
  ```
- **로그 보기:**
  ```bash
  az containerapp logs show -n fridgechef-app -g rg-fridge-chef --follow
  ```
  로그는 JSON 한 줄 형식이고, API 키나 레시피 본문은 남기지 않는다.
- **설정 변경** (모델, 추론 on/off 등):
  ```bash
  az containerapp update -n fridgechef-app -g rg-fridge-chef --set-env-vars OPENROUTER_REASONING=on
  ```
- **비용:**
  - 복제본 최소 0개라 요청이 없으면 컨테이너 비용이 들지 않는다. 대신 첫 요청은 몇 초 늦어진다.
  - Cosmos DB 서버리스는 사용량만큼 과금된다.
  - ACR Basic은 고정 요금이 있다.
- **삭제:**
  ```bash
  az group delete -n rg-fridge-chef
  ```
  리소스 그룹 전체와 저장된 레시피가 모두 지워진다.

## 로컬에서 Cosmos DB로 실행해 보기

```bash
docker run -d --name cosmos-emu -p 8081:8081 mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview --protocol http
node scripts/cosmos-emulator-setup.js

# 앱 컨테이너에서 에뮬레이터 접속 (키는 에뮬레이터 공개 고정값)
docker run --rm -p 8080:8080 --env-file .env \
  -e STORAGE_DRIVER=cosmos -e COSMOS_ENDPOINT=http://host.docker.internal:8081 \
  -e COSMOS_KEY='C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==' \
  fridge-chef

# 저장소 계약 테스트를 cosmos에도 실행
COSMOS_TEST_ENDPOINT=http://localhost:8081 \
COSMOS_TEST_KEY='C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==' \
  npm test
```
