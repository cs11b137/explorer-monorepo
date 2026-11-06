/**
 * 预训练迷你模型，写出 src/model/weights.data.ts。运行：npm run train -w llm-explorer（几秒）。
 * 训练完全确定，tests/model.test.ts 会重新训练一遍，核对和这里写出的内容逐字节相同。
 * 写成 .ts 而不是 .json，是为了任何环境（vitest、vite、Playwright 的加载器）都能直接 import。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { PRETRAIN, trainFromScratch } from '../src/model/train';
import { serializeWeights } from '../src/model/weights';

const started = performance.now();
const { weights, logs } = trainFromScratch(TOKENIZER, (log) => {
  if (log.step % 500 === 0 || log.step === PRETRAIN.steps - 1) console.log(`step ${log.step}  loss ${log.loss.toFixed(4)}`);
});
const file = serializeWeights(weights, TOKENIZER, { ...PRETRAIN, logs });
const source = [
  '// 由 scripts/train.ts 生成，不要手改。改了分词器、模型结构或训练配方后运行 npm run train -w llm-explorer。',
  "import type { WeightsFile } from './weights';",
  '',
  `export const WEIGHTS_DATA: WeightsFile = ${JSON.stringify(file, null, 1)};`,
  '',
].join('\n');
writeFileSync(resolve('src/model/weights.data.ts'), source);
console.log(`写出 src/model/weights.data.ts，${Object.keys(file.header).length} 个张量，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
