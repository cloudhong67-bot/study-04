// 로그인 테스트: 가입, 로그인, 로그아웃, 세션 쿠키, 페이지 이동, 비밀번호 해시
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, cookieFrom, PASSWORD, TEST_AUTH } from './helpers.js';

const { hashPassword, verifyPassword, createSessionToken, readSessionToken, parseCookies } = await import('../src/lib/auth.js');

describe('비밀번호와 세션 토큰', () => {
  test('비밀번호는 scrypt 해시로 저장하고, 맞는 비밀번호만 통과한다', async () => {
    const hash = await hashPassword('secret-pass');
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!hash.includes('secret-pass'));
    assert.notEqual(hash, await hashPassword('secret-pass'), '소금(salt)이 달라 해시가 매번 다르다');
    assert.equal(await verifyPassword('secret-pass', hash), true);
    assert.equal(await verifyPassword('secret-pasS', hash), false);
  });

  test('세션 토큰: 서명이 맞고 만료 전이어야 한다', () => {
    const user = { userId: 'u1', email: 'a@test.dev' };
    const now = Date.parse('2026-10-30T00:00:00Z');
    const token = createSessionToken(user, { secret: TEST_AUTH.secret, ttlSeconds: 60, now });
    assert.deepEqual(readSessionToken(token, { secret: TEST_AUTH.secret, now }), { id: 'u1', email: 'a@test.dev' });
    assert.equal(readSessionToken(token, { secret: TEST_AUTH.secret, now: now + 61_000 }), null, '만료');
    assert.equal(readSessionToken(token, { secret: 'other-secret-0123456789abcdef0123456789', now }), null, '다른 키');
    assert.equal(readSessionToken('a.b', { secret: TEST_AUTH.secret, now }), null);
    assert.equal(readSessionToken(undefined, { secret: TEST_AUTH.secret, now }), null);
  });
});

test('parseCookies: 디코딩할 수 없는 쿠키는 건너뛴다', () => {
  assert.deepEqual(parseCookies('a=1; bad=%E0%A4%A; b=%ED%95%9C; c=%'), { a: '1', b: '한' });
  assert.deepEqual(parseCookies(), {});
});

