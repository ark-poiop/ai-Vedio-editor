import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
const stateModule = await readFile(resolve(root, 'src/state.js'), 'utf8');
const app = await readFile(resolve(root, 'src/app.js'), 'utf8');

// Multi-file dist (preserves ES module structure)
await writeFile(resolve(dist, 'index.html'), html
  .replace('./src/styles.css', './styles.css')
  .replace('./src/app.js', './app.js'));
await cp(resolve(root, 'src/styles.css'), resolve(dist, 'styles.css'));
await cp(resolve(root, 'src/state.js'), resolve(dist, 'state.js'));
await writeFile(resolve(dist, 'app.js'), app.replace("'./state.js'", "'./state.js'"));

// Standalone HTML: inline state.js into app.js as a single script
const inlinedApp = app.replace(
  /^import \{[^}]+\} from ['"]\.\/state\.js['"];?\n?/m,
  stateModule.replace(/^export /gm, '') + '\n'
);
const standalone = html
  .replace('<link rel="stylesheet" href="./src/styles.css">', `<style>${css}</style>`)
  .replace('<script type="module" src="./src/app.js"></script>', `<script type="module">${inlinedApp}</script>`);
await writeFile(resolve(dist, 'shortform-studio.html'), standalone);
await writeFile(resolve(dist, 'shortform-studio.html.download'), standalone);
console.log('Built Shortform Studio → dist/ (standalone HTML + forced-download copy)');
