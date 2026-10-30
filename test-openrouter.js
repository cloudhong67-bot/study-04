// OpenRouter 텍스트 / 이미지 인식 테스트
// 실행: npm run test:openrouter            (기본 샘플 이미지 URL 사용)
//       node test-openrouter.js ./photo.jpg  (로컬 이미지 또는 이미지 URL 지정)
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { config, mask } from './src/config.js';

const DEFAULT_IMAGE =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/500px-Cat03.jpg';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

// 이미지를 항상 base64 data URL로 변환해 보낸다.
// (무료 Nvidia 엔드포인트는 이미지 URL을 지원하지 않아 404 "No endpoints found that support image URLs"가 난다.)
async function toImageUrl(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers: { 'User-Agent': 'study-04-openrouter-test/1.0' } });
    if (!res.ok) throw new Error(`이미지 다운로드 실패 (HTTP ${res.status}): ${source}`);
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  }
  const mime = MIME[extname(source).toLowerCase()];
  if (!mime) throw new Error(`지원하지 않는 이미지 형식입니다: ${source}`);
  return `data:${mime};base64,${(await readFile(source)).toString('base64')}`;
}

// 무료 모델은 429(요청 한도 초과)가 잦으므로 잠시 기다렸다가 재시도한다.
async function chat(content, { retries = 3 } = {}) {
  const { apiKey, baseUrl, model } = config.openrouter;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
    });
    const data = await res.json();
    if (res.ok && data.choices?.length) {
      return { text: data.choices[0].message.content, usage: data.usage, provider: data.provider, ms: Date.now() - started };
    }
    const message = data.error?.metadata?.raw ?? data.error?.message ?? JSON.stringify(data);
    if (res.status === 429 && attempt < retries) {
      const wait = 5000 * attempt;
      console.log(`  429 요청 한도 초과 - ${wait / 1000}초 후 재시도 (${attempt}/${retries - 1})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
}

// content는 메시지 내용 또는 그것을 만드는 async 함수 (이미지 준비 실패도 테스트 실패로 처리)
async function runTest(name, content) {
  console.log(`\n=== ${name} ===`);
  try {
    const { text, usage, provider, ms } = await chat(typeof content === 'function' ? await content() : content);
    console.log(`[성공] ${ms}ms, provider: ${provider ?? '-'}, tokens: ${usage?.prompt_tokens ?? '?'} in / ${usage?.completion_tokens ?? '?'} out`);
    console.log(text.trim());
    return true;
  } catch (err) {
    console.error(`[실패] ${err.message}`);
    return false;
  }
}

const imageSource = process.argv[2] || DEFAULT_IMAGE;
console.log(`OpenRouter 키: ${mask(config.openrouter.apiKey)} / 모델: ${config.openrouter.model}`);

const textOk = await runTest('텍스트 인식', '대한민국의 수도는 어디이고, 그 도시의 특징을 두 문장으로 설명해 주세요.');
const imageOk = await runTest(`이미지 인식 (${imageSource})`, async () => [
  { type: 'text', text: '이 이미지에 무엇이 있는지 한국어로 2~3문장으로 설명해 주세요.' },
  { type: 'image_url', image_url: { url: await toImageUrl(imageSource) } },
]);

console.log(`\n결과: 텍스트 ${textOk ? '성공' : '실패'} / 이미지 ${imageOk ? '성공' : '실패'}`);
process.exitCode = textOk && imageOk ? 0 : 1;
