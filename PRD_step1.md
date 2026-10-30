# PRD 1단계: 냉장고 사진으로 식재료 인식

| 항목 | 내용 |
|---|---|
| 제품명 | 냉장고를 부탁해 |
| 문서 버전 | v0.1 (2026-10-30) |
| 범위 | 1단계: 사진 업로드 → 식재료 인식 (+ 애플리케이션·컨테이너 기본 골격) |
| 다음 단계 | [PRD_step2.md](PRD_step2.md) 레시피 생성 → [PRD_step3.md](PRD_step3.md) 레시피 저장 |

## 1. 개요

사용자가 냉장고 내부를 찍은 사진을 올리면, OpenRouter의 이미지 인식(Vision) 모델이 사진 속 식재료를 찾아 목록으로 돌려준다. 사용자는 이 목록을 확인하고 고친 뒤 2단계(레시피 생성)로 넘긴다.

1단계에서는 3단계까지 그대로 쓸 웹 서버, 화면, 설정, Docker 컨테이너 구조도 함께 만든다.

## 2. 목표 / 비목표

**목표**
- 냉장고 사진 1장에서 식재료 이름, 분류, 대략적인 수량을 인식한다.
- 사용자가 인식 결과를 추가·수정·삭제할 수 있다. 인식이 완벽하지 않아도 사용자가 바로잡을 수 있으면 된다.
- 하나의 Docker 이미지로 로컬과 Azure Container Apps(ACA)에서 똑같이 실행된다.

**비목표 (이번 단계에서 하지 않음)**
- 유통기한·신선도 판별, 칼로리·영양 정보
- 사진 여러 장을 합쳐서 인식하기 (향후 검토)
- 회원가입 / 로그인
- 원본 사진 저장 (인식이 끝나면 버린다)

## 3. 사용자 시나리오

1. 사용자가 웹 페이지에서 **사진 선택** 또는 **카메라 촬영**(모바일)으로 냉장고 사진을 올린다.
2. 미리보기를 확인하고 **재료 인식** 버튼을 누른다.
3. 5~15초 동안 로딩 표시를 본다.
4. 인식된 재료 목록이 칩(태그) 형태로 나타난다. 분류별로 묶이고, 확신도가 낮은 항목은 "확인 필요"로 표시된다.
5. 잘못 인식된 항목은 지우고, 빠진 재료는 직접 입력해서 추가한다.
6. **레시피 추천받기** 버튼으로 2단계로 넘어간다. 2단계를 만들기 전에는 이 버튼을 숨겨 둔다.

## 4. 기능 요구사항

| ID | 요구사항 | 우선순위 |
|---|---|---|
| F1-1 | JPEG, PNG, WebP, HEIC 이미지를 업로드할 수 있다. 원본은 최대 10MB까지 받는다. | 필수 |
| F1-2 | 서버가 이미지를 긴 변 1280px 이하의 JPEG로 줄이고 EXIF(위치 정보 등)를 지운 뒤 모델에 보낸다. | 필수 |
| F1-3 | 이미지는 **base64 data URL**로 모델에 보낸다. 이미지 주소(URL) 방식은 무료 엔드포인트가 지원하지 않는다(테스트에서 404 확인). | 필수 |
| F1-4 | 모델 응답을 정해진 JSON 형식(5장)으로 받아 검증한다. 형식이 틀리면 1회 다시 요청한다. | 필수 |
| F1-5 | 같은 재료가 여러 번 나오면 하나로 합친다(예: "계란"과 "달걀"). | 필수 |
| F1-6 | 화면에서 재료를 추가·수정·삭제할 수 있다. | 필수 |
| F1-7 | 식재료가 아닌 물건(용기, 소스병 라벨을 읽을 수 없는 것 등)은 빼거나 "확인 필요"로 표시한다. | 권장 |
| F1-8 | 냉장고 사진이 아니거나 재료가 하나도 없으면 안내 메시지를 보여준다. | 필수 |
| F1-9 | 인식 결과(재료 목록)를 브라우저 `sessionStorage`에 보관해 새로고침해도 유지한다. | 권장 |

