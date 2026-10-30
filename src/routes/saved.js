// 3단계 레시피 저장 API (/api/recipes)
//   POST   /            저장 (같은 id면 기존 항목, 200)
//   GET    /?cursor=    목록 (최신순, 20개씩)
//   GET    /:id         상세
//   DELETE /:id         삭제
// 로그인한 사용자(req.user, app.js의 requireUser)만 부를 수 있고, 자기 레시피만 보고 지울 수 있다.
// 저장소의 clientId 자리에 사용자 ID를 넣는다.
import { Router } from 'express';
import { z } from 'zod';
import { errors, invalidRequestFrom } from '../lib/errors.js';
import { limitPerMinute } from '../lib/rate-limit.js';
import {
  MAX_SAVED_PER_CLIENT, PAGE_SIZE, saveRequestSchema, toDetail, toEntry,
} from '../lib/saved.js';

export function savedRouter({ storage, rateLimit = true }) {
  const router = Router();

  router.use((req, res, next) => {
    req.clientId = req.user.id;
    next();
  });

  // 저장 id는 항상 UUID다(savedRecipeSchema). 다른 값은 저장소(Cosmos point read·delete)를 부르지 않고 바로 404
  const idSchema = z.uuid();
  router.param('id', (req, res, next, id) => next(idSchema.safeParse(id).success ? undefined : errors.notFound()));

  // 저장은 저장소를 키우므로 따로 제한한다
  router.post('/', limitPerMinute(30, { enabled: rateLimit }), async (req, res, next) => {
    try {
      const parsed = saveRequestSchema.safeParse(req.body);
      if (!parsed.success) throw invalidRequestFrom(parsed.error, 'saved.save');
      const existing = await storage.get(req.clientId, parsed.data.recipe.id);
      if (existing) return res.status(200).json(toDetail(existing));
      if ((await storage.count(req.clientId)) >= MAX_SAVED_PER_CLIENT) throw errors.limitExceeded(MAX_SAVED_PER_CLIENT);

      const { entry, created } = await storage.save(req.clientId, toEntry(req.clientId, parsed.data));
      res.status(created ? 201 : 200).json(toDetail(entry));
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length <= 4096 ? req.query.cursor : undefined;
      const { items, nextCursor } = await storage.list(req.clientId, { cursor, limit: PAGE_SIZE });
      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const entry = await storage.get(req.clientId, req.params.id);
      if (!entry) throw errors.notFound();
      res.json(toDetail(entry));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!(await storage.remove(req.clientId, req.params.id))) throw errors.notFound();
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
