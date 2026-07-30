import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createShortformServer } from '../server/app-server.mjs';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 2210);
const host = process.env.HOST || '127.0.0.1';

// ─── Auto-start Whisper server if STT_PROVIDER=whisper-local ─────────────────
let whisperProcess = null;
const sttProvider = (process.env.STT_PROVIDER || 'mock').toLowerCase();
const whisperUrl = process.env.WHISPER_URL || 'http://localhost:8787';

if (sttProvider === 'whisper-local' || sttProvider === 'whisper') {
  const whisperDir = resolve(root, 'whisper-server');
  const venvPython = resolve(whisperDir, '.venv', 'bin', 'python3');
  const serverScript = resolve(whisperDir, 'server.py');

  if (existsSync(venvPython) && existsSync(serverScript)) {
    console.log('[whisper] Whisper 서버를 자동 시작합니다...');
    whisperProcess = spawn(venvPython, [serverScript], {
      cwd: whisperDir,
      env: { ...process.env, WHISPER_HOST: '127.0.0.1', WHISPER_PORT: new URL(whisperUrl).port || '8787' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    whisperProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[whisper] ${line}`);
    });
    whisperProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[whisper] ${line}`);
    });
    whisperProcess.on('exit', (code) => {
      if (!shuttingDown) console.warn(`[whisper] Whisper 서버가 종료되었습니다 (code: ${code})`);
      whisperProcess = null;
    });
    whisperProcess.on('error', (err) => {
      console.error(`[whisper] Whisper 서버 시작 실패:`, err.message);
      whisperProcess = null;
    });
  } else {
    console.warn('[whisper] STT_PROVIDER=whisper-local이지만 whisper-server/.venv가 없습니다.');
    console.warn('[whisper] 설치: cd whisper-server && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt');
  }
}

// ─── App server ──────────────────────────────────────────────────────────────
const server = createShortformServer({ root });

server.listen(port, host, () => {
  console.log(`Shortform Studio: http://localhost:${port}`);
  console.log(`STT Provider: ${sttProvider}${whisperProcess ? ` (auto-started → ${whisperUrl})` : ''}`);
  console.log(`LLM Provider: ${process.env.LLM_PROVIDER || 'disabled'}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: Shortform Studio를 종료합니다.`);
  if (whisperProcess) {
    console.log('[whisper] Whisper 서버를 종료합니다...');
    whisperProcess.kill('SIGTERM');
    await new Promise((r) => { whisperProcess?.on('exit', r); setTimeout(r, 5000); });
  }
  try {
    await server.shutdown();
  } catch (error) {
    console.error('서버 종료 중 오류가 발생했습니다.', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
