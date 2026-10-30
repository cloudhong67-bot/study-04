// IP당 분당 요청 제한. 테스트에서는 enabled: false로 끈다.
import rateLimit from 'express-rate-limit';
import { errors, sendError } from './errors.js';

export function limitPerMinute(limit, { enabled = true } = {}) {
  if (!enabled) return (req, res, next) => next();
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => sendError(res, errors.rateLimited()),
  });
}
