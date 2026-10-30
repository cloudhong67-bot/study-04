// .env(또는 컨테이너 환경 변수)에서 설정을 읽어 검증한 뒤 내보내는 모듈
// process.env는 이 파일에서만 읽는다. 키 값은 절대 출력하지 않고, 필요할 때는 mask()로 가려서 보여준다.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 기본 AI는 Gemini다. 무료 OpenRouter 모델은 연결 실패·시간 초과가 잦아 바꿨다(AI_PROVIDER=openrouter로 되돌릴 수 있다).
// gemini-3.5-flash-lite: 짧은 질문 약 1초. gemini-3.8-flash는 같은 키로 40초 넘게 응답하지 않았다(2026-10-30 측정).
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

function env(name) {
  return process.env[name]?.trim() || undefined;
}

function required(name) {
  const value = env(name);
  if (!value) {
    throw new Error(`환경 변수 ${name}가 설정되지 않았습니다. .env 파일을 확인하세요. (.env.example 참고)`);
  }
  return value;
}

function oneOf(name, values, fallback) {
  const value = env(name) ?? fallback;
  if (!values.includes(value)) throw new Error(`환경 변수 ${name}는 ${values.join(' 또는 ')}여야 합니다.`);
  return value;
}

function positiveInt(name, fallback) {
  const value = Number(env(name) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`환경 변수 ${name}는 양의 정수여야 합니다.`);
  return value;
}

// 세션 쿠키 서명 키. 운영(NODE_ENV=production, Docker 이미지 기본값)에서는 반드시 설정해야 한다.
// 개발 중에 없으면 임시 키를 만든다 (서버를 다시 시작하면 모두 로그아웃된다).
function sessionSecret() {
  const value = env('SESSION_SECRET');
  if (value) {
    if (value.length < 32) throw new Error('환경 변수 SESSION_SECRET는 32자 이상이어야 합니다.');
    return { secret: value, ephemeral: false };
  }
  if (process.env.NODE_ENV === 'production') required('SESSION_SECRET');
  return { secret: randomBytes(32).toString('hex'), ephemeral: true };
}

export function mask(secret) {
  if (!secret) return '(없음)';
  return secret.length <= 8 ? '****' : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

// 제공자별 접속 정보. 두 곳 모두 OpenAI 호환 /chat/completions를 쓰므로 호출 코드(lib/ai.js)는 하나다.
const openrouter = Object.freeze({
  apiKey: env('OPENROUTER_API_KEY'),
  keyName: 'OPENROUTER_API_KEY',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: env('OPENROUTER_MODEL') ?? env('AI_MODEL') ?? DEFAULT_OPENROUTER_MODEL,
});
const gemini = Object.freeze({
  apiKey: env('GEMINI_API_KEY') ?? env('GOOGLE_GENERATIVE_AI_API_KEY'),
  keyName: 'GEMINI_API_KEY',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta', // 네이티브 API (example.js). 앱은 /openai 호환 경로를 쓴다
  model: env('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL,
});

function aiConfig() {
  const provider = oneOf('AI_PROVIDER', ['gemini', 'openrouter'], 'gemini');
  const p = provider === 'gemini' ? { ...gemini, baseUrl: `${gemini.baseUrl}/openai` } : openrouter;
  if (!p.apiKey) required(p.keyName); // 고른 제공자의 키만 필수
  return Object.freeze({
    provider,
    apiKey: p.apiKey,
    baseUrl: p.baseUrl,
    visionModel: env('VISION_MODEL') ?? p.model,
    textModel: env('TEXT_MODEL') ?? p.model,
    // 예전 이름(OPENROUTER_TIMEOUT_MS, OPENROUTER_REASONING)도 읽는다
    timeoutMs: positiveInt(env('AI_TIMEOUT_MS') ? 'AI_TIMEOUT_MS' : 'OPENROUTER_TIMEOUT_MS', 90000),
    recipeTimeoutMs: positiveInt('RECIPE_TIMEOUT_MS', 120000),
    // 모델의 내부 추론. off면 가장 적게 한다(OpenRouter: 끔, Gemini: reasoning_effort minimal).
    // 무료 nemotron은 추론을 켜면 응답이 7~15배 느려졌다(레시피 68초 vs 7초).
    reasoning: oneOf(env('AI_REASONING') ? 'AI_REASONING' : 'OPENROUTER_REASONING', ['off', 'on'], 'off'),
  });
}

export const config = Object.freeze({
  port: positiveInt('PORT', 8080),
  // 앱이 쓰는 AI (재료 인식·레시피 생성)
  ai: aiConfig(),
  // 제공자별 원래 설정 (example.js, test-openrouter.js 같은 직접 호출 스크립트용)
  openrouter,
  // 로그인 세션 (서명한 쿠키, 서버에 세션을 저장하지 않는다)
  auth: Object.freeze({
    ...sessionSecret(),
    sessionTtlSeconds: positiveInt('SESSION_TTL_DAYS', 7) * 24 * 60 * 60,
  }),
  // 레시피 저장소 (3단계). file: 로컬·docker run, cosmos: ACA 운영
  storage: Object.freeze({
    driver: oneOf('STORAGE_DRIVER', ['file', 'cosmos'], 'file'),
    dataDir: env('DATA_DIR') ?? './data',
    cosmos: Object.freeze({
      endpoint: env('COSMOS_ENDPOINT'),
      database: env('COSMOS_DATABASE') ?? 'fridge-chef',
      container: env('COSMOS_CONTAINER') ?? 'recipes',
      usersContainer: env('COSMOS_USERS_CONTAINER') ?? 'users',
      key: env('COSMOS_KEY'), // 에뮬레이터 등에서만. 운영(ACA)은 관리 ID를 쓰고 키를 두지 않는다
    }),
  }),
  gemini,
});

// `npm run check`로 직접 실행하면 설정 상태를 (키는 가린 채) 보여준다.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ai } = config;
  console.log('설정 확인 완료');
  console.log(`앱 AI: ${ai.provider} / 키: ${mask(ai.apiKey)} / 이미지 모델: ${ai.visionModel} / 텍스트 모델: ${ai.textModel} / 추론: ${ai.reasoning}`);
  console.log(`(참고) OpenRouter 키: ${mask(config.openrouter.apiKey)} / Gemini 키: ${mask(config.gemini.apiKey)}`);
}
