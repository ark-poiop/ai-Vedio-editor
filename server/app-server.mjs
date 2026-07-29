import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createSttService } from './stt-service.mjs';
import { createLlmService } from './llm-service.mjs';
import { createRenderService } from './render-service.mjs';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttc': 'font/collection',
  '.srt': 'application/x-subrip; charset=utf-8',
};

function isLocalSameOriginConfigurationRequest(request) {
  let requestUrl;
  try {
    requestUrl = new URL(`http://${request.headers.host || ''}`);
  } catch {
    return false;
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!localHosts.has(requestUrl.hostname.toLowerCase())) return false;
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}

export function createShortformServer({
  root,
  sttService = createSttService(),
  llmService = createLlmService(),
  renderService = createRenderService(),
}) {
  const resolvedRoot = resolve(root);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/llm/config') && !isLocalSameOriginConfigurationRequest(request)) {
        response.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(JSON.stringify({ error: 'LLM 연결 설정은 로컬 앱에서만 변경할 수 있습니다.' }));
        return;
      }
      if (await sttService.handleRequest(request, response, url)) return;
      if (await llmService.handleRequest(request, response, url)) return;
      if (await renderService.handleRequest(request, response, url)) return;
      const pathname = decodeURIComponent(url.pathname);
      let target = resolve(resolvedRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
      }
      if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      response.writeHead(200, {
        'Content-Type': contentTypes[extname(target)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(await readFile(target));
    } catch {
      if (!response.headersSent) response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!response.writableEnded) response.end('Not found');
    }
  });
  let servicesClosePromise;
  const closeServices = () => {
    servicesClosePromise ||= Promise.all([
      Promise.resolve(sttService.close?.()),
      Promise.resolve(llmService.close?.()),
      Promise.resolve(renderService.close?.()),
    ]);
    return servicesClosePromise;
  };
  server.once('close', () => { void closeServices(); });
  server.shutdown = async () => {
    const closingServices = closeServices();
    if (server.listening) {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
    await closingServices;
  };
  return server;
}