## 5. API 명세

### `POST /api/ingredients/recognize`

- 요청: `multipart/form-data`, 필드 `image` (파일 1개)
- 응답 `200 OK`:

```json
{
  "ingredients": [
    { "name": "달걀", "category": "유제품/계란", "quantity": "6개", "confidence": 0.95 },
    { "name": "대파", "category": "채소", "quantity": "1단", "confidence": 0.8 },
    { "name": "김치", "category": "반찬/절임", "quantity": "1통", "confidence": 0.6 }
  ],
  "notes": "아래 칸은 어두워서 일부 재료를 알아보기 어렵습니다.",
  "model": "nvidia/nemotron-3.5-super-vl:free",
  "elapsedMs": 6323
}
```

- `category`는 다음 중 하나: `채소`, `과일`, `육류`, `해산물`, `유제품/계란`, `반찬/절임`, `소스/양념`, `음료`, `가공식품`, `기타`
- `confidence`: 0~1. **0.7 미만이면 화면에 "확인 필요"로 표시한다.**

| 상태 코드 | 상황 | `error.code` |
|---|---|---|
| 400 | 파일 없음, 지원하지 않는 형식 | `INVALID_IMAGE` |
| 413 | 10MB 초과 | `IMAGE_TOO_LARGE` |
| 422 | 식재료를 하나도 찾지 못함 | `NO_INGREDIENTS` |
| 429 | 재시도해도 OpenRouter 요청 한도 초과 | `RATE_LIMITED` |
| 502 | 모델 응답 오류, JSON 파싱 재시도도 실패 | `MODEL_ERROR` |
| 504 | 90초 안에 모델 응답이 없음 | `MODEL_TIMEOUT` |

오류 응답 형식(3단계까지 공통): `{ "error": { "code": "RATE_LIMITED", "message": "사용자에게 보여줄 한국어 메시지" } }`

### `GET /healthz`

- 컨테이너 상태 확인용이다. 외부 API를 호출하지 않고 `200 {"status":"ok"}`만 돌려준다.
- ACA의 liveness / readiness probe가 이 주소를 쓴다.

## 6. 프롬프트 설계

- **모델:** `VISION_MODEL`이 없으면 `AI_MODEL`을 쓴다. 기본값은 `nvidia/nemotron-3.5-super-vl:free`.
- **메시지 구성:** `user` 메시지 하나에 text 파트(지시문)와 `image_url` 파트(base64 data URL)를 담는다.
- **지시문에 넣을 내용:**
  - 너는 냉장고 사진에서 식재료를 찾는 도우미다.
  - 보이는 식재료만 적고 추측하지 않는다. 불확실하면 confidence를 낮게 준다.
  - 재료 이름은 한국어 일반 명칭으로 쓴다. 브랜드명은 쓰지 않는다(예: "서울우유" → "우유").
  - **위 5장의 JSON 형식만** 출력하고, 코드 블록이나 설명을 붙이지 않는다.
- **파싱:** 무료 모델은 `response_format`(JSON 모드)을 지원하지 않을 수 있다. 그래서 응답 텍스트에서 첫 `{`부터 마지막 `}`까지 잘라 파싱한 뒤 스키마(zod)로 검증한다.
- **처리 시간:** 이 모델은 답하기 전에 내부 추론에 토큰을 많이 쓴다. 실측(2026-10-30, 냉장고 사진): 출력 토큰 약 2,300~2,600개(대부분 추론), 17~58초. `reasoning.effort: low`는 오히려 느려져(38초, 추론 토큰 4,193개) 쓰지 않는다. 응답 제한 시간은 90초로 둔다. → 이후 추론을 기본으로 꺼서(`OPENROUTER_REASONING=off`) 2~4초로 줄었다. 자세한 내용은 PRD_step2.md 13장을 참고한다.

## 7. 기술 구성

