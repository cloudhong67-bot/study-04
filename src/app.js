// Express 앱 구성. 테스트에서 chat을 바꿔 끼울 수 있도록 서버 실행(server.js)과 분리한다.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { chat as openrouterChat } from './lib/openrouter.js';
import { AppError, sendError } from './lib/errors.js';
import { ingredientsRouter } from './routes/ingredients.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

export function createApp({ chat = openrouterChat } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // ACA ingress 뒤에서 실제 클라이언트 IP로 요청 제한

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/ingredients', ingredientsRouter({ chat }));
  app.use(express.static(publicDir));

  app.use('/api', (req, res) => sendError(res, new AppError(404, 'NOT_FOUND', '요청한 API가 없습니다.')));

  app.use((err, req, res, next) => {
    if (err instanceof AppError) return sendError(res, err);
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', path: req.path, error: err.message }));
    sendError(res, new AppError(500, 'INTERNAL_ERROR', '서버 오류가 발생했습니다.'));
  });

  return app;
}
