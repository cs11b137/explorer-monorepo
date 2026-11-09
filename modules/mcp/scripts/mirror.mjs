// 把 Runlayer/mcp-explained 仓库 public/ 下的文件逐字节镜像到 site/，并写下 manifest。只下载，不执行任何下载到的内容。
// 默认镜像 MANIFEST.json 里记录的 commit；传 commit 或分支名可以换一个版本：npm run mirror -w mcp-explained -- main
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Runlayer/mcp-explained';
const DIR = 'public/';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const MANIFEST = join(ROOT, 'MANIFEST.json');

const get = async (url, type) => {
  const response = await fetch(url, { headers: { 'User-Agent': 'explorer-monorepo-mirror' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return type === 'json' ? response.json() : Buffer.from(await response.arrayBuffer());
};

const ref = process.argv[2] ?? (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')).commit : 'main');
const { sha: commit, commit: meta } = await get(`https://api.github.com/repos/${REPO}/commits/${ref}`, 'json');
const tree = await get(`https://api.github.com/repos/${REPO}/git/trees/${commit}?recursive=1`, 'json');
if (tree.truncated) throw new Error('仓库文件树被截断');
const paths = tree.tree.filter((item) => item.type === 'blob' && item.path.startsWith(DIR)).map((item) => item.path);
if (!paths.includes(`${DIR}index.html`)) throw new Error(`${commit} 的 ${DIR} 里没有 index.html`);

rmSync(SITE, { recursive: true, force: true });
const files = [];
for (const path of paths.sort()) {
  const bytes = await get(`https://raw.githubusercontent.com/${REPO}/${commit}/${path}`);
  const out = join(SITE, path.slice(DIR.length));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  files.push({ path: `/${path.slice(DIR.length)}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = { repository: `https://github.com/${REPO}`, directory: DIR, commit, committedAt: meta.committer.date, mirroredAt: new Date().toISOString(), files };
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`镜像完成：${commit.slice(0, 7)}，${files.length} 个文件，${files.reduce((sum, file) => sum + file.bytes, 0)} 字节`);
