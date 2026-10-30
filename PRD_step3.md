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

## 14. 구현 메모 (2026-10-30)

구현하면서 PRD에서 바꾸거나 더한 점과 검증 결과다.

**PRD와 달라진 점**

1. **목록 커서:** Cosmos의 `continuationToken` 대신 마지막 항목의 `(savedAt, id)`를 커서로 쓴다.
   - Cosmos는 `SELECT TOP n+1 ... WHERE (savedAt, id) < 커서` 쿼리로 다음 페이지를 가져온다.
   - 이유 1: 두 드라이버의 커서 형식이 같아진다.
   - 이유 2: Cosmos DB 에뮬레이터는 `ORDER BY` 쿼리에서 페이지 크기를 무시하고 전부 돌려줬다. 실제 서비스에서도 같은 코드가 동작해야 한다.
   - 이 정렬에는 복합 인덱스 `(savedAt DESC, id DESC)`가 필요하다.
2. **저장 시 보유 여부 다시 계산 (F3-6):** 클라이언트가 보낸 `owned`·`missingIngredients`를 쓰지 않는다. 저장 당시 보유 재료(`ownedIngredients`)로 서버가 다시 계산한다. 2단계와 같은 함수 `markOwnership`를 쓴다.
3. **저장 요청 제한:** 저장(POST)에 IP당 분당 30회 제한을 추가했다. 아무 `clientId`로나 저장소를 키우는 것을 막기 위해서다.
4. **관리 ID:** 시스템 할당 대신 **사용자 할당** 관리 ID를 쓴다. 시스템 할당이면 앱이 만들어지기 전에는 ACR 권한을 줄 수 없어서, 첫 이미지를 받지 못한다.
5. **Cosmos 키 인증:** `COSMOS_KEY`는 에뮬레이터에서만 쓴다. 운영 계정은 키 인증을 끈다(`disableLocalAuth: true`).
6. **목록은 요약만 읽는다:** 저장소 `list`가 요약 `{ id, title, summary, timeMinutes, difficulty, savedAt }`를 돌려준다. Cosmos는 `SELECT *` 대신 이 필드만 프로젝션한다. API 목록 응답 형식은 같다.
   - 에뮬레이터 실측(레시피 21개, 재료 10개·조리 순서 7개): 응답 46,111 B → 4,573 B, 쿼리 중간값 6.5 ms → 5.2 ms (30회). 에뮬레이터는 RU를 항상 1로 보고해 RU는 비교하지 못했다.
7. **users 컨테이너는 색인하지 않는다:** id로만 읽고(point read) 쿼리하지 않으므로 `excludedPaths: ['/*']`로 둔다(`main.bicep`, `scripts/cosmos-emulator-setup.js`). 가입 쓰기 RU가 줄어든다(추정, 에뮬레이터로는 측정 불가).
   - 이미 만든 에뮬레이터 컨테이너는 `createIfNotExists`가 설정을 바꾸지 않는다. 바꾸려면 컨테이너를 지우고 스크립트를 다시 실행한다.
8. **잘못된 id:** `GET/DELETE /api/recipes/:id`에서 id가 UUID가 아니면 저장소를 부르지 않고 바로 `404 NOT_FOUND`다.
9. **저장 개수 상한(F3-5)은 근사값이다:** "개수 확인 → 저장"이 한 동작이 아니라서, 같은 사용자가 199개일 때 저장 요청을 동시에 여러 개 보내면 200개를 조금 넘을 수 있다.
   - 넘는 양은 한 사용자가 동시에 보낸 저장 요청 수만큼이고, 저장은 IP당 분당 30회로 제한된다. 저장소를 키우는 남용을 막는 목적에는 충분하다고 보고 고치지 않았다.
   - 정확히 지키려면 Cosmos에 사용자별 개수 문서를 두고 트랜잭션 배치(같은 파티션)나 ETag 조건부 갱신으로 함께 써야 한다. 쓰기마다 RU와 코드가 늘어난다.
10. **본문 크기 32KB(11장)는 레시피 기준으로 센다:** 전에는 HTTP 본문 전체를 32KB로 잘랐다. 그런데 스키마가 허용하는 레시피는 최대 약 61KB여서, 형식이 맞는 긴 레시피(예: 25단계, 36KB)를 저장하면 "새로 고친 뒤 다시 시도" 안내와 함께 실패했다.
    - 레시피 JSON이 32KB를 넘으면 `400 INVALID_REQUEST` "레시피 내용이 너무 길어서 저장할 수 없어요."를 준다(`MAX_RECIPE_BYTES`).
    - HTTP 본문 한도는 40KB다. 레시피 32KB와 보유 재료(최대 약 5KB)를 더한 크기다. 이를 넘으면 "보낸 내용이 너무 길어서..." 안내를 준다.
    - 2단계 생성도 32KB가 넘는 레시피는 내보내지 않는다.

**화면 구현**
- 메뉴: "레시피 찾기" / "내 레시피" 탭
- 저장 후 버튼은 "저장됨 ✓"으로 바뀌고, 카드에 "저장됨" 배지가 붙는다.
- 내 레시피 상세 화면에는 "저장 시각, 그때 가진 재료"와 삭제 버튼이 나온다(삭제 전 확인 창).
- 20개를 넘으면 "더 보기"로 다음 페이지를 불러온다.
- 저장·삭제 알림은 popover로 띄운다. 그래야 열린 상세 창 위에 보인다.

