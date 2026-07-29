import { resolve } from 'node:path';
import { createShortformServer } from '../server/app-server.mjs';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 4173);
const server = createShortformServer({ root });

server.listen(port, '0.0.0.0', () => {
  console.log(`Shortform Studio: http://localhost:${port}`);
  console.log(`STT Provider: ${process.env.STT_PROVIDER || 'mock'}`);
});
