// 레시피 생성 요청/응답 스키마와 후처리
// 모델 응답은 그대로 믿지 않는다: 보유 여부(owned)와 부족한 재료는 서버가 보유 목록과 다시 대조해 계산한다.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeName } from './ingredients.js';

export const DIFFICULTIES = ['쉬움', '보통', '어려움'];
export const MAX_MISSING = 2;
// 레시피 하나의 최대 크기 (PRD_step3 11장). 저장 API가 이보다 큰 레시피를 받지 않으므로, 생성 결과에서도 미리 뺀다.
export const MAX_RECIPE_BYTES = 32 * 1024;
export const recipeBytes = (recipe) => Buffer.byteLength(JSON.stringify(recipe));

// 가지고 있다고 보는 기본 양념 (F2-2)
export const PANTRY = ['소금', '후추', '설탕', '식용유', '간장', '물'];
const PANTRY_ALIASES = ['후춧가루', '굵은소금', '꽃소금', '맛소금', '백설탕', '진간장', '양조간장', '국간장', '포도씨유', '카놀라유', '올리브유', '찬물', '뜨거운물', '끓는물'];
const PANTRY_SET = new Set([...PANTRY, ...PANTRY_ALIASES]);

// 식단 조건별로 들어가면 안 되는 재료 키워드 (F2-7). 모델이 조건을 어겨도 서버에서 걸러낸다.
// 알레르기에 쓰일 수 있는 안전망이므로, 헷갈리면 넣는 쪽을 택한다 ('땅콩버터'는 유제품 제외에도 걸린다).
const MEAT = ['고기', '소고기', '쇠고기', '돼지', '삼겹', '목살', '닭', '오리', '양고기', '베이컨', '햄', '소시지', '스팸', '차돌', '갈비', '불고기', '다짐육',
  '사골', '순대', '곱창', '막창', '족발', '편육', '육포', '미트', '치킨', '비프', '살라미', '페퍼로니', '초리조', '하몽'];
const SEAFOOD = ['생선', '연어', '참치', '고등어', '꽁치', '멸치', '대구', '갈치', '명태', '동태', '황태', '북어', '코다리', '쥐포', '명란', '날치', '안초비', '앤초비', '캐비아',
  '새우', '쉬림프', '오징어', '한치', '문어', '낙지', '주꾸미', '쭈꾸미', '조개', '조갯', '바지락', '꼬막', '재첩', '가리비', '관자', '홍합', '전복', '소라', '골뱅이', '우렁',
  '굴', '게', '크랩', '랍스터', '멍게', '해삼', '성게', '해물', '해산물', '어묵', '맛살', '액젓', '젓갈', '굴소스', '피시'];
export const DIETARY_RULES = {
  채식: [...MEAT, ...SEAFOOD],
  '매운 음식 제외': ['고추', '고춧가루', '고추장', '청양', '할라피뇨', '칠리', '스리라차', '마라', '불닭'],
  '유제품 제외': ['우유', '치즈', '버터', '크림', '요거트', '요구르트', '연유', '분유', '유청', '모짜렐라', '모차렐라', '리코타', '파마산', '마스카포네', '부라타', '고르곤졸라', '까망베르'],
  '견과류 제외': ['땅콩', '피넛', '아몬드', '호두', '잣', '캐슈', '피스타치오', '피칸', '헤이즐넛', '마카다미아', '너트', '넛츠', '누텔라', '프랄린', '견과'],
};
// 키워드를 글자로 포함하지만 그 재료가 아닌 말. 이 말을 지운 뒤 키워드를 찾는다. ('오리엔탈 드레싱'은 오리가 아니다)
const NOT_KEYWORD = {
  오리: ['오리엔탈', '오리지널'],
  치킨: ['치킨무'],
};
// '닭'·'게'·'굴' 같은 한 글자 키워드는 단어의 앞이나 끝에 올 때만 본다. ('닭가슴살', '통닭' O / '물게살이' 같은 우연한 포함 X)
export function containsKeyword(name, keyword) {
  const text = (NOT_KEYWORD[keyword] ?? []).reduce((acc, word) => acc.replaceAll(word, ' '), name);
  if (keyword.length >= 2) return text.includes(keyword);
  return text.split(/\s+/).some((token) => token.startsWith(keyword) || token.endsWith(keyword));
}

const trimmed = (max) => z.string().trim().min(1).max(max);

// ---------- 요청 ----------
export const generateRequestSchema = z.object({
  ingredients: z.array(trimmed(30)).min(1).max(50),
  preferences: z.object({
    servings: z.number().int().min(1).max(10).optional(),
    maxTimeMinutes: z.number().int().min(5).max(240).nullish(),
    difficulty: z.enum(DIFFICULTIES).nullish(),
    dietary: z.array(trimmed(20)).max(5).default([]),
    cuisine: trimmed(10).nullish(),
  }).default({ dietary: [] }),
  count: z.number().int().min(1).max(5).default(3),
  excludeTitles: z.array(trimmed(50)).max(20).default([]),
});

