import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host}`).pathname);
    let target = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(root)) throw new Error('Forbidden');
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
    response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream' });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`Shortform Studio: http://localhost:${port}`));