describe('로그인 API와 페이지', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  const post = (path, body, headers = {}) => fetch(`${app.baseUrl}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const me = (cookie) => fetch(`${app.baseUrl}/api/auth/me`, { headers: cookie ? { Cookie: cookie } : {} });

  test('가입 → 201, 세션 쿠키(HttpOnly, SameSite=Lax), 바로 로그인 상태', async () => {
    const res = await post('signup', { email: '  New.User@Test.dev ', password: PASSWORD });
    assert.equal(res.status, 201);
    const { user } = await res.json();
    assert.equal(user.email, 'new.user@test.dev', '이메일은 소문자·공백 제거');
    const setCookie = res.headers.getSetCookie()[0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=3600/);
    assert.doesNotMatch(setCookie, /Secure/, '로컬 http에서는 Secure를 붙이지 않는다');
    const meRes = await me(cookieFrom(res));
    assert.equal(meRes.status, 200);
    assert.deepEqual((await meRes.json()).user, user);
  });

  test('비밀번호는 저장소에 해시로만 남는다', async () => {
    await post('signup', { email: 'hash@test.dev', password: PASSWORD });
    const stored = await app.storage.users.findByEmail('hash@test.dev');
    assert.ok(stored.passwordHash.startsWith('scrypt$'));
    assert.ok(!JSON.stringify(stored).includes(PASSWORD));
  });

  test('같은 이메일로 다시 가입하면 409 EMAIL_TAKEN (대소문자 무시)', async () => {
    await post('signup', { email: 'dup@test.dev', password: PASSWORD });
    const res = await post('signup', { email: 'DUP@test.dev', password: 'another-pass' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'EMAIL_TAKEN');
  });

  test('가입 입력 검증: 이메일 형식, 비밀번호 8자 이상', async () => {
    for (const body of [{}, { email: 'not-an-email', password: PASSWORD }, { email: 'a/b@test.dev', password: PASSWORD }, { email: 'short@test.dev', password: '1234567' }]) {
      const res = await post('signup', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.code, 'INVALID_REQUEST');
    }
  });

  test('로그인: 맞으면 200 + 쿠키, 틀리면 같은 401 메시지 (없는 이메일과 틀린 비밀번호 구분 안 함)', async () => {
    await post('signup', { email: 'login@test.dev', password: PASSWORD });
    const ok = await post('login', { email: 'LOGIN@test.dev', password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal((await (await me(cookieFrom(ok))).json()).user.email, 'login@test.dev');

    const wrongPassword = await post('login', { email: 'login@test.dev', password: 'wrong-password' });
    const noUser = await post('login', { email: 'nobody@test.dev', password: PASSWORD });
    const badFormat = await post('login', { email: 'x', password: '' });
    for (const res of [wrongPassword, noUser, badFormat]) {
      assert.equal(res.status, 401);
      const { error } = await res.json();
      assert.equal(error.code, 'INVALID_CREDENTIALS');
      assert.equal(error.message, '이메일 또는 비밀번호가 맞지 않아요. 다시 확인해 주세요.');
      assert.equal(res.headers.getSetCookie().length, 0);
    }
  });

  test('가입 입력 검증 메시지: 스키마의 한국어 문장은 그대로, zod 영어 원문은 한국어 고정 문장으로', async () => {
    const cases = [
      [{ email: 'a@test.dev' }, '요청을 처리하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.'],
      [{ email: 123, password: PASSWORD }, '요청을 처리하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요.'],
      [{ email: 'a@test.dev', password: 'short' }, '비밀번호는 8자 이상으로 입력해 주세요.'],
      [{ email: 'not-an-email', password: PASSWORD }, '이메일 형식이 올바르지 않아요. 예: name@example.com'],
    ];
    for (const [body, message] of cases) {
      const res = await post('signup', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual((await res.json()).error, { code: 'INVALID_REQUEST', message });
    }
  });

  test('깨진 쿠키가 섞여 있어도 500이 아니라 그 쿠키만 건너뛴다', async () => {
    const res = await post('signup', { email: 'cookie@test.dev', password: PASSWORD });
    const session = cookieFrom(res);
    const meRes = await me(`bad=%E0%A4%A; ${session}; other=%`);
    assert.equal(meRes.status, 200, '정상 세션 쿠키는 그대로 읽는다');
    assert.equal((await me('bad=%')).status, 401);
    const page = await fetch(`${app.baseUrl}/login.html`, { headers: { Cookie: 'bad=%' } });
    assert.equal(page.status, 200, '정적 파일도 500이 아니다');
  });

  test('로그아웃: 쿠키를 지운다 (Max-Age=0)', async () => {
    const res = await post('logout', {});
    assert.equal(res.status, 204);
    assert.match(res.headers.getSetCookie()[0], /^fc_session=;.*Max-Age=0/);
  });

  test('로그인 없이 /api/auth/me는 401', async () => {
    assert.equal((await me()).status, 401);
  });

  test('페이지: 로그인 전 / → /login.html, 로그인 후 /login.html → /', async () => {
    const cookie = await app.signup();
    const get = (path, c) => fetch(`${app.baseUrl}${path}`, { redirect: 'manual', headers: c ? { Cookie: c } : {} });

    for (const path of ['/', '/index.html']) {
      const res = await get(path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('location'), '/login.html');
    }
    assert.equal((await get('/login.html')).status, 200);
    assert.equal((await get('/style.css')).status, 200, '정적 파일은 로그인 없이');
    assert.equal((await get('/healthz')).status, 200, '/healthz는 로그인 없이 (ACA 상태 확인)');

    assert.equal((await get('/', cookie)).status, 200);
    const back = await get('/login.html', cookie);
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/');
  });

  test('다른 사이트(Origin)에서 보낸 요청은 403', async () => {
    const res = await post('login', { email: 'login@test.dev', password: PASSWORD }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'FORBIDDEN');
    const same = await post('login', { email: 'login@test.dev', password: PASSWORD }, { Origin: app.baseUrl });
    assert.equal(same.status, 200);
  });
});

test('요청 제한: 로그인은 IP당 분당 10회', async () => {
  const app = await startApp({ rateLimit: true });
  try {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${app.baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@test.dev', password: 'wrong-pass' }),
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  } finally {
    await app.close();
  }
});
