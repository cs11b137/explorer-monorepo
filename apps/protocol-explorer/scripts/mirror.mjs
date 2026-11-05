// 把线上部署的静态产物逐字节镜像到 site/，并写下 manifest。只下载，不执行任何下载到的内容。
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://protocol-explorer-alpha.vercel.app';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const SEEDS = ['/', '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/site.webmanifest', '/og.png', '/robots.txt', '/sitemap.xml'];
const queue = [...SEEDS];
const seen = new Set();
const files = [];

const refsIn = (text, base) => {
  const found = new Set();
  // /assets/x 和 assets/x（__vite__mapDeps）。
  for (const match of text.matchAll(/\/?assets\/[A-Za-z0-9._-]+/g)) found.add(`/${match[0].replace(/^\//, '')}`);
  for (const match of text.matchAll(/["'(]\/([A-Za-z0-9._-]+\.(?:png|svg|ico|webmanifest|json|woff2?|txt|xml))["')]/g)) found.add(`/${match[1]}`);
  // 动态 import 的语言包是相对路径。
  if (base.startsWith('/assets/')) for (const match of text.matchAll(/["'`]\.\/([A-Za-z0-9._-]+\.(?:js|css))["'`]/g)) found.add(`/assets/${match[1]}`);
  return found;
};

rmSync(SITE, { recursive: true, force: true });
while (queue.length) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);
  const response = await fetch(ORIGIN + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  // 资源路径拿到 HTML 说明它不存在，只是被回退成了页面。
  if (path !== '/' && type.startsWith('text/html')) throw new Error(`${path}: 得到 HTML，不是资源`);
  const out = join(SITE, path === '/' ? 'index.html' : path.slice(1));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  files.push({ path: path === '/' ? '/index.html' : path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: type, etag: response.headers.get('etag') });
  if (/\.(?:js|css|webmanifest)$/.test(path) || path === '/') for (const ref of refsIn(bytes.toString('utf8'), path)) if (!seen.has(ref)) queue.push(ref);
}
files.sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(join(ROOT, 'MANIFEST.json'), `${JSON.stringify({ origin: ORIGIN, mirroredAt: new Date().toISOString(), files }, null, 2)}\n`);
console.log(`镜像完成：${files.length} 个文件，${files.reduce((sum, file) => sum + file.bytes, 0)} 字节`);
