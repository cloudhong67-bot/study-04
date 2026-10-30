import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/lib/json.js';
import { mergeIngredients, recognitionSchema } from '../src/lib/ingredients.js';

test('extractJson: 코드 블록과 앞뒤 설명이 붙어도 JSON을 꺼낸다', () => {
  const text = '결과입니다.\n```json\n{"ingredients":[],"notes":"없음"}\n```\n끝';
  assert.deepEqual(extractJson(text), { ingredients: [], notes: '없음' });
});

test('extractJson: JSON이 없으면 오류', () => {
  assert.throws(() => extractJson('재료를 찾지 못했습니다.'), SyntaxError);
});

test('recognitionSchema: 잘못된 항목은 버리고, 고칠 수 있는 값은 기본값으로 바꾼다', () => {
  const parsed = recognitionSchema.parse({
    ingredients: [
      { name: '대파', category: '채소', quantity: '1단', confidence: 0.8 },
      { name: '사과', category: '없는분류', confidence: '0.9' },
      { name: '', category: '채소' },
      '문자열',
    ],
  });
  assert.deepEqual(parsed.ingredients, [
    { name: '대파', category: '채소', quantity: '1단', confidence: 0.8 },
    { name: '사과', category: '기타', quantity: '', confidence: 0.9 },
  ]);
  assert.equal(parsed.notes, '');
});

test('mergeIngredients: 동의어와 중복을 합치고 높은 확신도를 남긴다', () => {
  const merged = mergeIngredients([
    { name: '계란', category: '유제품/계란', quantity: '', confidence: 0.6 },
    { name: '달걀', category: '유제품/계란', quantity: '6개', confidence: 0.9 },
    { name: ' 대파 ', category: '채소', quantity: '1단', confidence: 0.8 },
  ]);
  assert.deepEqual(merged, [
    { name: '달걀', category: '유제품/계란', quantity: '6개', confidence: 0.9 },
    { name: '대파', category: '채소', quantity: '1단', confidence: 0.8 },
  ]);
});
