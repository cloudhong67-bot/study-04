import { config } from './config.js';
import { createApp } from './app.js';
import { createStorage } from './storage/index.js';

let storage;
try {
  storage = await createStorage(config.storage);
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'storage init failed', driver: config.storage.driver, error: err.message }));
  process.exit(1);
}

if (config.auth.ephemeral) {
  console.warn(JSON.stringify({ level: 'warn', msg: 'SESSION_SECRET not set: using a temporary key, all sessions end on restart' }));
}

const server = createApp({ storage }).listen(config.port, () => {
  console.log(JSON.stringify({
    level: 'info',
    msg: 'server started',
    port: config.port,
    visionModel: config.openrouter.visionModel,
    textModel: config.openrouter.textModel,
    reasoning: config.openrouter.reasoning,
    storage: storage.driver,
  }));
});

// 컨테이너 중지(SIGTERM) 시 처리 중인 요청을 마치고 종료
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
