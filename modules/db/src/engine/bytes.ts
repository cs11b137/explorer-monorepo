/** 小端字节读写。x86-64 和 aarch64 上的 PostgreSQL 页面都是小端。 */
export const rd16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
export const rd32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
export const rd64 = (b: Uint8Array, o: number): bigint => BigInt(rd32(b, o)) | (BigInt(rd32(b, o + 4)) << 32n);

export function wr16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}

export function wr32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

export function wr64(b: Uint8Array, o: number, v: bigint): void {
  wr32(b, o, Number(v & 0xffffffffn));
  wr32(b, o + 4, Number((v >> 32n) & 0xffffffffn));
}

export const MAXALIGN = (n: number): number => (n + 7) & ~7;
export const align = (n: number, a: number): number => (n + a - 1) & ~(a - 1);

export function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += (b[i] & 0xff).toString(16).padStart(2, '0');
  return out;
}

export const asciiBytes = (text: string): number[] => [...text].map((c) => c.charCodeAt(0) & 0xff);

/** PostgreSQL 的 LSN 写法：高 32 位 / 低 32 位，都用十六进制。 */
export const lsnText = (lsn: bigint): string => `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`;
export const parseLsn = (text: string): bigint => {
  const [hi, lo] = text.split('/');
  return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
};
