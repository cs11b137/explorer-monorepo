// 校验 site/ 和 MANIFEST.json 逐字节一致，且没有多余文件。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const manifest = JSON.parse(readFileSync(join(ROOT, 'MANIFEST.json'), 'utf8'));
const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
const actual = readdirSync(SITE, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `/${relative(SITE, join(entry.parentPath, entry.name))}`);
const problems = [];
for (const path of actual) {
  if (!expected.has(path)) problems.push(`多余：${path}`);
  else if (createHash('sha256').update(readFileSync(join(SITE, path))).digest('hex') !== expected.get(path)) problems.push(`被改动：${path}`);
}
for (const path of expected.keys()) if (!actual.includes(path)) problems.push(`缺失：${path}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`site/ 与 MANIFEST.json 一致：${actual.length} 个文件`);
