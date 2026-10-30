import { config } from './config.js';
import { createApp } from './app.js';

const server = createApp().listen(config.port, () => {
  console.log(JSON.stringify({
    level: 'info',
    msg: 'server started',
    port: config.port,
    visionModel: config.openrouter.visionModel,
  }));
});

// 컨테이너 중지(SIGTERM) 시 처리 중인 요청을 마치고 종료
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
