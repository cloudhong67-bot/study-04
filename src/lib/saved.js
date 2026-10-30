// 3단계 레시피 저장: 요청 스키마, 저장 항목 만들기, 목록 요약
import { z } from 'zod';
import { DIFFICULTIES, MAX_RECIPE_BYTES, markOwnership, recipeBytes } from './recipes.js';

export const SCHEMA_VERSION = 1;
export const MAX_SAVED_PER_CLIENT = 200;
export const PAGE_SIZE = 20;

const text = (max) => z.string().trim().max(max);
const required = (max) => text(max).min(1);

// 2단계 API 응답 레시피 형식. 저장할 때는 값을 고치지 않고 엄격하게 검사한다.
export const savedRecipeSchema = z.object({
  id: z.uuid(),
  title: required(50),
  summary: text(200),
  cuisine: text(10),
  servings: z.number().int().min(1).max(20),
  timeMinutes: z.number().int().min(1).max(600),
  difficulty: z.enum(DIFFICULTIES),
  ingredients: z.array(z.object({
    name: required(40),
    amount: text(30),
  })).min(1).max(40),
  steps: z.array(required(500)).min(1).max(30),
  tips: text(500),
}).refine((recipe) => recipeBytes(recipe) <= MAX_RECIPE_BYTES, '레시피 내용이 너무 길어서 저장할 수 없어요.');

export const saveRequestSchema = z.object({
  recipe: savedRecipeSchema,
  ownedIngredients: z.array(required(30)).max(50),
});

// 저장 항목. owned·basic·missingIngredients는 저장 당시 보유 재료로 서버가 다시 계산한다.
export function toEntry(clientId, { recipe, ownedIngredients }, now = new Date()) {
  return {
    id: recipe.id,
    clientId,
    savedAt: now.toISOString(),
    ownedIngredients,
    recipe: { ...recipe, ...markOwnership(recipe.ingredients, ownedIngredients) },
    schemaVersion: SCHEMA_VERSION,
  };
}

// 응답에는 clientId를 내보내지 않는다
export function toDetail({ clientId, ...entry }) {
  return entry;
}
