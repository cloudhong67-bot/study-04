// API 테스트. OpenRouter는 호출하지 않고 가짜 chat 함수를 끼워 넣는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { startApp } from './helpers.js';
const { errors } = await import('../src/lib/errors.js');

let nextReplies = [];
const calls = [];
async function fakeChat(messages, options) {
  calls.push({ messages, options });
  const reply = nextReplies.shift();
  if (reply instanceof Error) throw reply;
  return { text: reply, model: 'fake-model' };
}

let app;
let baseUrl;
let cookie;
before(async () => {
  app = await startApp({ chat: fakeChat });
  baseUrl = app.baseUrl;
  cookie = await app.signup();
});
after(() => app.close());

const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#88aacc' } }).png().toBuffer();

function upload(buffer, type = 'image/png', { withCookie = true } = {}) {
  const body = new FormData();
  if (buffer) body.append('image', new Blob([buffer], { type }), 'fridge.png');
  return fetch(`${baseUrl}/api/ingredients/recognize`, { method: 'POST', body, headers: withCookie ? { Cookie: cookie } : {} });
}

test('로그인하지 않으면 401 UNAUTHORIZED', async () => {
  const res = await upload(png, 'image/png', { withCookie: false });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'UNAUTHORIZED');
});

test('GET /healthz', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('정상 인식: 이미지를 축소한 JPEG data URL로 보내고 결과를 합쳐서 돌려준다', async () => {
  calls.length = 0;
  nextReplies = ['```json\n{"ingredients":[{"name":"계란","category":"유제품/계란","quantity":"6개","confidence":0.95},{"name":"달걀","category":"유제품/계란","confidence":0.5},{"name":"김치","category":"반찬/절임","quantity":"1통","confidence":0.6}],"notes":""}\n```'];
  const res = await upload(png);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.ingredients.map((i) => i.name), ['달걀', '김치']);
  assert.equal(data.model, 'fake-model');

  const imageUrl = calls[0].messages[0].content[1].image_url.url;
  assert.match(imageUrl, /^data:image\/jpeg;base64,/);
  const meta = await sharp(Buffer.from(imageUrl.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 640);
});

test('JSON이 깨지면 1회 다시 요청한다', async () => {
  calls.length = 0;
  nextReplies = ['재료를 찾았습니다!', '{"ingredients":[{"name":"우유","category":"유제품/계란","confidence":0.9}]}'];
  const res = await upload(png);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('두 번 다 JSON이 깨지면 502 MODEL_ERROR', async () => {
  nextReplies = ['오류', '또 오류'];
  const res = await upload(png);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'MODEL_ERROR');
});

test('식재료가 없으면 422 NO_INGREDIENTS', async () => {
  nextReplies = ['{"ingredients":[],"notes":"냉장고 사진이 아닙니다."}'];
  const res = await upload(png);
  assert.equal(res.status, 422);
  const { error } = await res.json();
  assert.equal(error.code, 'NO_INGREDIENTS');
  assert.match(error.message, /냉장고 사진이 아닙니다/);
});

test('OpenRouter 429가 계속되면 429 RATE_LIMITED', async () => {
  nextReplies = [errors.rateLimited()];
  const res = await upload(png);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'RATE_LIMITED');
});

test('파일이 없으면 400 INVALID_IMAGE', async () => {
  const res = await upload(null);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_IMAGE');
});

test('이미지가 아닌 파일은 400 INVALID_IMAGE', async () => {
  const res = await upload(Buffer.from('hello'), 'text/plain');
  assert.equal(res.status, 400);
});

test('이미지 형식이지만 읽을 수 없으면 400 INVALID_IMAGE', async () => {
  const res = await upload(Buffer.from('not really a jpeg'), 'image/jpeg');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_IMAGE');
});

test('10MB를 넘으면 413 IMAGE_TOO_LARGE', async () => {
  const res = await upload(Buffer.alloc(11 * 1024 * 1024), 'image/jpeg');
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'IMAGE_TOO_LARGE');
});

test('없는 API는 404 JSON', async () => {
  const res = await fetch(`${baseUrl}/api/nothing`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('JSON 재요청: 이미지는 빼고 직전 응답 + "JSON만 다시 출력" 지시를 보낸다', async () => {
  calls.length = 0;
  const bad = '재료: 우유 1팩';
  nextReplies = [bad, '{"ingredients":[{"name":"우유","category":"유제품/계란","confidence":0.9}]}'];
  const res = await upload(png);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  const [first, retry] = calls.map((c) => c.messages);
  assert.ok(first[0].content.some((p) => p.type === 'image_url'), '처음에는 이미지를 보낸다');
  assert.ok(!JSON.stringify(retry).includes('data:image'), '재요청에는 이미지가 없다');
  assert.deepEqual(retry[0].content, first[0].content.filter((p) => p.type === 'text'), '규칙(텍스트)은 그대로');
  assert.deepEqual(retry[1], { role: 'assistant', content: bad });
  assert.equal(retry[2].role, 'user');
  assert.match(retry[2].content, /JSON/);
  assert.ok(JSON.stringify(retry).length < JSON.stringify(first).length, '재요청 본문이 더 작다');
});

test('JSON 재요청: 직전 응답이 비어 있으면 처음 요청(이미지 포함)을 그대로 다시 보낸다', async () => {
  calls.length = 0;
  nextReplies = ['  ', '{"ingredients":[{"name":"우유","category":"유제품/계란","confidence":0.9}]}'];
  assert.equal((await upload(png)).status, 200);
  assert.deepEqual(calls[1].messages, calls[0].messages);
});

test('픽셀 수가 너무 큰 이미지(5천만 화소 초과)는 디코딩하지 않고 413 IMAGE_TOO_LARGE', async () => {
  calls.length = 0;
  const huge = await sharp({ create: { width: 7100, height: 7100, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(huge.length < 10 * 1024 * 1024, '파일 크기는 10MB 이하');
  const res = await upload(huge);
  assert.equal(res.status, 413);
  const { error } = await res.json();
  assert.equal(error.code, 'IMAGE_TOO_LARGE');
  assert.match(error.message, /해상도/);
  assert.equal(calls.length, 0, '모델을 부르지 않는다');
});

test('본문 파서의 다른 4xx(모르는 Content-Encoding·charset)는 500이 아니라 400 INVALID_REQUEST', async () => {
  const { request } = await import('node:http');
  const send = (headers) => new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/api/recipes/generate`, { method: 'POST', headers: { Cookie: cookie, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end('{"ingredients":["달걀"]}');
  });
  for (const headers of [
    { 'Content-Type': 'application/json', 'Content-Encoding': 'unknown-zip' },
    { 'Content-Type': 'application/json; charset=klingon' },
  ]) {
    const { status, body } = await send(headers);
    assert.equal(status, 400, JSON.stringify(headers));
    assert.equal(body.error.code, 'INVALID_REQUEST');
  }
});

test('보안 헤더: nosniff, CSP(frame-ancestors none, img-src blob: data:)', async () => {
  for (const path of ['/login.html', '/app.js', '/healthz', '/api/nothing']) {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /img-src 'self' blob: data:/, path);
  }
});
