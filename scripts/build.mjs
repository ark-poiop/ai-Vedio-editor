import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
const app = await readFile(resolve(root, 'src/app.js'), 'utf8');
await writeFile(resolve(dist, 'index.html'), html
  .replace('./src/styles.css', './styles.css')
  .replace('./src/app.js', './app.js'));
await cp(resolve(root, 'src/styles.css'), resolve(dist, 'styles.css'));
await cp(resolve(root, 'src/app.js'), resolve(dist, 'app.js'));
const standalone = html
  .replace('<link rel="stylesheet" href="./src/styles.css">', `<style>${css}</style>`)
  .replace('<script src="./src/app.js"></script>', `<script>${app}</script>`);
await writeFile(resolve(dist, 'shortform-studio.html'), standalone);
await writeFile(resolve(dist, 'shortform-studio.html.download'), standalone);
console.log('Built Shortform Studio → dist/ (standalone HTML + forced-download copy)');
