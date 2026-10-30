// 3단계 저장 API 테스트 (file 저장소, 임시 폴더). 모든 요청은 로그인 쿠키로 한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp } from './helpers.js';

const { MAX_SAVED_PER_CLIENT } = await import('../src/lib/saved.js');

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

// 새 사용자: { cookie, id }
async function newUser() {
  const cookie = await app.signup();
  const { user } = await (await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, id: user.id };
}

// 2단계 API가 돌려주는 형식의 레시피
const recipe = (title = '두부 달걀 부침', overrides = {}) => ({
  id: randomUUID(),
  title,
  summary: '두부와 달걀로 만드는 반찬',
  cuisine: '한식',
  servings: 2,
  timeMinutes: 15,
  difficulty: '쉬움',
  ingredients: [
    { name: '두부', amount: '1모', owned: true, basic: false },
    { name: '달걀', amount: '2개', owned: true, basic: false },
    { name: '부침가루', amount: '3큰술', owned: false, basic: false },
    { name: '소금', amount: '약간', owned: true, basic: true },
  ],
  missingIngredients: ['부침가루'],
  steps: ['두부를 썬다.', '달걀물을 입혀 굽는다.'],
  tips: '',
  ...overrides,
});

function api(user, method, path = '', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Cookie = user.cookie;
  return fetch(`${app.baseUrl}/api/recipes${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const save = (user, r, owned = ['두부', '달걀']) => api(user, 'POST', '', { recipe: r, ownedIngredients: owned });

test('저장: 201, 저장 당시 보유 재료로 owned·missingIngredients를 다시 계산한다', async () => {
  const user = await newUser();
  // 클라이언트가 보낸 owned 값이 틀려도 서버가 고친다
  const sent = recipe('두부 달걀 부침', {
    ingredients: [
      { name: '두부', amount: '1모', owned: false, basic: false },
      { name: '부침가루', amount: '3큰술', owned: true, basic: false },
      { name: '소금', amount: '약간', owned: false, basic: false },
    ],
    missingIngredients: [],
  });
  const res = await save(user, sent);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.id, sent.id);
  assert.equal(body.schemaVersion, 1);
  assert.deepEqual(body.ownedIngredients, ['두부', '달걀']);
  assert.equal('clientId' in body, false, '응답에 소유자 ID를 내보내지 않는다');
  assert.ok(!Number.isNaN(Date.parse(body.savedAt)));
  assert.deepEqual(body.recipe.ingredients.map((i) => [i.name, i.owned, i.basic]), [['두부', true, false], ['부침가루', false, false], ['소금', true, true]]);
  assert.deepEqual(body.recipe.missingIngredients, ['부침가루']);
  assert.ok(await app.storage.get(user.id, sent.id), '저장소에는 사용자 ID로 저장된다');
});

test('같은 레시피를 다시 저장하면 200으로 기존 항목을 돌려주고 목록에는 1개만', async () => {
  const user = await newUser();
  const r = recipe();
  const first = await (await save(user, r)).json();
  const again = await save(user, r);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).savedAt, first.savedAt);
  assert.equal((await (await api(user, 'GET')).json()).items.length, 1);
});

test('목록: 최신순 요약, 20개씩 커서로 넘긴다', async () => {
  const user = await newUser();
  const titles = Array.from({ length: 23 }, (_, i) => `레시피 ${String(i).padStart(2, '0')}`);
  for (const t of titles) {
    assert.equal((await save(user, recipe(t))).status, 201);
    await new Promise((r) => setTimeout(r, 2)); // savedAt이 겹치지 않게
  }
  const first = await (await api(user, 'GET')).json();
  assert.equal(first.items.length, 20);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['difficulty', 'id', 'savedAt', 'summary', 'timeMinutes', 'title']);
  assert.equal(first.items[0].title, '레시피 22');
  assert.ok(first.nextCursor);

  const second = await (await api(user, 'GET', `?cursor=${encodeURIComponent(first.nextCursor)}`)).json();
  assert.deepEqual(second.items.map((i) => i.title), ['레시피 02', '레시피 01', '레시피 00']);
  assert.equal(second.nextCursor, null);
});

test('상세 조회와 삭제 (204), 삭제 후 404', async () => {
  const user = await newUser();
  const r = recipe();
  await save(user, r);
  const detail = await api(user, 'GET', `/${r.id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).recipe.title, r.title);

  assert.equal((await api(user, 'DELETE', `/${r.id}`)).status, 204);
  assert.equal((await api(user, 'GET', `/${r.id}`)).status, 404);
  const again = await api(user, 'DELETE', `/${r.id}`);
  assert.equal(again.status, 404);
  assert.equal((await again.json()).error.code, 'NOT_FOUND');
});