| 영역 | 선택 | 이유 |
|---|---|---|
| 런타임 | Node.js 22 (ESM) | 기존 `config.js`와 테스트 코드를 재사용 |
| 웹 서버 | Express | 단순함, 정적 파일 제공 + API |
| 업로드 | multer (메모리 저장) | 디스크에 사진을 남기지 않음 |
| 이미지 처리 | sharp | 크기 조정, HEIC→JPEG 변환, EXIF 제거 |
| 응답 검증 | zod | 모델 JSON 검증 (2단계에서도 사용) |
| 화면 | 정적 HTML + Vanilla JS (`public/`) | 빌드 단계 없음, 컨테이너가 단순해짐 |
| AI 호출 | `fetch` → OpenRouter `/chat/completions` | `test-openrouter.js`에서 검증된 방식 |

**권장 폴더 구조**

```
src/
  server.js               # Express 앱, 라우트 등록, /healthz
  config.js               # 환경 변수 로드·검증 (기존 config.js 이동)
  lib/openrouter.js       # chat() 호출, 429 재시도, 타임아웃
  lib/image.js            # sharp 전처리 → data URL
  routes/ingredients.js   # POST /api/ingredients/recognize
  prompts/recognize.js    # 지시문
public/                   # index.html, app.js, style.css
Dockerfile
.dockerignore
```

## 8. 설정 (환경 변수)

| 변수 | 필수 | 설명 |
|---|---|---|
| `OPENROUTER_API_KEY` | 예 | OpenRouter 키 |
| `AI_MODEL` | 아니오 | 기본 모델 (기본값 `nvidia/nemotron-3.5-super-vl:free`) |
| `VISION_MODEL` | 아니오 | 이미지 인식 모델만 따로 바꿀 때 사용 |
| `PORT` | 아니오 | 서버 포트 (기본값 `8080`) |
| `OPENROUTER_TIMEOUT_MS` | 아니오 | 모델 응답 제한 시간 (기본값 `90000`) |

Gemini 키(`GEMINI_API_KEY` 등)는 이 앱에서 쓰지 않는다. 필수 항목에서 빼서, 없어도 서버가 뜨게 한다.

## 9. 컨테이너 · Git · 배포 기반

**Dockerfile 요구사항**
- 베이스 이미지는 `node:22-alpine`을 쓰고, 멀티 스테이지로 `npm ci --omit=dev`를 실행한다.
- `USER node`로 root가 아닌 사용자로 실행한다.
- `EXPOSE 8080`, `HEALTHCHECK`는 `/healthz`를 호출한다.
- **`.env`를 이미지에 넣지 않는다.** `.dockerignore`에 `.env`, `.env.*`, `node_modules`, `.git`을 넣는다.

**로컬 실행**
```
docker build -t fridge-chef .
docker run --rm -p 8080:8080 --env-file .env fridge-chef
```

**Git**
- 저장소를 초기화하고 GitHub에 올린다. `.gitignore`는 이미 있으며 `.env`를 제외한다.
- 첫 커밋 전에 `git status`로 `.env`가 목록에 없는지 확인한다.

**Azure Container Apps 준비** (실제 배포는 3단계 이후)
- 이미지는 Azure Container Registry(ACR)에 올린다.
- API 키는 ACA **secret**으로 등록하고 환경 변수에 연결한다(`secretref:`). 이미지나 Git에 키를 넣지 않는다.
- Ingress는 외부 공개, target port는 8080으로 한다.
- 무료 모델 한도와 비용을 고려해 최소 0개, 최대 2개 복제본으로 시작한다.

## 10. 비기능 요구사항

- **응답 시간:** 인식 요청 하나가 평균 30초, 최대 90초 안에 끝난다. (무료 모델 실측 기준)
- **안정성:** OpenRouter 429 오류는 5초, 10초 간격으로 최대 2회 다시 시도한다(`test-openrouter.js`와 같은 방식).
- **보안:**
  - API 키는 서버에서만 쓰고, 브라우저 응답이나 로그에 남기지 않는다.
  - 업로드한 사진은 메모리에서만 처리하고 저장하지 않는다.
