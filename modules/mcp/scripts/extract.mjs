// 报告译文字典和原站文字是否对得上。传一个路径时，把全部待译文字（带出处）写成 JSON，交给译者。
//   node scripts/extract.mjs                 只报告缺失和多余
//   node scripts/extract.mjs strings.json    另外导出待译清单
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStrings } from './strings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strings = collectStrings();
const dict = JSON.parse(readFileSync(join(ROOT, 'i18n/zh-CN.json'), 'utf8'));
// "字段|原文" 是只用在某个字段的译文，对应的原文和字段必须真的存在。
const wanted = new Set(strings.flatMap((entry) => [entry.en, ...entry.where.map((place) => `${place.split(' · ')[1]}|${entry.en}`)]));
const missing = strings.filter((entry) => !(entry.en in dict));
const extra = Object.keys(dict).filter((en) => !wanted.has(en));
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(strings, null, 2)}\n`);
console.log(`原站文字 ${strings.length} 条，已翻译 ${strings.length - missing.length} 条，缺 ${missing.length} 条，字典里多余 ${extra.length} 条`);
for (const entry of missing.slice(0, 20)) console.log(`缺：${entry.en}  (${entry.where[0]})`);
for (const en of extra.slice(0, 20)) console.log(`多余：${en}`);
process.exitCode = missing.length || extra.length ? 1 : 0;
