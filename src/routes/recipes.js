// POST /api/recipes/generate: 재료 목록 + 조건 → 레시피
import { Router } from 'express';
import { limitPerMinute } from '../lib/rate-limit.js';
import { config } from '../config.js';
import { AppError, errors, invalidRequestFrom } from '../lib/errors.js';
import { chatJson } from '../lib/json.js';
import { finalizeRecipes, generateRequestSchema, generateResponseSchema } from '../lib/recipes.js';
import { mergeIngredients } from '../lib/ingredients.js';
import { recipeMessages } from '../prompts/recipes.js';

// 서버 후처리(부족한 재료 2개 초과, 식단 위반, 제외 요리)에서 몇 개 빠져도 요청 개수를 채울 수 있게 1개 더 받는다.
const EXTRA_RECIPES = 1;

export function recipesRouter({ chat, rateLimit = true }) {
  const router = Router();

  const limiter = limitPerMinute(5, { enabled: rateLimit });

  router.post('/generate', limiter, async (req, res, next) => {
    try {
      const parsed = generateRequestSchema.safeParse(req.body);
      if (!parsed.success) throw invalidRequestFrom(parsed.error, 'recipes.generate');
      const request = parsed.data;
      // 이름 정리·중복 제거 (계란/달걀 등)
      request.ingredients = mergeIngredients(request.ingredients.map((name) => ({ name, confidence: 1 }))).map((i) => i.name);

      const started = Date.now();
      let result;
      try {
        result = await chatJson(
          chat,
          recipeMessages({ ...request, count: Math.min(request.count + EXTRA_RECIPES, 6) }),
          generateResponseSchema,
          { model: config.ai.textModel, timeoutMs: config.ai.recipeTimeoutMs },
        );
      } catch (err) {
        throw err instanceof AppError ? err : errors.modelError();
      }

      const recipes = finalizeRecipes(result.data.recipes, request);
      console.log(JSON.stringify({
        level: 'info',
        msg: 'recipes generated',
        fromModel: result.data.recipes.length,
        returned: recipes.length,
      }));
      if (recipes.length === 0) throw errors.noRecipes();

      res.json({ recipes, model: result.model, elapsedMs: Date.now() - started });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