test('다른 사용자의 레시피는 보거나 지울 수 없다 (404)', async () => {
  const owner = await newUser();
  const other = await newUser();
  const r = recipe();
  await save(owner, r);
  assert.equal((await api(other, 'GET', `/${r.id}`)).status, 404);
  assert.equal((await api(other, 'DELETE', `/${r.id}`)).status, 404);
  assert.deepEqual((await (await api(other, 'GET')).json()).items, []);
  assert.equal((await api(owner, 'GET', `/${r.id}`)).status, 200, '주인은 그대로 볼 수 있다');
});

test('로그인하지 않았거나 쿠키가 위조되면 401 UNAUTHORIZED', async () => {
  const user = await newUser();
  const [payload, signature] = user.cookie.replace('fc_session=', '').split('.');
  // 서명은 그대로 두고 내용(사용자 ID)만 바꾼 쿠키
  const forgedPayload = Buffer.from(JSON.stringify({ uid: randomUUID(), email: 'x@test.dev', exp: 9999999999 })).toString('base64url');
  for (const who of [null, { cookie: 'fc_session=garbage' }, { cookie: `fc_session=${forgedPayload}.${signature}` }, { cookie: `fc_session=${payload}.x${signature.slice(1)}` }]) {
    for (const [method, path] of [['GET', ''], ['POST', ''], ['GET', '/x'], ['DELETE', '/x']]) {
      const res = await api(who, method, path, method === 'POST' ? { recipe: recipe(), ownedIngredients: [] } : undefined);
      assert.equal(res.status, 401, `${who?.cookie?.slice(0, 20)} ${method} ${path}`);
      assert.equal((await res.json()).error.code, 'UNAUTHORIZED');
    }
  }
});

test('레시피 형식이 틀리면 400 INVALID_REQUEST', async () => {
  const user = await newUser();
  for (const body of [
    {},
    { recipe: recipe(), ownedIngredients: 'x' },
    { recipe: { ...recipe(), id: 'not-uuid' }, ownedIngredients: [] },
    { recipe: { ...recipe(), steps: [] }, ownedIngredients: [] },
    { recipe: { ...recipe(), difficulty: '매우 어려움' }, ownedIngredients: [] },
    { recipe: { ...recipe(), title: 'x'.repeat(51) }, ownedIngredients: [] },
  ]) {
    const res = await api(user, 'POST', '', body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await res.json()).error.code, 'INVALID_REQUEST');
  }
});

// 한글은 UTF-8로 3바이트
const longSteps = (count, chars) => Array.from({ length: count }, () => '가'.repeat(chars));

test('본문이 40KB를 넘으면 400, 새로 고침이 아니라 내용을 줄이라고 안내한다', async () => {
  const res = await save(await newUser(), recipe('큰 레시피', { tips: 'x'.repeat(50_000) }));
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).error, {
    code: 'INVALID_REQUEST', message: '보낸 내용이 너무 길어서 처리하지 못했어요. 내용을 줄여서 다시 시도해 주세요.',
  });
});

