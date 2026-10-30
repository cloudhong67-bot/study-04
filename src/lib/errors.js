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
  imageTooLarge: () => new AppError(413, 'IMAGE_TOO_LARGE', '이미지는 10MB 이하만 올릴 수 있습니다.'),
  noIngredients: () =>
    new AppError(422, 'NO_INGREDIENTS', '사진에서 식재료를 찾지 못했습니다. 냉장고 안이 잘 보이도록 다시 찍어 주세요.'),
  rateLimited: () => new AppError(429, 'RATE_LIMITED', '요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'),
  modelError: () => new AppError(502, 'MODEL_ERROR', 'AI 응답을 처리하지 못했습니다. 다시 시도해 주세요.'),
  modelTimeout: () => new AppError(504, 'MODEL_TIMEOUT', 'AI 응답이 너무 오래 걸립니다. 잠시 후 다시 시도해 주세요.'),
};

export function sendError(res, err) {
  res.status(err.status).json({ error: { code: err.code, message: err.message } });
}
