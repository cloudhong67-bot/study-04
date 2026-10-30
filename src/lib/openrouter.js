// OpenRouter /chat/completions 호출
// - 429는 5초, 10초 간격으로 최대 2회 재시도 (HTTP 429와, 200 본문의 error.code 429 모두)
// - timeoutMs는 재시도를 포함한 전체 제한 시간
// - reasoning: 'off'면 모델의 내부 추론을 끈다 (OPENROUTER_REASONING, 기본 off)
import { config } from '../config.js';
import { errors } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function chat(messages, { model, timeoutMs = config.openrouter.timeoutMs, retries = 2, reasoning = config.openrouter.reasoning } = {}) {
  const { apiKey, baseUrl } = config.openrouter;
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
        body: JSON.stringify({ model, messages, ...(reasoning === 'off' && { reasoning: { enabled: false } }) }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw errors.modelTimeout();
      console.error(JSON.stringify({ level: 'error', msg: 'openrouter fetch failed', error: err.message }));
      throw errors.modelError();
    }

    // OpenRouter는 200 헤더를 먼저 보내고 모델이 끝날 때 본문을 보낸다.
    // 그래서 제한 시간은 대부분 본문을 읽는 중에 걸린다.
    let data;
    try {
      data = await res.json();
    } catch (err) {
      if (signal.aborted) {
        console.error(JSON.stringify({ level: 'warn', msg: 'openrouter timeout', model, ms: Date.now() - started }));
        throw errors.modelTimeout();
      }
      data = {};
    }
    console.log(JSON.stringify({
      level: 'info',
      msg: 'openrouter call',
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
    const status = res.ok ? Number(data.error?.code) || 502 : res.status;
    const wait = 5000 * (attempt + 1);
    if (status === 429 && attempt < retries && Date.now() + wait < deadline) {
      console.log(JSON.stringify({ level: 'warn', msg: 'openrouter 429, retrying', waitMs: wait }));
      await sleep(wait);
      continue;
    }
    console.error(JSON.stringify({
      level: 'error',
      msg: 'openrouter error response',
      status,
      httpStatus: res.status,
      error: data.error?.metadata?.raw ?? data.error?.message,
    }));
    throw status === 429 ? errors.rateLimited() : errors.modelError();
  }
}
