// API 테스트. OpenRouter는 호출하지 않고 가짜 chat 함수를 끼워 넣는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

process.env.OPENROUTER_API_KEY ??= 'test-key'; // CI처럼 .env가 없는 환경용
const { createApp } = await import('../src/app.js');
const { errors } = await import('../src/lib/errors.js');

let nextReplies = [];
const calls = [];
async function fakeChat(messages, options) {
  calls.push({ messages, options });
  const reply = nextReplies.shift();
  if (reply instanceof Error) throw reply;
  return { text: reply, model: 'fake-model' };
}

let server;
let baseUrl;
before(async () => {
  server = createApp({ chat: fakeChat }).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#88aacc' } }).png().toBuffer();

function upload(buffer, type = 'image/png') {
  const body = new FormData();
  if (buffer) body.append('image', new Blob([buffer], { type }), 'fridge.png');
  return fetch(`${baseUrl}/api/ingredients/recognize`, { method: 'POST', body });
}

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
  const res = await fetch(`${baseUrl}/api/nothing`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});
