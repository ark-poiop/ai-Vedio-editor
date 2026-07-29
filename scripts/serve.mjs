import { resolve } from 'node:path';
import { createShortformServer } from '../server/app-server.mjs';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const server = createShortformServer({ root });

server.listen(port, host, () => {
  console.log(`Shortform Studio: http://localhost:${port}`);
  console.log(`STT Provider: ${process.env.STT_PROVIDER || 'mock'}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: Shortform Studio를 종료합니다.`);
  try {
    await server.shutdown();
  } catch (error) {
    console.error('서버 종료 중 오류가 발생했습니다.', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
