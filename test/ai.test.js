// lib/ai.js chat() 테스트. 전역 fetch를 가짜로 바꿔 실제 API를 부르지 않는다.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY ??= 'test-key';
process.env.OPENROUTER_API_KEY ??= 'test-key';
const { chat, requestBody } = await import('../src/lib/ai.js');

// AbortSignal.timeout 타이머는 이벤트 루프를 붙잡지 않는다. 실제로는 서버가 루프를 유지하므로 테스트에서도 유지한다.
let keepAlive;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status });

test('정상 응답이면 본문 텍스트와 모델을 돌려준다', async () => {
  globalThis.fetch = async () => jsonResponse(200, { model: 'm', choices: [{ message: { content: '안녕' } }] });
  assert.deepEqual(await chat([], { model: 'm' }), { text: '안녕', model: 'm' });
});

test('헤더(200)는 왔는데 본문이 제한 시간 안에 안 오면 MODEL_TIMEOUT', async () => {
  // OpenRouter는 헤더를 먼저 보내고 모델이 끝날 때 본문을 보낸다.
  globalThis.fetch = async (url, { signal }) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  });
  await assert.rejects(chat([], { model: 'm', timeoutMs: 50 }), { code: 'MODEL_TIMEOUT' });
});

test('연결 자체가 제한 시간을 넘기면 MODEL_TIMEOUT', async () => {
  globalThis.fetch = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(chat([], { model: 'm', timeoutMs: 50 }), { code: 'MODEL_TIMEOUT' });
});

test('429가 아닌 오류 응답은 바로 MODEL_ERROR', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse(500, { error: { message: 'boom' } });
  };
  await assert.rejects(chat([], { model: 'm' }), { code: 'MODEL_ERROR' });
  assert.equal(calls, 1);
});

test('429가 남은 시간 안에 재시도할 수 없으면 RATE_LIMITED', async () => {
  globalThis.fetch = async () => jsonResponse(429, { error: { message: 'rate limited' } });
  await assert.rejects(chat([], { model: 'm', timeoutMs: 1000 }), { code: 'RATE_LIMITED' });
});

// OpenRouter는 200 헤더를 보낸 뒤 생긴 오류를 choices 없이 본문 error로 보낸다 (요청 제한도 마찬가지)
test('200 본문의 error.code 429는 요청 제한으로 처리한다 (RATE_LIMITED)', async () => {
  globalThis.fetch = async () => jsonResponse(200, { id: 'gen-1', error: { code: 429, message: 'Rate limit exceeded' } });
  await assert.rejects(chat([], { model: 'm', timeoutMs: 1000 }), { code: 'RATE_LIMITED' });
});

test('200 본문의 error.code 429는 시간이 남으면 재시도한다', async () => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? jsonResponse(200, { error: { code: 429, message: 'Rate limit exceeded' } })
    : jsonResponse(200, { model: 'm', choices: [{ message: { content: 'ok' } }] }));
  assert.deepEqual(await chat([], { model: 'm', timeoutMs: 10_000 }), { text: 'ok', model: 'm' });
  assert.equal(calls, 2);
});

test('200 본문의 다른 error는 재시도 없이 MODEL_ERROR', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse(200, { error: { code: 502, message: 'Provider returned error' } });
  };
  await assert.rejects(chat([], { model: 'm' }), { code: 'MODEL_ERROR' });
  assert.equal(calls, 1);
});

test('추론 off: OpenRouter는 reasoning.enabled=false, Gemini는 reasoning_effort=minimal. on이면 아무것도 넣지 않는다', () => {
  const base = { model: 'm' };
  assert.deepEqual(requestBody([], { ...base, provider: 'openrouter', reasoning: 'off' }), { model: 'm', messages: [], reasoning: { enabled: false } });
  assert.deepEqual(requestBody([], { ...base, provider: 'gemini', reasoning: 'off' }), { model: 'm', messages: [], reasoning_effort: 'minimal' });
  for (const provider of ['openrouter', 'gemini']) {
    assert.deepEqual(requestBody([], { ...base, provider, reasoning: 'on' }), { model: 'm', messages: [] });
  }
});

test('chat()은 설정된 제공자의 /chat/completions로 Bearer 키와 함께 보낸다', async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
  };
  await chat([{ role: 'user', content: '안녕' }], { model: 'm' });
  assert.match(request.url, /\/chat\/completions$/);
  assert.match(request.init.headers.Authorization, /^Bearer \S+/);
  assert.deepEqual(JSON.parse(request.init.body).messages, [{ role: 'user', content: '안녕' }]);
});

// Gemini OpenAI 호환 경로는 오류 본문을 배열([{ error }])로 줄 때가 있다
test('Gemini 배열 형식 오류 본문도 읽는다: 429면 RATE_LIMITED', async () => {
  globalThis.fetch = async () => jsonResponse(429, [{ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }]);
  await assert.rejects(chat([], { model: 'm', timeoutMs: 1000 }), { code: 'RATE_LIMITED' });
});
