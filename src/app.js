// Express 앱 구성. 테스트에서 chat·storage를 바꿔 끼우고 요청 제한을 끌 수 있도록 서버 실행(server.js)과 분리한다.
// 로그인: /healthz, /api/auth/*, 로그인 페이지와 정적 파일만 로그인 없이 열린다.
//         나머지 /api는 401, 메인 화면(/)은 로그인 페이지로 보낸다.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { chat as openrouterChat } from './lib/openrouter.js';
import { config } from './config.js';
import { authenticate, requireUser, sameOrigin } from './lib/auth.js';
import { AppError, errors, sendError } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { ingredientsRouter } from './routes/ingredients.js';
import { recipesRouter } from './routes/recipes.js';
import { savedRouter } from './routes/saved.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

// 화면(public/)은 같은 출처의 파일만 쓴다(외부 CDN·인라인 스크립트 없음).
// img-src: 미리보기는 blob: URL, 파비콘은 data: URL. frame-ancestors: 다른 사이트가 iframe에 넣어 클릭을 가로채지 못하게 한다.
const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}

export function createApp({ chat = openrouterChat, rateLimit = true, storage, auth = config.auth } = {}) {
  if (!storage) throw new Error('createApp: storage가 필요합니다 (사용자·레시피 저장)');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // ACA ingress 뒤에서 실제 클라이언트 IP로 요청 제한
  app.use(securityHeaders);

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.use(authenticate(auth));
  app.use('/api', sameOrigin);
  app.use('/api/auth', express.json({ limit: '8kb' }), authRouter({ storage, auth, rateLimit }));
  app.use('/api', requireUser);
  app.use('/api/ingredients', ingredientsRouter({ chat, rateLimit }));
  // 저장 본문 = 레시피(최대 32KB, MAX_RECIPE_BYTES) + 보유 재료(최대 50개 × 30자, 약 5KB)
  app.use('/api/recipes', express.json({ limit: '40kb' }), recipesRouter({ chat, rateLimit }));
  app.use('/api/recipes', savedRouter({ storage, rateLimit }));

  // 화면: 로그인 여부에 따라 메인 ↔ 로그인 페이지로 보낸다
  app.get(['/', '/index.html'], (req, res, next) => (req.user ? next() : res.redirect(302, '/login.html')));
  app.get('/login.html', (req, res, next) => (req.user ? res.redirect(302, '/') : next()));
  app.use(express.static(publicDir));

  app.use('/api', (req, res) => sendError(res, new AppError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없어요. 화면을 새로 고쳐 주세요.')));

  app.use((err, req, res, next) => {
    if (err instanceof AppError) return sendError(res, err);
    // express.json(): 깨진 JSON, 너무 큰 본문, 모르는 Content-Encoding·charset 등. 클라이언트 잘못(4xx)이므로 500으로 내보내지 않는다.
    // 너무 큰 본문은 새로 고쳐도 해결되지 않으므로 다른 안내를 한다
    if (err.type === 'entity.too.large') return sendError(res, errors.invalidRequest('보낸 내용이 너무 길어서 처리하지 못했어요. 내용을 줄여서 다시 시도해 주세요.'));
    if (err.type && err.status >= 400 && err.status < 500) return sendError(res, errors.invalidRequest());
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', path: req.path, error: err.message }));
    sendError(res, new AppError(500, 'INTERNAL_ERROR', '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'));
  });

  return app;
}
