// 모델 응답 텍스트에서 JSON 객체를 꺼낸다.
// 무료 모델은 JSON 모드를 지원하지 않을 수 있어, 코드 블록이나 앞뒤 설명이 붙어도 첫 '{'부터 마지막 '}'까지 잘라 파싱한다.
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new SyntaxError('응답에 JSON 객체가 없습니다.');
  return JSON.parse(text.slice(start, end + 1));
}

// chat 결과를 JSON으로 파싱하고 zod 스키마로 검증한다. 실패하면 1회 다시 요청한다.
export async function chatJson(chatFn, messages, schema, options) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, model } = await chatFn(messages, options);
    try {
      return { data: schema.parse(extractJson(text)), model };
    } catch (err) {
      lastError = err;
      console.error(JSON.stringify({ level: 'warn', msg: 'model JSON invalid', attempt, error: err.message.slice(0, 300) }));
    }
  }
  throw lastError;
}
