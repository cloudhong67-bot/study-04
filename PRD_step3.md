# PRD 3단계: 레시피 저장

| 항목 | 내용 |
|---|---|
| 제품명 | 냉장고를 부탁해 |
| 문서 버전 | v0.1 (2026-10-30) |
| 범위 | 3단계: 생성한 레시피 저장, 목록 조회, 삭제 + Azure Container Apps 배포 |
| 선행 단계 | [PRD_step1.md](PRD_step1.md), [PRD_step2.md](PRD_step2.md) |

## 1. 개요

사용자가 2단계에서 마음에 든 레시피를 저장하고, 나중에 "내 레시피" 화면에서 다시 보거나 지울 수 있게 한다.

이 단계에서 애플리케이션을 Azure Container Apps(ACA)에 처음 배포한다. 컨테이너는 다시 시작하면 파일이 사라지므로, 운영 환경에서는 외부 저장소를 쓴다.

## 2. 목표 / 비목표

**목표**
- 레시피 저장, 목록 조회, 상세 조회, 삭제
- 저장소를 바꿔 끼울 수 있는 구조: 로컬은 JSON 파일, 운영은 Azure Cosmos DB
- ACA 배포 후에도 컨테이너 재시작이나 복제본 증가와 상관없이 데이터가 유지된다.

**비목표**
- 회원가입 / 로그인 (향후 Microsoft Entra ID 등으로 검토)
- 레시피 공유, 평점, 수정
- 원본 냉장고 사진 저장 (1단계 방침 그대로)

## 3. 사용자 구분 방식 (로그인 없는 MVP)

- 브라우저가 처음 방문할 때 `clientId`(UUID)를 만들어 `localStorage`에 보관한다.
- 모든 저장 API 요청에 `X-Client-Id` 헤더를 붙인다.
- 서버는 `clientId`가 같은 레시피만 조회·삭제할 수 있게 한다.
- **한계:** 브라우저 데이터를 지우거나 다른 기기를 쓰면 저장 목록이 보이지 않는다. 화면에 이 점을 안내한다. 이는 보안 인증이 아니라 사용자를 구분하는 장치일 뿐이다.

## 4. 사용자 시나리오

1. 레시피 상세 화면에서 **저장**을 누르면 "저장했어요" 알림이 뜨고 버튼이 **저장됨**으로 바뀐다.
2. 상단 메뉴 **내 레시피**를 누르면 저장한 레시피가 최신순 카드 목록으로 나온다.
3. 카드를 누르면 2단계와 같은 상세 화면이 열린다. 저장 당시 보유했던 재료도 함께 보여준다.
4. **삭제**를 누르고 확인 창에서 승인하면 목록에서 사라진다.

## 5. 기능 요구사항

| ID | 요구사항 | 우선순위 |
|---|---|---|
| F3-1 | 2단계 레시피 객체를 그대로 저장한다. 저장 시각과 당시 보유 재료 목록도 함께 저장한다. | 필수 |
| F3-2 | 같은 레시피(`id` 기준)를 다시 저장하면 새로 만들지 않고 기존 항목을 돌려준다(멱등). | 필수 |
| F3-3 | 목록은 최신순으로 20개씩 페이지를 나눈다(`cursor` 방식). | 필수 |
| F3-4 | 삭제하면 바로 지운다(soft delete 아님). | 필수 |
| F3-5 | `clientId` 하나에 최대 200개까지 저장한다. 넘으면 `409 LIMIT_EXCEEDED`를 돌려준다. | 권장 |
| F3-6 | 서버가 저장 전에 레시피를 zod로 다시 검증한다. 2단계 스키마를 재사용하며, 클라이언트가 보낸 값을 그대로 믿지 않는다. | 필수 |
| F3-7 | 저장소 종류는 `STORAGE_DRIVER` 환경 변수로 고른다. | 필수 |

## 6. API 명세

모든 요청에 `X-Client-Id: <uuid>` 헤더가 필요하다. 없거나 형식이 틀리면 `400 INVALID_CLIENT`를 돌려준다.