- **남용 방지:** IP당 분당 10회로 인식 요청을 제한한다(express-rate-limit).
- **모바일:** 화면 폭 360px 이상에서 사용할 수 있다. `<input type="file" accept="image/*" capture="environment">`로 카메라 촬영을 지원한다.

## 11. 수용 기준

- [ ] 냉장고 샘플 사진 5장 중 4장 이상에서 눈에 잘 띄는 재료의 80% 이상을 인식한다.
- [ ] 냉장고가 아닌 사진(풍경 등)을 올리면 `NO_INGREDIENTS` 안내가 나온다.
- [ ] 11MB 파일을 올리면 413 오류와 안내 메시지가 나온다.
- [ ] 화면에서 재료를 추가·삭제·수정할 수 있다.
- [ ] `docker run --env-file .env`로 실행하면 `http://localhost:8080`에서 전체 흐름이 동작한다.
- [ ] Docker 이미지 안에 `.env`가 없다. 확인: `docker run --rm fridge-chef ls -a`
- [ ] Git 저장소에 `.env`가 커밋되지 않았다.

## 12. 미결 사항

- 냉장고 사진 여러 장(문 칸, 냉동실)을 한 번에 인식할지 결정해야 한다. 지금은 1장만 받는다.
- 무료 모델 한도가 부족하면 유료 모델로 바꿀지와 그 예산을 정해야 한다.
- 인식 정확도를 평가할 샘플 사진을 준비해야 한다.

## 13. 구현 메모 (2026-10-30, 리뷰 반영)

**업로드 크기 (F1-1을 바꿈)**
- 브라우저가 사진을 긴 변 **1280px** JPEG(품질 0.9)로 줄여서 올린다. 서버(sharp)와 같은 크기다. 전에는 1600px로 줄였고, 서버가 1280px로 한 번 더 줄였다.
- 원본 크기는 브라우저에서 **50MB**까지 받는다. 10MB 검사는 줄인 결과에 한다. 서버 한도(10MB, `413 IMAGE_TOO_LARGE`)는 그대로다.
  - 그래서 10MB가 넘는 휴대폰 원본도 올릴 수 있다. 브라우저가 줄이지 못한 파일(예: 데스크톱 Chrome의 HEIC)은 원본 그대로 가므로 10MB를 넘으면 화면에서 막는다.
- 서버는 **5천만 화소**가 넘는 이미지를 디코딩하지 않고 `413 IMAGE_TOO_LARGE`("사진 해상도가 너무 큽니다...")를 돌려준다(sharp `limitInputPixels`). 파일은 작아도 픽셀이 많은 이미지가 메모리를 많이 쓰는 것을 막는다.

**JSON 재요청**
- 모델 응답을 JSON으로 읽지 못하면, 직전 응답을 assistant 메시지로 넣고 "JSON만 다시 출력" 지시를 붙여 1회 다시 요청한다. 이때 이미지는 다시 보내지 않는다.
- 직전 응답이 비어 있으면 처음 요청(이미지 포함)을 그대로 다시 보낸다.

**요청 제한(429) 감지**
- OpenRouter는 200 헤더를 먼저 보낸 뒤에 생긴 오류를, `choices` 없이 본문의 `error`(`{ "code": 429, ... }`)로 보낸다(OpenRouter 오류 문서).
- 전에는 상태 코드(200)만 보고 재시도 없이 `502 MODEL_ERROR`로 끝냈다. 이제 본문 `error.code`를 상태로 보아, 429면 HTTP 429와 똑같이 재시도한다. 남은 시간이 없으면 `429 RATE_LIMITED`다.

**보안 헤더**
- 모든 응답에 `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, CSP(`default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'` 등)를 붙인다. 화면은 외부 리소스와 인라인 스크립트를 쓰지 않는다.
- 디코딩할 수 없는 쿠키(다른 사이트가 남긴 깨진 값 등)는 건너뛴다. 전에는 모든 요청이 500이 됐다.
- 요청 본문의 다른 4xx 오류(모르는 `Content-Encoding`, charset)는 `400 INVALID_REQUEST`다.
