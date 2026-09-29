#!/usr/bin/env node
// Generate the one build identity shared by the Vite client and the packaged server.
// `--new` starts a fresh deployment identity. Later build steps reuse the metadata written by that
// deployment, so the client and server embedded in one package cannot drift apart.
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '..');
const root = path.resolve(server, '..');
const output = path.join(server, 'build-meta.json');
const forceNew = process.argv.includes('--new');

const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'public',
  'data',
  '.vite',
]);

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.name === 'build-meta.json' || entry.name.endsWith('.tgz')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function addIfFile(files, file) {
  if (existsSync(file) && statSync(file).isFile()) files.push(file);
}

const files = [];
for (const directory of [
  path.join(server, 'bin'),
  path.join(server, 'src'),
  path.join(server, 'connectors'),
  path.join(server, 'hooks'),
  path.join(root, 'web', 'src'),
  path.join(root, 'web', 'public'),
]) files.push(...walk(directory));
for (const file of [
  path.join(server, 'package.json'),
  path.join(server, 'package-lock.json'),
  path.join(server, 'tsconfig.json'),
  path.join(server, 'tsconfig.build.json'),
  path.join(server, 'scripts', 'build-server.mjs'),
  path.join(server, 'scripts', 'bundle-web.mjs'),
  path.join(server, 'scripts', 'write-build-meta.mjs'),
  path.join(root, 'README.md'),
  path.join(root, 'README.zh-CN.md'),
  path.join(root, 'LICENSE'),
  path.join(root, 'web', 'index.html'),
  path.join(root, 'web', 'vite.config.js'),
  path.join(root, 'web', 'package.json'),
  path.join(root, 'web', 'package-lock.json'),
  path.join(root, 'web', 'tsconfig.json'),
]) addIfFile(files, file);

const uniqueFiles = [...new Set(files)].sort((a, b) => relative(a).localeCompare(relative(b)));
const hash = createHash('sha256');
for (const file of uniqueFiles) {
  const name = relative(file);
  const content = readFileSync(file);
  hash.update(name);
  hash.update('\0');
  hash.update(String(content.length));
  hash.update('\0');
  hash.update(content);
  hash.update('\0');
}

const packageInfo = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
const version = typeof packageInfo.version === 'string' ? packageInfo.version : '0.0.0';
const sourceHash = `sha256:${hash.digest('hex')}`;
const validBuildId = (value) => typeof value === 'string' && /^[0-9a-f]{12}$/.test(value);
let buildId = null;
if (!forceNew && existsSync(output)) {
  try {
    const previous = JSON.parse(readFileSync(output, 'utf8'));
    if (previous?.version === version && previous?.sourceHash === sourceHash && validBuildId(previous?.buildId)) {
      buildId = previous.buildId;
    }
  } catch { /* regenerate malformed or legacy metadata */ }
}
if (!buildId) buildId = randomBytes(6).toString('hex');
const metadata = {
  version,
  buildId,
  sourceHash,
};
writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`[build-meta] ${metadata.version}+${metadata.buildId}${forceNew ? ' (new deployment)' : ''}`);
