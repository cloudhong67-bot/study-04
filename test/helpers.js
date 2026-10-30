// 테스트용 앱: 임시 폴더 file 저장소 + 고정 세션 키 + 가짜 chat. 로그인 쿠키를 쉽게 얻는 signup()을 준다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.GEMINI_API_KEY ??= 'test-key'; // CI처럼 .env가 없는 환경용
process.env.OPENROUTER_API_KEY ??= 'test-key';
const { createApp } = await import('../src/app.js');
const { createStorage } = await import('../src/storage/index.js');

export const TEST_AUTH = { secret: 'test-session-secret-0123456789abcdef0123456789', sessionTtlSeconds: 3600 };
export const PASSWORD = 'password123';

export async function startApp({ chat = async () => ({ text: '{}', model: 'm' }), rateLimit = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fridge-chef-test-'));
  const storage = await createStorage({ driver: 'file', dataDir });
  const server = createApp({ chat, rateLimit, storage, auth: TEST_AUTH }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 새 사용자로 가입하고 "fc_session=..." 쿠키를 돌려준다
  async function signup(email = `${randomUUID()}@test.dev`, password = PASSWORD) {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  }

  return { baseUrl, storage, signup, close };
}

export function cookieFrom(res) {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('fc_session='));
  return header?.split(';')[0];
}
