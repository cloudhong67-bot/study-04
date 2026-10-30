import { errors } from './errors.js';

// 모델 응답 텍스트에서 JSON 객체를 꺼낸다.
// 무료 모델은 JSON 모드를 지원하지 않을 수 있어, 코드 블록이나 앞뒤 설명이 붙어도 첫 '{'부터 마지막 '}'까지 잘라 파싱한다.
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new SyntaxError('응답에 JSON 객체가 없습니다.');
  return JSON.parse(text.slice(start, end + 1));
}

export const REPAIR_PROMPT = '위 응답을 JSON으로 읽지 못했습니다. 내용은 바꾸지 말고, 처음에 안내한 형식의 JSON 객체 하나만 다시 출력하세요. 사진은 다시 보내지 않으니 위 응답의 내용을 그대로 옮기세요. 코드 블록이나 설명은 붙이지 않습니다.';

// 형식 오류로 다시 요청할 때의 메시지.
// 직전 응답을 assistant 메시지로 넣고 형식만 고치게 한다. 이미지는 뺀다: 1280px 사진이 요청 본문의 99%를 차지하고,
// 내용은 이미 직전 응답에 있다. 직전 응답이 비어 있으면 고칠 내용이 없으므로 처음 요청을 그대로 다시 보낸다.
export function repairMessages(messages, text) {
  if (!text?.trim()) return messages;
  const withoutImages = messages.map((m) =>
    Array.isArray(m.content) ? { ...m, content: m.content.filter((part) => part.type !== 'image_url') } : m);
  return [...withoutImages, { role: 'assistant', content: text }, { role: 'user', content: REPAIR_PROMPT }];
}

// chat 결과를 JSON으로 파싱하고 zod 스키마로 검증한다. 실패하면 1회 다시 요청한다.
// options.timeoutMs가 있으면 재요청을 포함한 전체 제한 시간으로 쓴다.
export async function chatJson(chatFn, messages, schema, options = {}) {
  const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
  let lastError;
  let current = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline && deadline - Date.now();
    if (deadline && remaining <= 0) throw errors.modelTimeout();
    const { text, model } = await chatFn(current, deadline ? { ...options, timeoutMs: remaining } : options);
    try {
      return { data: schema.parse(extractJson(text)), model };
    } catch (err) {
      lastError = err;
      console.error(JSON.stringify({ level: 'warn', msg: 'model JSON invalid', attempt, error: err.message.slice(0, 300) }));
      current = repairMessages(messages, text);
    }
  }
  throw lastError;
}
