// OpenRouter /chat/completions 호출
// - 429는 5초, 10초 간격으로 최대 2회 재시도
// - timeoutMs는 재시도를 포함한 전체 제한 시간
import { config } from '../config.js';
import { errors } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function chat(messages, { model, timeoutMs = config.openrouter.timeoutMs, retries = 2 } = {}) {
  const { apiKey, baseUrl } = config.openrouter;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw errors.modelTimeout();

    const started = Date.now();
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages }),
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw errors.modelTimeout();
      console.error(JSON.stringify({ level: 'error', msg: 'openrouter fetch failed', error: err.message }));
      throw errors.modelError();
    }

    const data = await res.json().catch(() => ({}));
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

    const wait = 5000 * (attempt + 1);
    if (res.status === 429 && attempt < retries && Date.now() + wait < deadline) {
      console.log(JSON.stringify({ level: 'warn', msg: 'openrouter 429, retrying', waitMs: wait }));
      await sleep(wait);
      continue;
    }
    console.error(JSON.stringify({
      level: 'error',
      msg: 'openrouter error response',
      status: res.status,
      error: data.error?.metadata?.raw ?? data.error?.message,
    }));
    throw res.status === 429 ? errors.rateLimited() : errors.modelError();
  }
}