**컨테이너**
- 이미지에 `/app/data` 폴더를 만든다(소유자 `node`).
- `docker run -v fridge-chef-data:/app/data`로 볼륨을 연결하면 컨테이너를 재시작해도 데이터가 남는다.

**수용 기준 확인**

| 기준 | 결과 |
|---|---|
| 저장 → 새로고침 후 유지, 같은 레시피 1개만, 다른 clientId 404 | ✅ API 테스트 10개, 브라우저 E2E |
| file 드라이버: 볼륨 연결 시 컨테이너 재시작 후 유지 | ✅ 브라우저 E2E (`docker restart`) |
| 두 드라이버가 같은 계약 테스트 통과 | ✅ file + Cosmos DB 에뮬레이터, 각 5개 |
| 브라우저 E2E 28개 | ✅ file 드라이버 컨테이너, cosmos 드라이버 컨테이너(에뮬레이터 연결) 모두 통과 |
| `cosmos` 드라이버: ACA 리비전을 새로 배포해도 유지 | ⏳ 실제 Azure 배포 전 |
| GitHub Actions 자동 배포, 공개 URL에서 전체 흐름 | ⏳ 원격 저장소·Azure 설정 전 (`DEPLOY.md`) |
| Git, 이미지, Actions 로그에 API 키 없음 | ✅ Git·이미지 확인. Actions는 키를 다루지 않는다(OIDC, 키는 ACA secret) |

**검증 범위**
- `infra/main.bicep`은 `bicep build`/`lint`로 문법·타입만 검증했다. 실제 배포는 하지 않았다.
- 이 PC에 Azure CLI가 없어서 실제 Azure에서는 아직 확인하지 못했다.

## 15. 로그인 추가 (2026-10-30)

3장의 "로그인 없는 MVP"를 아래처럼 바꿨다.

**결정 사항**
- 로그인 방식: 이메일 + 비밀번호
- 적용 범위: 앱 전체
- 기존 브라우저 ID 데이터: 계정으로 옮기지 않는다

**동작**
- 로그인하지 않으면 메인 화면(`/`)은 `/login.html`로 보낸다.
- `/api/*` 요청은 `401 UNAUTHORIZED`를 받는다. 단, `/api/auth/*`와 `/healthz`는 로그인 없이 쓸 수 있다.

**API (`/api/auth`)**

| 요청 | 결과 |
|---|---|
| `POST /signup` | 201, 가입하면 바로 로그인 |
| `POST /login` | 200 |
| `POST /logout` | 204 |
| `GET /me` | 로그인한 사용자 정보 |

| 오류 코드 | 상황 |
|---|---|
| `EMAIL_TAKEN` (409) | 이미 가입된 이메일 |
| `INVALID_CREDENTIALS` (401) | 로그인 실패. 없는 이메일과 틀린 비밀번호를 구분하지 않는다 |
| `FORBIDDEN` (403) | 다른 사이트(Origin)에서 온 요청 |

**보안**
- 비밀번호: scrypt 해시만 저장한다(N=16384, 사용자마다 다른 salt).
  - 없는 이메일로 로그인해도 같은 비용의 해시를 계산한다. 응답 시간으로 가입 여부를 알아낼 수 없게 하기 위해서다.
- 세션: 서명한 쿠키를 쓴다(`fc_session`).
  - 쿠키 속성: HttpOnly, SameSite=Lax, HTTPS일 때 Secure
  - 서명 키는 `SESSION_SECRET`(32자 이상)이고, 유지 기간은 `SESSION_TTL_DAYS`(기본 7일)다.
  - 서버에 세션을 저장하지 않으므로, ACA 복제본이 여러 개여도 동작한다.
  - 한계: 로그아웃은 쿠키를 지우는 방식이라, 만료 전에 탈취된 쿠키를 서버에서 끊을 수는 없다.
- 요청 제한: 가입은 IP당 분당 5회, 로그인은 분당 10회다.

**저장소**
- `users`를 추가했다. 사용자 문서의 id는 소문자로 바꾼 이메일이다.
  - Cosmos는 파티션 키 `/id`로 두어, 이메일로 바로 읽는다(point read).
- 레시피의 `clientId` 자리에 사용자 ID를 넣는다. 그래서 Cosmos 파티션 키(`/clientId`)를 바꾸지 않았다.
- `X-Client-Id` 헤더와 `INVALID_CLIENT` 오류는 없앴다.

**검증**

| 항목 | 결과 |
|---|---|
| 단위·API 테스트 | 65개 통과 (로그인 테스트 14개 추가) |
| 저장소 계약 테스트 (사용자 포함) | file, Cosmos 에뮬레이터 모두 통과 |
| 로그인 브라우저 E2E | 21개 통과 |
| 저장 브라우저 E2E | 30개 통과. 컨테이너 재시작 후에도 로그인 유지, 다른 기기에서 같은 계정의 레시피 보기 포함 |
