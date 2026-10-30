// .env(또는 컨테이너 환경 변수)에서 설정을 읽어 검증한 뒤 내보내는 모듈
// process.env는 이 파일에서만 읽는다. 키 값은 절대 출력하지 않고, 필요할 때는 mask()로 가려서 보여준다.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

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

const model = env('AI_MODEL') ?? DEFAULT_MODEL;

export const config = Object.freeze({
  port: positiveInt('PORT', 8080),
  openrouter: Object.freeze({
    apiKey: required('OPENROUTER_API_KEY'),
    baseUrl: 'https://openrouter.ai/api/v1',
    model,
    visionModel: env('VISION_MODEL') ?? model,
    textModel: env('TEXT_MODEL') ?? model,
    timeoutMs: positiveInt('OPENROUTER_TIMEOUT_MS', 90000),
    recipeTimeoutMs: positiveInt('RECIPE_TIMEOUT_MS', 120000),
    // 모델의 내부 추론. 무료 nemotron은 추론을 켜면 응답이 7~15배 느려져(레시피 68초 vs 7초) 기본으로 끈다.
    reasoning: oneOf('OPENROUTER_REASONING', ['off', 'on'], 'off'),
  }),
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
  // Gemini는 앱에서 쓰지 않는다 (example.js 전용). 없어도 서버는 뜬다.
  gemini: Object.freeze({
    apiKey: env('GEMINI_API_KEY') ?? env('GOOGLE_GENERATIVE_AI_API_KEY'),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: env('GEMINI_MODEL') ?? 'gemini-3.8-flash',
  }),
});

// `npm run check`로 직접 실행하면 설정 상태를 (키는 가린 채) 보여준다.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('설정 확인 완료');
  console.log(`OpenRouter 키: ${mask(config.openrouter.apiKey)} / 이미지 모델: ${config.openrouter.visionModel} / 텍스트 모델: ${config.openrouter.textModel}`);
  console.log(`Gemini 키:     ${mask(config.gemini.apiKey)} / 모델: ${config.gemini.model}`);
}
