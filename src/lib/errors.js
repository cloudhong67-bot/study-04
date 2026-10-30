// API 오류 공통 형식: { "error": { "code": "...", "message": "사용자에게 보여줄 한국어 메시지" } }
export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const errors = {
  invalidImage: (message = '이미지 파일(JPEG, PNG, WebP)을 올려 주세요.') => new AppError(400, 'INVALID_IMAGE', message),
  imageTooLarge: (message = '사진이 너무 커요. 10MB 이하의 사진을 골라 주세요.') => new AppError(413, 'IMAGE_TOO_LARGE', message),
  noIngredients: () =>
    new AppError(422, 'NO_INGREDIENTS', '사진에서 식재료를 찾지 못했어요. 냉장고 안이 잘 보이도록 다시 찍거나, 재료를 직접 입력해 주세요.'),
  invalidRequest: (message = '요청을 처리하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.') => new AppError(400, 'INVALID_REQUEST', message),
  noRecipes: () =>
    new AppError(422, 'NO_RECIPES', '조건에 맞는 레시피를 찾지 못했어요. 레시피 조건을 줄이거나 재료를 더 넣은 뒤 다시 시도해 주세요.'),
  unauthorized: () => new AppError(401, 'UNAUTHORIZED', '로그인이 필요해요. 다시 로그인해 주세요.'),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 맞지 않아요. 다시 확인해 주세요.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', '허용되지 않은 요청이에요. 화면을 새로 고친 뒤 다시 시도해 주세요.'),
  emailTaken: () => new AppError(409, 'EMAIL_TAKEN', '이미 가입된 이메일이에요. 로그인 탭에서 로그인해 주세요.'),
  notFound: (message = '레시피를 찾을 수 없어요. 이미 삭제됐을 수 있어요.') => new AppError(404, 'NOT_FOUND', message),
  limitExceeded: (max) => new AppError(409, 'LIMIT_EXCEEDED', `레시피는 최대 ${max}개까지 저장할 수 있어요. 안 쓰는 레시피를 지운 뒤 다시 저장해 주세요.`),
  rateLimited: () => new AppError(429, 'RATE_LIMITED', '요청이 많아 잠시 처리할 수 없어요. 1분쯤 뒤에 다시 시도해 주세요.'),
  modelError: () => new AppError(502, 'MODEL_ERROR', 'AI 응답을 처리하지 못했어요. 다시 시도해 주세요.'),
  modelTimeout: () => new AppError(504, 'MODEL_TIMEOUT', 'AI 응답이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.'),
};

export function sendError(res, err) {
  res.status(err.status).json({ error: { code: err.code, message: err.message } });
}

// zod 검증 실패 → 400 INVALID_REQUEST. zod 원문(영어)과 필드 경로는 로그에만 남기고, 사용자에게는 한국어 문장만 보낸다.
// 스키마에 직접 쓴 한국어 메시지(예: '비밀번호는 8자 이상으로 입력해 주세요.')는 사용자에게 그대로 보여 준다.
// 한글로 '시작'하는지로 가린다. zod 기본 메시지도 'Invalid option: expected one of "쉬움"|...'처럼 한글을 품을 수 있다.
export function invalidRequestFrom(zodError, where) {
  const issue = zodError.issues[0];
  console.error(JSON.stringify({ level: 'warn', msg: 'invalid request', where, path: issue?.path.join('.'), error: issue?.message }));
  return /^[가-힣]/.test(issue?.message ?? '') ? errors.invalidRequest(issue.message) : errors.invalidRequest();
}
