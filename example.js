// OpenRouter와 Google Gemini를 각각 한 번씩 호출하는 예제
// 실행: npm run example  (또는 node example.js "질문 내용")
import { config } from './src/config.js';

const prompt = process.argv[2] || '안녕하세요! 한 문장으로 자기소개 해주세요.';

async function askOpenRouter(text) {
  const { apiKey, baseUrl, model } = config.openrouter;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: text }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

async function askGemini(text) {
  const { apiKey, baseUrl, model } = config.gemini;
  // 키를 URL 쿼리(?key=) 대신 헤더로 보내 로그/기록에 남지 않게 한다.
  const res = await fetch(`${baseUrl}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
  return data.candidates[0].content.parts.map((p) => p.text).join('');
}

console.log(`질문: ${prompt}\n`);

for (const [name, ask] of [['OpenRouter', askOpenRouter], ['Gemini', askGemini]]) {
  try {
    console.log(`[${name}] ${await ask(prompt)}\n`);
  } catch (err) {
    console.error(`[${name}] 오류: ${err.message}\n`);
  }
}
