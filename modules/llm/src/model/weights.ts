/**
 * 预训练权重的存取。weights.json 由 scripts/train.ts 生成：固定种子初始化，在内置语料上用 Adam 训练，
 * 然后按 fp32 小端写出。文件结构仿照 safetensors：header 记录每个张量的 dtype、形状（行优先）和字节区间，
 * data 是全部张量首尾相连的字节（这里用 base64 存进 JSON，方便打包）。
 */
import { f32Bits, f32FromBits } from './numeric';
import { type BpeTokenizer } from '@explorer/llm-core/tokenizer';
import { type Mat, type Vec } from './tensor';
import { LAYER_TENSORS, makeConfig, type LayerWeights, type Weights } from './transformer';

export interface TensorEntry {
  dtype: 'F32';
  /** 行优先的形状：矩阵是 [行, 列]，和 safetensors 一致（GGUF 的 ne[] 正好反过来）。 */
  shape: number[];
  /** 在 data 里的字节区间 [起, 止)。 */
  data_offsets: [number, number];
}

export interface WeightsFile {
  /** 合并表的指纹。分词器变了，权重就对不上了。 */
  tokenizer: string;
  train: { seed: number; steps: number; lr: number; logs: Array<{ step: number; loss: number }> };
  header: Record<string, TensorEntry>;
  /** base64 编码的 fp32 小端字节。 */
  data: string;
}

/** 合并表的指纹：所有规则拼成字符串后的 FNV-1a 32 位哈希。 */
export function tokenizerFingerprint(tokenizer: BpeTokenizer): string {
  let hash = 0x811c9dc5;
  for (const char of tokenizer.merges.map((merge) => merge.pair.join(',')).join(';')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${tokenizer.merges.length}:${hash.toString(16).padStart(8, '0')}`;
}

type Entries = Array<[name: string, value: Vec | Mat]>;

function entriesOf(weights: Weights): Entries {
  const out: Entries = [['token_embd.weight', weights.token_embd]];
  weights.layers.forEach((layer, l) => LAYER_TENSORS.forEach((key) => out.push([`blk.${l}.${key}.weight`, layer[key]])));
  out.push(['output_norm.weight', weights.output_norm], ['output.weight', weights.output]);
  return out;
}

const isMat = (value: Vec | Mat): value is Mat => Array.isArray(value[0]);

export function serializeWeights(weights: Weights, tokenizer: BpeTokenizer, train: WeightsFile['train']): WeightsFile {
  const header: Record<string, TensorEntry> = {};
  const bytes: number[] = [];
  for (const [name, value] of entriesOf(weights)) {
    const flat = isMat(value) ? value.flat() : value;
    const from = bytes.length;
    for (const x of flat) {
      const bits = f32Bits(x);
      bytes.push(bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, bits >>> 24);
    }
    header[name] = { dtype: 'F32', shape: isMat(value) ? [value.length, value[0].length] : [value.length], data_offsets: [from, bytes.length] };
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { tokenizer: tokenizerFingerprint(tokenizer), train, header, data: btoa(binary) };
}

export function deserializeWeights(file: WeightsFile, tokenizer: BpeTokenizer): Weights {
  const fingerprint = tokenizerFingerprint(tokenizer);
  if (file.tokenizer !== fingerprint) throw new Error(`权重是用另一份合并表训练的（${file.tokenizer} ≠ ${fingerprint}），先运行 npm run train -w llm-explorer`);
  const binary = atob(file.data);
  const read = (name: string): Vec | Mat => {
    const entry = file.header[name];
    if (!entry) throw new Error(`权重文件里没有 ${name}`);
    const [from, to] = entry.data_offsets;
    const flat: number[] = [];
    for (let at = from; at < to; at += 4) flat.push(f32FromBits(binary.charCodeAt(at) | (binary.charCodeAt(at + 1) << 8) | (binary.charCodeAt(at + 2) << 16) | (binary.charCodeAt(at + 3) << 24)));
    if (entry.shape.length === 1) return flat;
    const [rows, cols] = entry.shape;
    return Array.from({ length: rows }, (_, r) => flat.slice(r * cols, (r + 1) * cols));
  };
  return {
    config: makeConfig(tokenizer.size),
    token_embd: read('token_embd.weight') as Mat,
    layers: Array.from({ length: makeConfig(tokenizer.size).nLayers }, (_, l) => Object.fromEntries(LAYER_TENSORS.map((key) => [key, read(`blk.${l}.${key}.weight`)])) as unknown as LayerWeights),
    output_norm: read('output_norm.weight') as Vec,
    output: read('output.weight') as Mat,
  };
}