test('형식은 맞지만 32KB를 넘는 레시피는 400과 이유를 알려 준다', async () => {
  const big = recipe('긴 레시피', { steps: longSteps(25, 450) }); // 약 33KB
  const res = await save(await newUser(), big);
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).error, { code: 'INVALID_REQUEST', message: '레시피 내용이 너무 길어서 저장할 수 없어요.' });
});

test('32KB보다 작은 긴 레시피는 저장된다 (본문 한도 32KB에 걸리지 않는다)', async () => {
  const long = recipe('조금 긴 레시피', { steps: longSteps(20, 450) }); // 약 27KB
  assert.ok(Buffer.byteLength(JSON.stringify(long)) > 26_000);
  assert.equal((await save(await newUser(), long)).status, 201);
});

test(`사용자당 ${MAX_SAVED_PER_CLIENT}개를 넘으면 409 LIMIT_EXCEEDED (이미 저장한 레시피는 200)`, async () => {
  const user = await newUser();
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  let kept;
  for (let i = 0; i < MAX_SAVED_PER_CLIENT; i++) {
    const r = recipe(`r${i}`);
    kept ??= r;
    await app.storage.save(user.id, { id: r.id, clientId: user.id, savedAt: new Date(base + i).toISOString(), ownedIngredients: [], recipe: r, schemaVersion: 1 });
  }
  const res = await save(user, recipe('하나 더'));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'LIMIT_EXCEEDED');
  assert.equal((await save(user, kept)).status, 200, '이미 저장된 것은 다시 저장해도 된다');
});

test('레시피 생성 API(/api/recipes/generate)는 저장 API와 섞이지 않는다', async () => {
  const user = await newUser();
  const res = await fetch(`${app.baseUrl}/api/recipes/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: user.cookie }, body: '{}',
  });
  assert.equal((await res.json()).error.code, 'INVALID_REQUEST', '생성 API의 입력 검증');
});

test('id가 UUID가 아니면 저장소를 부르지 않고 바로 404 NOT_FOUND', async () => {
  const user = await newUser();
  const calls = [];
  const { get, remove } = app.storage;
  app.storage.get = (...args) => (calls.push('get'), get(...args));
  app.storage.remove = (...args) => (calls.push('remove'), remove(...args));
  try {
    for (const [method, path] of [['GET', '/not-a-uuid'], ['DELETE', '/not-a-uuid'], ['GET', '/..%2Fusers'], ['DELETE', `/${'a'.repeat(300)}`]]) {
      const res = await api(user, method, path);
      assert.equal(res.status, 404, `${method} ${path.slice(0, 20)}`);
      assert.equal((await res.json()).error.code, 'NOT_FOUND');
    }
    assert.deepEqual(calls, []);
    const r = recipe();
    await save(user, r);
    assert.equal((await api(user, 'GET', `/${r.id}`)).status, 200, 'UUID는 그대로 조회한다');
  } finally {
    Object.assign(app.storage, { get, remove });
  }
});

test('저장 400 메시지는 한국어 고정 문장 (zod 영어 원문을 붙이지 않는다)', async () => {
  const res = await api(await newUser(), 'POST', '', { recipe: { ...recipe(), id: 'not-uuid' }, ownedIngredients: [] });
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).error, { code: 'INVALID_REQUEST', message: '요청을 처리하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.' });
});

test('목록 응답 항목은 요약 필드만, 순서까지 그대로 (본문·소유자 ID 없음)', async () => {
  const user = await newUser();
  const r = recipe();
  const saved = await (await save(user, r)).json();
  const { items } = await (await api(user, 'GET')).json();
  assert.deepEqual(items, [{ id: r.id, title: r.title, summary: r.summary, timeMinutes: r.timeMinutes, difficulty: r.difficulty, savedAt: saved.savedAt }]);
  assert.deepEqual(Object.keys(items[0]), ['id', 'title', 'summary', 'timeMinutes', 'difficulty', 'savedAt']);
});
