// AI 호출: OpenAI 호환 /chat/completions (Gemini 또는 OpenRouter, config.ai.provider)
// - 429는 5초, 10초 간격으로 최대 2회 재시도 (HTTP 429와, 200 본문의 error.code 429 모두)
// - timeoutMs는 재시도를 포함한 전체 제한 시간
// - reasoning: 'off'면 모델의 내부 추론을 가장 적게 한다 (AI_REASONING, 기본 off)
import { config } from '../config.js';
import { errors } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 제공자마다 추론 설정 이름이 다르다.
// OpenRouter: reasoning.enabled=false로 끈다.
// Gemini: 끌 수 없는 모델이 있어 reasoning_effort 'minimal'(가장 적게)을 보낸다. on이면 모델 기본값을 쓴다.
export function requestBody(messages, { model, provider = config.ai.provider, reasoning = config.ai.reasoning }) {
  const body = { model, messages };
  if (reasoning === 'off') {
    if (provider === 'openrouter') body.reasoning = { enabled: false };
    if (provider === 'gemini') body.reasoning_effort = 'minimal';
  }
  return body;
}

// 오류 본문: OpenRouter는 { error }, Gemini OpenAI 호환 경로는 [{ error }]로 줄 때가 있다
const errorOf = (data) => (Array.isArray(data) ? data[0]?.error : data?.error);

export async function chat(messages, { model, timeoutMs = config.ai.timeoutMs, retries = 2, reasoning = config.ai.reasoning } = {}) {
  const { apiKey, baseUrl, provider } = config.ai;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw errors.modelTimeout();

    const started = Date.now();
    const signal = AbortSignal.timeout(remaining);
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody(messages, { model, provider, reasoning })),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw errors.modelTimeout();
      console.error(JSON.stringify({ level: 'error', msg: 'ai fetch failed', provider, error: err.message }));
      throw errors.modelError();
    }

    // OpenRouter는 200 헤더를 먼저 보내고 모델이 끝날 때 본문을 보낸다.
    // 그래서 제한 시간은 대부분 본문을 읽는 중에 걸린다.
    let data;
    try {
      data = await res.json();
    } catch (err) {
      if (signal.aborted) {
        console.error(JSON.stringify({ level: 'warn', msg: 'ai timeout', provider, model, ms: Date.now() - started }));
        throw errors.modelTimeout();
      }
      data = {};
    }
    console.log(JSON.stringify({
      level: 'info',
      msg: 'ai call',
      provider,
      model,
      attempt,
      status: res.status,
      ms: Date.now() - started,
      tokens: data.usage?.completion_tokens,
    }));
    if (res.ok && data.choices?.length) {
      return { text: data.choices[0].message?.content ?? '', model: data.model ?? model };
    }

    // 200 헤더를 보낸 뒤 생긴 오류(요청 제한 포함)는 상태 코드가 아니라 본문의 error.code로 온다 (choices 없음)
    const error = errorOf(data);
    const status = res.ok ? Number(error?.code) || 502 : res.status;
    const wait = 5000 * (attempt + 1);
    if (status === 429 && attempt < retries && Date.now() + wait < deadline) {
      console.log(JSON.stringify({ level: 'warn', msg: 'ai 429, retrying', provider, waitMs: wait }));
      await sleep(wait);
      continue;
    }
    console.error(JSON.stringify({
      level: 'error',
      msg: 'ai error response',
      provider,
      status,
      httpStatus: res.status,
      error: error?.metadata?.raw ?? error?.message,
    }));
    throw status === 429 ? errors.rateLimited() : errors.modelError();
  }
}
