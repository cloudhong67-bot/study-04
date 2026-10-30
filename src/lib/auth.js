// 로그인: 비밀번호 해시(scrypt), 세션 쿠키(HMAC 서명), 인증 미들웨어
//
// 세션은 서버에 저장하지 않는다. 쿠키 값 = base64url(JSON{ uid, email, exp }) + '.' + HMAC-SHA256 서명
// → 복제본이 여러 개여도(ACA) 같은 SESSION_SECRET이면 어디서나 확인할 수 있다.
// 로그아웃은 쿠키를 지운다 (만료 전 탈취된 쿠키를 서버에서 끊을 수는 없다. 그래서 유지 기간을 짧게 둔다).
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { errors } from './errors.js';

const scrypt = promisify(scryptCb);
export const SESSION_COOKIE = 'fc_session';

// ---------- 입력 ----------
// '/', '\\', '?', '#'은 Cosmos 문서 id에 쓸 수 없으므로 이메일에서도 받지 않는다
export const emailSchema = z.string().trim().toLowerCase().max(254)
  .regex(/^[^\s@/\\?#]+@[^\s@/\\?#]+\.[^\s@/\\?#]+$/, '이메일 형식이 올바르지 않아요. 예: name@example.com');
export const passwordSchema = z.string()
  .min(8, '비밀번호는 8자 이상으로 입력해 주세요.')
  .max(128, '비밀번호는 128자 이하로 입력해 주세요.');
export const credentialsSchema = z.object({ email: emailSchema, password: passwordSchema });

// ---------- 비밀번호 ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

// 없는 이메일로 로그인해도 응답 시간이 비슷하도록 같은 비용의 해시를 계산한다 (가입 여부 추측 방지)
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));
export function verifyDummy(password) {
  return verifyPassword(password, DUMMY_HASH).then(() => false);
}

// ---------- 세션 토큰 ----------
function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(user, { secret, ttlSeconds, now = Date.now() }) {
  const payload = Buffer.from(JSON.stringify({ uid: user.userId, email: user.email, exp: Math.floor(now / 1000) + ttlSeconds })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function readSessionToken(token, { secret, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const { uid, email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof uid !== 'string' || typeof email !== 'string' || !(exp > now / 1000)) return null;
    return { id: uid, email };
  } catch {
    return null;
  }
}

// ---------- 쿠키 ----------
export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // 다른 사이트·확장 프로그램이 남긴 깨진 쿠키 하나 때문에 모든 요청이 500이 되지 않도록 그 쿠키만 건너뛴다
    try {
      cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return cookies;
}

// HttpOnly: 스크립트에서 읽을 수 없음, SameSite=Lax: 다른 사이트에서 보낸 POST에는 쿠키가 실리지 않음(CSRF 방지)
// Secure: HTTPS(ACA)에서만 붙인다. 로컬 http://localhost에서는 붙이면 쿠키가 저장되지 않는다.
export function sessionCookie(token, { maxAge, secure }) {
  return [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, secure && 'Secure']
    .filter(Boolean).join('; ');
}

// ---------- 미들웨어 ----------
// 모든 요청에서 쿠키를 읽어 req.user = { id, email } (없거나 잘못되면 null)
export function authenticate({ secret }) {
  return (req, res, next) => {
    req.user = readSessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE], { secret });
    next();
  };
}

// API: 로그인하지 않았으면 401
export function requireUser(req, res, next) {
  next(req.user ? undefined : errors.unauthorized());
}

// 쿠키 인증 API를 다른 사이트에서 부르지 못하게, Origin이 있으면 같은 호스트인지 확인한다 (SameSite에 더한 방어)
export function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('Origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('Host')) return next();
  } catch {}
  next(errors.forbidden());
}
