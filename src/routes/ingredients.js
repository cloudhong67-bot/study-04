// POST /api/ingredients/recognize: 냉장고 사진 → 식재료 목록
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { AppError, errors, sendError } from '../lib/errors.js';
import { ACCEPTED_TYPES, toDataUrl } from '../lib/image.js';
import { chatJson } from '../lib/json.js';
import { mergeIngredients, recognitionSchema } from '../lib/ingredients.js';
import { recognizeMessages } from '../prompts/recognize.js';

// 사진은 메모리에서만 처리하고 디스크에 저장하지 않는다.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ACCEPTED_TYPES.includes(file.mimetype)),
}).single('image');

export function ingredientsRouter({ chat }) {
  const router = Router();

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => sendError(res, errors.rateLimited()),
  });

  router.post('/recognize', limiter, (req, res, next) => {
    upload(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return sendError(res, errors.imageTooLarge());
      if (err) return sendError(res, errors.invalidImage());
      next();
    });
  }, async (req, res, next) => {
    try {
      if (!req.file) throw errors.invalidImage();
      const started = Date.now();
      const imageUrl = await toDataUrl(req.file.buffer);

      let result;
      try {
        result = await chatJson(chat, recognizeMessages(imageUrl), recognitionSchema, {
          model: config.openrouter.visionModel,
        });
      } catch (err) {
        throw err instanceof AppError ? err : errors.modelError();
      }

      const ingredients = mergeIngredients(result.data.ingredients);
      if (ingredients.length === 0) {
        const err = errors.noIngredients();
        if (result.data.notes) err.message += ` (${result.data.notes})`;
        throw err;
      }

      res.json({ ingredients, notes: result.data.notes, model: result.model, elapsedMs: Date.now() - started });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