| 메서드 · 경로 | 설명 | 성공 응답 |
|---|---|---|
| `POST /api/recipes` | 저장. 본문은 `{ "recipe": {...}, "ownedIngredients": [...] }` | `201` 저장된 항목. 이미 있으면 `200` |
| `GET /api/recipes?cursor=` | 목록 조회 | `200 { "items": [요약], "nextCursor": "..." \| null }` |
| `GET /api/recipes/:id` | 상세 조회 | `200` 저장 항목 |
| `DELETE /api/recipes/:id` | 삭제 | `204` |

- 목록의 요약 항목에는 `id`, `title`, `summary`, `timeMinutes`, `difficulty`, `savedAt`만 담는다.
- 다른 `clientId`의 레시피나 없는 레시피를 요청하면 `404 NOT_FOUND`를 돌려준다. 남의 레시피가 존재하는지도 알려주지 않기 위해서다.

## 7. 데이터 모델

```json
{
  "id": "6f1c2c1e-6d0a-4c1e-9a55-3c2f8f0b1a27",
  "clientId": "b3e1...",
  "savedAt": "2026-11-02T09:15:00.000Z",
  "ownedIngredients": ["달걀", "대파", "김치", "두부", "양파"],
  "recipe": { "title": "두부 달걀 부침", "...": "2단계 레시피 객체 전체" },
  "schemaVersion": 1
}
```

나중에 레시피 형식이 바뀌어도 옛 데이터를 읽을 수 있도록 `schemaVersion`을 둔다.

## 8. 저장소 설계

**인터페이스:** `src/storage/index.js`

```js
// 모든 드라이버가 구현하는 메서드
save(clientId, entry)                    // → { entry, created: boolean }
list(clientId, { cursor, limit })        // → { items, nextCursor }
get(clientId, id)                        // → entry | null
remove(clientId, id)                     // → boolean
count(clientId)                          // → number
```

| 드라이버 | `STORAGE_DRIVER` | 용도 | 설명 |
|---|---|---|---|
| JSON 파일 | `file` (기본값) | 로컬 개발, `docker run` | `DATA_DIR/recipes.json`에 저장한다. 쓰기를 직렬화해 동시 쓰기를 막는다. 컨테이너에서는 `-v ./data:/app/data`로 보존한다. |
| Azure Cosmos DB for NoSQL | `cosmos` | ACA 운영 | 서버리스 용량 모드, 파티션 키 `/clientId`. `@azure/cosmos` SDK를 쓴다. |

**운영에서 Cosmos DB를 쓰는 이유**
- ACA 컨테이너의 로컬 디스크는 재시작하면 사라지고, 복제본끼리 공유되지 않는다.
- Azure Files에 SQLite나 JSON 파일을 올리는 방법은 SMB 파일 잠금 문제로 동시 쓰기가 불안정하다.
- 서버리스 Cosmos DB는 사용량만큼만 과금되어 작은 앱에 적합하다. 무료 계층도 쓸 수 있다.

**인증**
- ACA에 **관리 ID(Managed Identity)**를 부여하고 Cosmos DB 데이터 역할(Built-in Data Contributor)을 할당한다.
- 앱은 `@azure/identity`의 `DefaultAzureCredential`로 접속한다. 이렇게 하면 연결 문자열(키)을 보관할 필요가 없다.
- 로컬에서 `cosmos` 드라이버를 시험할 때는 `az login` 자격 증명을 쓴다.

## 9. 설정 (추가 환경 변수)

| 변수 | 필수 | 설명 |
|---|---|---|
| `STORAGE_DRIVER` | 아니오 | `file` (기본값) 또는 `cosmos` |
| `DATA_DIR` | 아니오 | `file` 드라이버의 데이터 폴더 (기본값 `/app/data`, 로컬은 `./data`) |
| `COSMOS_ENDPOINT` | cosmos일 때 | 예: `https://<계정>.documents.azure.com:443/` |
| `COSMOS_DATABASE` | 아니오 | 기본값 `fridge-chef` |
| `COSMOS_CONTAINER` | 아니오 | 기본값 `recipes` |

`data/` 폴더는 `.gitignore`와 `.dockerignore`에 추가한다.

