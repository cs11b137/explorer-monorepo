/**
 * 原在 CONTEXT EXPLORER 的 src/core/ids.ts（那里转导出，接口不变；AGENT EXPLORER 也用）。核对过的事实见 modules/context/README.md。
 *
 * 示例 id 和时间。真实的 msg_…、toolu_…、req_… 每次调用都不同，这里用固定种子生成同样形状的串，
 * 课程文案和测试才能对上。界面上这些字段一律标 E.G.。
 *
 * 形状照文档里的例子：msg_01 + 22 个字符（msg_01XFDUDYJgAACzvnptvVoYEL），
 * req_011C + 20 个字符（req_011CSHoEeqs5C35K2UUqR7Fy），toolu_01 + 22 个字符。
 */
import { mulberry32 } from './prng';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';

function randomText(seed: number, length: number): string {
  const rand = mulberry32(seed);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

export type IdKind = 'msg' | 'toolu' | 'req' | 'chatcmpl' | 'resp' | 'call';

const SHAPES: Record<IdKind, [prefix: string, length: number]> = {
  msg: ['msg_01', 22],
  toolu: ['toolu_01', 22],
  req: ['req_011C', 20],
  // OpenAI 的 id 形状：chatcmpl-…、resp_…（十六进制）、call_…。
  chatcmpl: ['chatcmpl-', 29],
  resp: ['resp_', 48],
  call: ['call_', 24],
};

/** 固定种子的示例 id。 */
export function exampleId(kind: IdKind, seed: number): string {
  const [prefix, length] = SHAPES[kind];
  if (kind === 'resp') {
    const rand = mulberry32(seed);
    return prefix + Array.from({ length }, () => Math.floor(rand() * 16).toString(16)).join('');
  }
  return prefix + randomText(seed * 7919 + prefix.length, length);
}

/** 示例时刻：课程统一用这一天（本站核对 API 事实的日期）的 UTC 上午。Unix 秒。 */
export const EXAMPLE_EPOCH = Date.UTC(2026, 10, 6, 2, 0, 0) / 1000;

/** HTTP 的 date 头（RFC 9110 §5.6.7 的 IMF-fixdate）。 */
export function httpDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toUTCString();
}
