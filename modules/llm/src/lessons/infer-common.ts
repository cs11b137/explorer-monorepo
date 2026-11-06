/**
 * 推理组（prefill、kvcache、prefix、batching、quant）共用的输入和画法。
 * 引擎行为（块哈希、块分配、调度）在 src/engine/，这里只负责把结果写成字节层和图元。
 */
import { num } from '../decode/structures';
import { hex, LayerWriter, type Fidelity } from '../decode/writer';
import { f16Bits, f16FromBits, i32Bytes } from '../model/numeric';
import { TOKENIZER } from '../model/tokenizer';
import type { KVCache } from '../model/transformer';
import { u64Bytes, fullHash, type BlockKey } from '../engine/prefix';
import type { Color } from './types';

const T = TOKENIZER;

/** prefill、kvcache、quant 三课共用的提示词：8 个 token，模型接着写出语料里那句「the keys and values, so the model ...」。 */
export const PROMPT = 'the cache keeps';
export const PROMPT_IDS = T.encode(PROMPT);

/** 真实部署里权重和 KV cache 常用的格式：fp16，每个数 2 字节。 */
export const FP16_BYTES = 2;

let serial = 0;
export const layerOf = (name: string, color: Color = 'blue', summary = ''): LayerWriter => new LayerWriter(`inf${serial++}`, name, color, summary);

/** 概念结构，可以给字段标 E.G.（每次运行或换一台机器就会变的值，比如时间）。配 fidelity「示意」。 */
export function conceptOf(name: string, fields: Array<[field: string, value: string, note?: string, example?: boolean]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = layerOf(name, color, summary);
  for (const [field, value, note, example] of fields) layer.field(field, value, undefined, { note, example: example || undefined });
  return layer;
}

/** fp16 向量写成一个字段：值列表 + 2n 个字节。 */
function f16Field(layer: LayerWriter, name: string, values: readonly number[], note?: string): void {
  const bits = values.map(f16Bits);
  layer.field(name, `[${bits.map((b) => num(f16FromBits(b), 3)).join(', ')}]`, () => bits.forEach((b) => layer.u16(b)), { note });
}

/**
 * 一段位置的 KV cache，按 fp16 写：每个位置依次是每层的 K（已过 RoPE）和 V。
 * 真实引擎（llama.cpp、vLLM）按层分开存、块内怎么排各不相同，所以这是 internal 布局；每个数的 fp16 字节是真的。
 */
export function kvLayer(name: string, cache: KVCache, from: number, to: number, options: { color?: Color; summary?: string; labels?: (pos: number) => string } = {}): LayerWriter {
  const layers = cache.k.length;
  const per = 2 * layers * cache.k[0][0].length * FP16_BYTES;
  const layer = layerOf(`fp16 KV[${from}..${to - 1}] · ${(to - from) * per} 字节`, options.color ?? 'teal', options.summary ?? `每个位置 ${per} 字节：${layers} 层 × (K + V)`);
  for (let pos = from; pos < to; pos++) {
    const label = options.labels?.(pos) ?? String(pos);
    for (let l = 0; l < layers; l++) {
      f16Field(layer, `${name}[${label}] L${l} K`, cache.k[l][pos], `位置 ${pos} 第 ${l} 层的 K，已经过 RoPE 旋转。`);
      f16Field(layer, `${name}[${label}] L${l} V`, cache.v[l][pos], `位置 ${pos} 第 ${l} 层的 V。`);
    }
  }
  return layer;
}

/** 块表：int32 数组，下标是逻辑块号，值是物理块号（vLLM 传给 attention kernel 的 block_table 一行）。 */
export function blockTableLayer(name: string, table: readonly number[], options: { color?: Color; summary?: string; blockSize: number }): LayerWriter {
  const layer = layerOf(`int32 ${name}[${table.length}] · ${table.length * 4} 字节`, options.color ?? 'violet', options.summary ?? '逻辑块号 → 物理块号');
  table.forEach((physical, logical) => {
    layer.field(`${name}[${logical}] · +${logical * 4}`, `物理块 ${physical}`, () => layer.raw(i32Bytes(physical)), {
      note: `逻辑块 ${logical} 存位置 ${logical * options.blockSize}–${logical * options.blockSize + options.blockSize - 1}，在物理块 ${physical}。`,
    });
  });
  return layer;
}

/** 一块的哈希输入：父块哈希（u64 小端）+ 块里每个 token 的 int32 小端。 */
export function hashInputLayer(name: string, key: BlockKey, color: Color = 'violet'): LayerWriter {
  const layer = layerOf(`${name} 哈希输入 · ${key.bytes.length} 字节`, color, `hash(父块哈希, 本块 ${key.tokens.length} 个 token)`);
  layer.field('parent · +0', key.index === 0 ? '无（第 0 块）' : fullHash(key.parent), () => layer.raw(u64Bytes(key.parent)), { note: key.index === 0 ? '第 0 块没有父块，用 0。' : '前一块的哈希：前缀里任何一个 token 变了，它就变。' });
  key.tokens.forEach((id, i) => layer.field(`token[${i}] · +${8 + i * 4}`, `${id}（${T.label(id)}）`, () => layer.raw(i32Bytes(id)), { note: `token id ${id} = ${hex(id, 8)}。` }));
  return layer;
}

/** 块哈希本身：u64 小端。 */
export function hashLayer(name: string, key: BlockKey, color: Color = 'violet'): LayerWriter {
  const layer = layerOf(`uint64 ${name} · 8 字节`, color, '本站用 64 位 FNV-1a 代替真实引擎的哈希函数');
  layer.field(name, fullHash(key.hash), () => layer.raw(u64Bytes(key.hash)), { note: '前缀缓存的键：查到就复用这一块的 K、V。' });
  return layer;
}

/** 字节数的显示，和轨迹表的 formatSize 同一套单位（KiB = 1024 字节）。 */
export function bytesText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${+(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} 字节`;
}

/** 大数的 FLOPs：G（10⁹）、T（10¹²），保留 3 位有效数字。 */
export function flopsText(flops: number): string {
  if (flops >= 1e12) return `${+(flops / 1e12).toPrecision(3)} TFLOPs`;
  if (flops >= 1e9) return `${+(flops / 1e9).toPrecision(3)} GFLOPs`;
  return `${flops} FLOPs`;
}

/** 秒 → 毫秒，保留 3 位有效数字。 */
export const msText = (seconds: number): string => `${+(seconds * 1000).toPrecision(3)} ms`;

/** 比值，保留 2 位小数。 */
export const ratioText = (a: number, b: number): string => (a / b).toFixed(2);

/** token 的展示文字。 */
export const labelOf = (id: number): string => T.label(id);

export type { Fidelity };
