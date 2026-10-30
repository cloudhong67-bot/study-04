// 로그인 API (/api/auth)
//   POST /signup  { email, password } → 201 + 세션 쿠키 (가입하면 바로 로그인)
//   POST /login   { email, password } → 200 + 세션 쿠키
//   POST /logout                      → 204, 쿠키 삭제
//   GET  /me                          → 200 { user } | 401
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  createSessionToken, credentialsSchema, hashPassword, sessionCookie, verifyDummy, verifyPassword,
} from '../lib/auth.js';
import { errors, invalidRequestFrom } from '../lib/errors.js';
import { limitPerMinute } from '../lib/rate-limit.js';

export function authRouter({ storage, auth, rateLimit = true }) {
  const router = Router();

  const startSession = (req, res, user) => {
    const token = createSessionToken(user, { secret: auth.secret, ttlSeconds: auth.sessionTtlSeconds });
    res.setHeader('Set-Cookie', sessionCookie(token, { maxAge: auth.sessionTtlSeconds, secure: req.secure }));
    return { id: user.userId, email: user.email };
  };

  const parseCredentials = (body) => {
    const parsed = credentialsSchema.safeParse(body);
    if (!parsed.success) throw invalidRequestFrom(parsed.error, 'auth');
    return parsed.data;
  };

  router.post('/signup', limitPerMinute(5, { enabled: rateLimit }), async (req, res, next) => {
    try {
      const { email, password } = parseCredentials(req.body);
      const user = { id: email, userId: randomUUID(), email, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
      const { created } = await storage.users.create(user);
      if (!created) throw errors.emailTaken();
      console.log(JSON.stringify({ level: 'info', msg: 'user signed up', userId: user.userId }));
      res.status(201).json({ user: startSession(req, res, user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', limitPerMinute(10, { enabled: rateLimit }), async (req, res, next) => {
    try {
      const parsed = credentialsSchema.safeParse(req.body);
      // 형식이 틀려도 "이메일 또는 비밀번호가 틀림"과 같은 응답 (어느 쪽이 틀렸는지 알려주지 않는다)
      if (!parsed.success) throw errors.invalidCredentials();
      const { email, password } = parsed.data;
      const user = await storage.users.findByEmail(email);
      const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password);
      if (!ok) throw errors.invalidCredentials();
      res.json({ user: startSession(req, res, user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', sessionCookie('', { maxAge: 0, secure: req.secure }));
    res.status(204).end();
  });

  router.get('/me', (req, res, next) => {
    if (!req.user) return next(errors.unauthorized());
    res.json({ user: req.user });
  });

  return router;
}
