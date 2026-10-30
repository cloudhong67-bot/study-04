// 식재료 인식 결과 스키마와 후처리(이름 정리, 중복 합치기)
import { z } from 'zod';

export const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품/계란', '반찬/절임', '소스/양념', '음료', '가공식품', '기타'];
export const LOW_CONFIDENCE = 0.7;

// 같은 재료의 다른 이름 → 대표 이름
const SYNONYMS = {
  계란: '달걀',
  쪽파: '파',
  우유팩: '우유',
  방울토마토: '토마토',
};

// 모델이 형식을 조금 어겨도 버리지 않도록, 고칠 수 있는 값은 기본값으로 바꾼다.
const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(30),
  category: z.enum(CATEGORIES).catch('기타'),
  quantity: z.string().trim().max(30).nullish().catch(null).transform((v) => v ?? ''),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
});

export const recognitionSchema = z.object({
  ingredients: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = ingredientSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  notes: z.string().nullish().catch(null).transform((v) => v ?? ''),
});

export function normalizeName(name) {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  return SYNONYMS[trimmed] ?? trimmed;
}

// 이름이 같으면 하나로 합친다. 확신도는 높은 쪽, 수량은 먼저 나온 값을 쓴다.
export function mergeIngredients(items) {
  const byName = new Map();
  for (const item of items) {
    const name = normalizeName(item.name);
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { ...item, name });
    } else {
      existing.confidence = Math.max(existing.confidence, item.confidence);
      existing.quantity ||= item.quantity;
    }
  }
  return [...byName.values()];
}
