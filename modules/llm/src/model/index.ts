/**
 * 计算核心的统一入口。课程从这里取：
 *   import { TOKENIZER, MODEL, VISION, forward, sample, mulberry32, ... } from '../model';
 *
 * - TOKENIZER：内置语料上训练的字节级 BPE 分词器（共享包 @explorer/llm-core 的 tokenizer.ts，和 context 模块共用）
 * - MODEL：预训练好的迷你 Transformer 权重（weights.data.ts，由 scripts/train.ts 生成）
 * - VISION：图像 patch 投影的权重（vision.ts，固定种子，未训练）
 * - 前向、KV cache、生成（transformer.ts），反向传播、优化器、LoRA（train.ts）
 * - 采样和约束掩码（sample.ts），数值格式和 GGUF 量化（numeric.ts）；UTF-8、语料、随机数也在 @explorer/llm-core，从这里一并导出
 *
 * 接口说明见 modules/llm/README.md。
 */
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { visionFor } from './vision';
import { deserializeWeights } from './weights';
import { WEIGHTS_DATA } from './weights.data';

export * from '@explorer/llm-core/corpus';
export * from './numeric';
export * from '@explorer/llm-core/prng';
export * from './sample';
export * from './tensor';
export * from '@explorer/llm-core/tokenizer';
export * from './train';
export * from './transformer';
export * from '@explorer/llm-core/utf8';
export * from './vision';
export { deserializeWeights, serializeWeights, tokenizerFingerprint, type TensorEntry, type WeightsFile } from './weights';

/** 预训练权重文件的内容（含训练配方和损失日志）。 */
export const WEIGHTS_FILE = WEIGHTS_DATA;

/** 全站共用的预训练模型。只读：课程要改权重（比如 LoRA），先 cloneWeights。 */
export const MODEL = deserializeWeights(WEIGHTS_FILE, TOKENIZER);

/** 全站共用的图像 patch 投影，维数和 MODEL 一致。只读。 */
export const VISION = visionFor(MODEL.config.dModel);