## 10. 컨테이너 · Git · Azure Container Apps 배포

**Git**
- 기능 단위로 브랜치를 만들고 PR로 병합한다.
- GitHub Actions 워크플로를 만든다.
  - PR마다 실행: `npm ci` → `npm test` → `docker build`
  - main 브랜치에 병합되면 실행: ACR에 이미지 푸시 → ACA 새 리비전 배포
- Azure 인증은 OIDC(Workload Identity Federation)로 한다. GitHub Secrets에 Azure 비밀번호를 넣지 않는다.

**Azure 리소스** (모두 한 리소스 그룹 안에 둔다)

| 리소스 | 설정 |
|---|---|
| Azure Container Registry | Basic SKU. ACA는 관리 ID(AcrPull)로 이미지를 받는다. |
| Container Apps 환경 + Log Analytics | 로그 수집 |
| Container App | 외부 ingress, target port 8080, 0.5 vCPU / 1Gi, 복제본 0~2 |
| Azure Cosmos DB for NoSQL | 서버리스, DB `fridge-chef` / 컨테이너 `recipes` (파티션 키 `/clientId`) |

**ACA 설정**
- secret: `openrouter-api-key` → 환경 변수 `OPENROUTER_API_KEY=secretref:openrouter-api-key`
- 일반 환경 변수: `STORAGE_DRIVER=cosmos`, `COSMOS_ENDPOINT=...`, `AI_MODEL=...`
- health probe: liveness와 readiness 모두 `GET /healthz`

**배포 예시** (CLI, 최초 1회)
```
az acr build -r <acr이름> -t fridge-chef:{{.Run.ID}} .
az containerapp up -n fridge-chef -g <리소스그룹> --environment <환경> \
  --image <acr이름>.azurecr.io/fridge-chef:<태그> --target-port 8080 --ingress external
```

## 11. 비기능 요구사항

- **응답 시간:** 저장, 조회, 삭제 API는 p95 기준 500ms 이하로 응답한다.
- **보안:**
  - 레시피 문자열을 화면에 넣을 때는 `textContent`를 쓴다. `innerHTML`을 쓰지 않아 XSS를 막는다.
  - 레시피 본문 크기는 최대 32KB로 제한한다.
- **운영:**
  - 로그는 표준 출력에 JSON 한 줄로 남겨 Log Analytics에서 검색할 수 있게 한다.
  - 로그에 API 키와 레시피 전문을 남기지 않는다.
- **비용:** 무료 모델, 서버리스 Cosmos DB, 복제본 최소 0개로 사용하지 않을 때의 비용을 최소화한다.

## 12. 수용 기준

- [ ] 레시피를 저장하고, 새로고침한 뒤에도 "내 레시피"에 보인다.
- [ ] 같은 레시피를 두 번 저장해도 목록에 1개만 있다.
- [ ] 다른 `X-Client-Id`로 요청하면 남의 레시피가 조회·삭제되지 않는다(404).
- [ ] `file` 드라이버: 볼륨을 연결하면 컨테이너를 재시작해도 데이터가 남아 있다.
- [ ] `cosmos` 드라이버: ACA에서 리비전을 새로 배포해도 데이터가 남아 있다.
- [ ] 두 드라이버가 같은 저장소 인터페이스 테스트를 통과한다.
- [ ] main 브랜치에 병합하면 GitHub Actions가 ACA에 자동 배포하고, 공개 URL에서 1~3단계 전체 흐름이 동작한다.
- [ ] Git 저장소, Docker 이미지, Actions 로그 어디에도 API 키가 없다.

## 13. 미결 사항

- 로그인 도입 시점과 방식을 정해야 한다(Entra ID, 소셜 로그인 등). 도입하면 `clientId` 데이터를 계정으로 옮기는 방법도 필요하다.
- 사용자가 가진 재료를 저장하는 "내 냉장고" 기능을 둘지 정해야 한다.
- Cosmos DB 대신 Azure Table Storage(더 저렴하고 단순함)를 쓸지 정해야 한다. 저장소 인터페이스가 있어서 나중에 드라이버만 추가하면 된다.