// ---------- 모델 응답 ----------
// 형식이 조금 틀린 값은 기본값으로 고치고, 고칠 수 없는 레시피는 하나씩 버린다.
const recipeSchema = z.object({
  title: trimmed(50),
  summary: z.string().trim().max(200).catch(''),
  cuisine: z.string().trim().max(10).catch(''),
  servings: z.coerce.number().int().min(1).max(20).catch(2),
  timeMinutes: z.coerce.number().int().min(1).max(600).catch(30),
  difficulty: z.enum(DIFFICULTIES).catch('보통'),
  ingredients: z.array(z.object({
    name: trimmed(40),
    // 숫자(2)는 문자열로 바꾸되, 빠졌거나 null이면 "undefined"/"null"이 아니라 빈 문자열
    amount: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? '' : String(v).trim()))
      .pipe(z.string().max(30)).catch(''),
  })).min(1).max(40),
  steps: z.array(trimmed(500)).min(1).max(30),
  tips: z.string().trim().max(500).nullish().catch(null).transform((v) => v ?? ''),
});

export const generateResponseSchema = z.object({
  recipes: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = recipeSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
});

// ---------- 대조 ----------
const compact = (name) => normalizeName(name).replace(/\s+/g, '');

// 원래 이름과 대표 이름(동의어) 둘 다로 대조한다.
// 대표 이름만 쓰면 '쪽파'가 한 글자 '파'가 되어, 레시피의 '송송 썬 쪽파'를 보유로 인정하지 못한다.
const nameForms = (name) => [...new Set([name.replace(/\s+/g, ''), compact(name)])];

// '다진 마늘'·'송송 썬 대파'처럼 꾸밈말이 붙어도 보유 재료로 인정하고('마늘' 보유),
// 반대로 레시피의 '호박'은 보유한 '애호박'으로 인정한다.
// 단, '파'처럼 한 글자는 '파프리카'·'양파'와 헷갈리지 않도록 정확히 같을 때만 인정한다.
// '대파'와 '쪽파'처럼 같은 계열이라도 다른 재료는 보유로 보지 않는다(부족한 재료로 알려 준다).
export function matchesOwned(recipeName, ownedNames) {
  const names = nameForms(recipeName);
  const tokens = new Set(recipeName.trim().split(/\s+/).flatMap(nameForms));
  return ownedNames.some((owned) => nameForms(owned).some((o) => {
    if (tokens.has(o)) return true;
    return names.some((name) => name === o || (o.length >= 2 && name.endsWith(o)) || (name.length >= 2 && o.endsWith(name)));
  }));
}

export function isPantry(recipeName) {
  const name = compact(recipeName).replace(/\(.*\)/, '');
  return PANTRY_SET.has(name) || [...PANTRY_SET].some((p) => p.length >= 2 && name.endsWith(p) && name.length <= p.length + 2);
}

export function violatesDietary(recipe, dietary) {
  return dietary.some((rule) => {
    const keywords = DIETARY_RULES[rule];
    if (!keywords) return false; // 모르는 조건은 프롬프트로만 전달한다
    return recipe.ingredients.some((item) => keywords.some((k) => containsKeyword(normalizeName(item.name), k)));
  });
}

// 레시피 재료마다 보유 여부(owned)·기본 양념(basic)을 정하고 부족한 재료 목록을 만든다.
// 2단계 생성과 3단계 저장이 같이 쓴다 (저장 시에도 클라이언트가 보낸 owned 값을 믿지 않는다).
export function markOwnership(recipeIngredients, ownedNames) {
  const items = recipeIngredients.map((item) => {
    const basic = isPantry(item.name);
    return { name: item.name, amount: item.amount, owned: basic || matchesOwned(item.name, ownedNames), basic };
  });
  return { ingredients: items, missingIngredients: items.filter((i) => !i.owned).map((i) => i.name) };
}

// 모델 레시피 → API 응답 레시피 (F2-2 ~ F2-5, F2-7, F2-8)
export function finalizeRecipes(recipes, { ingredients, preferences, count, excludeTitles }) {
  const excluded = new Set(excludeTitles.map(compact));
  const seen = new Set();

  return recipes
    .map((recipe) => ({ id: randomUUID(), ...recipe, ...markOwnership(recipe.ingredients, ingredients) }))
    .filter((recipe) => {
      const key = compact(recipe.title);
      if (excluded.has(key) || seen.has(key)) return false;
      seen.add(key);
      return recipe.missingIngredients.length <= MAX_MISSING && !violatesDietary(recipe, preferences.dietary)
        && recipeBytes(recipe) <= MAX_RECIPE_BYTES; // 보여 줘도 저장할 수 없는 레시피는 내보내지 않는다
    })
    .sort((a, b) => a.missingIngredients.length - b.missingIngredients.length)
    .slice(0, count);
}
