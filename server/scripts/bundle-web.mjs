#!/usr/bin/env node
// Build the web client and stage it (plus the docs/licence) inside the server package so a published
// `handmux` / a global install is self-contained: server + frontend in one tarball. Runs automatically
// via `prepack` (npm pack / npm publish), and on demand via `npm run bundle`.
//
// Outputs (all gitignored, regenerated each pack):
//   server/public/            ← built web/dist
//   server/README*.md, LICENSE ← copied from the repo root so the npm page has them
import { execFileSync, execSync } from 'node:child_process';
import { rmSync, cpSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // server/scripts
const server = path.resolve(here, '..');                   // server
const root = path.resolve(server, '..');                   // repo root
const web = path.join(root, 'web');

if (!existsSync(path.join(web, 'node_modules'))) {
  console.log('[bundle] installing web deps…');
  execSync('npm install', { cwd: web, stdio: 'inherit' });
}
execFileSync(process.execPath, [path.join(server, 'scripts', 'write-build-meta.mjs'), '--new'], {
  cwd: root,
  stdio: 'inherit',
});
console.log('[bundle] building web client…');
execSync('npm run build', { cwd: web, stdio: 'inherit' });

const dest = path.join(server, 'public');
rmSync(dest, { recursive: true, force: true });
cpSync(path.join(web, 'dist'), dest, { recursive: true });
console.log(`[bundle] web → ${path.relative(root, dest)}`);

for (const f of ['README.md', 'README.zh-CN.md', 'LICENSE']) {
  if (existsSync(path.join(root, f))) copyFileSync(path.join(root, f), path.join(server, f));
}
console.log('[bundle] copied README*/LICENSE into the package');
