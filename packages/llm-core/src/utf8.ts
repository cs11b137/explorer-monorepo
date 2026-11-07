/**
 * UTF-8 编解码（RFC 3629）。自己实现而不用 TextEncoder，是为了暴露每个字节的角色：
 * 课程要讲「一个汉字是 3 个字节」「token 可能切在字符中间」。
 */

/** 一个字节在 UTF-8 里的角色。 */
export type Utf8Kind = 'ascii' | 'lead2' | 'lead3' | 'lead4' | 'cont' | 'invalid';

export function utf8Kind(byte: number): Utf8Kind {
  if (byte < 0x80) return 'ascii';
  if (byte < 0xc0) return 'cont';
  if (byte < 0xc2) return 'invalid';
  if (byte < 0xe0) return 'lead2';
  if (byte < 0xf0) return 'lead3';
  if (byte < 0xf5) return 'lead4';
  return 'invalid';
}

/** 首字节声明的整个字符长度；续字节和非法字节返回 0。 */
export function utf8Length(byte: number): number {
  return { ascii: 1, lead2: 2, lead3: 3, lead4: 4, cont: 0, invalid: 0 }[utf8Kind(byte)];
}

/** 码点 → 字节。 */
export function encodeCodePoint(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

/** 文本 → UTF-8 字节。按码点遍历，代理对会正确合成一个 4 字节字符。 */
export function utf8Encode(text: string): number[] {
  // 和「按码点遍历、逐个 encodeCodePoint」结果相同，只是不为每个字符分配数组（分词时每次调用都走这里，是热点）。
  // 孤立的代理码元和 for...of 一样当作一个码点（编成 3 字节）。
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

/** UTF-8 字节数，等于 utf8Encode(text).length，但不分配数组（JSON 序列化、模板渲染逐段量长度用）。 */
export function utf8ByteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) n += 1;
    else if (unit < 0x800) n += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** 每个字符和它的字节，课程逐字展示用。 */
export function utf8Chars(text: string): Array<{ char: string; bytes: number[] }> {
  return [...text].map((char) => ({ char, bytes: encodeCodePoint(char.codePointAt(0)!) }));
}

/**
 * 字节 → 文本。非法序列按 WHATWG 的做法替换成 U+FFFD（每个最长的非法前缀换一个），
 * 和浏览器 TextDecoder 的结果一致。末尾没收齐的字符也换成 U+FFFD；流式场景用 Utf8Stream。
 */
export function utf8Decode(bytes: readonly number[]): string {
  return decodeWithTail(bytes, true).text;
}

interface Decoded {
  text: string;
  /** 末尾没有收齐的字节。 */
  tail: number[];
}

function decodeWithTail(bytes: readonly number[], final: boolean): Decoded {
  let text = '';
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    const need = utf8Length(lead);
    if (need === 1) {
      text += String.fromCharCode(lead);
      i++;
      continue;
    }
    if (need === 0) {
      text += '�';
      i++;
      continue;
    }
    // 续字节的合法范围：E0 后面不能是 80–9F（过长编码），ED 后面不能是 A0–BF（代理区），F0/F4 同理。
    const lower = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
    const upper = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
    let cp = lead & (need === 2 ? 0x1f : need === 3 ? 0x0f : 0x07);
    let j = 1;
    for (; j < need && i + j < bytes.length; j++) {
      const byte = bytes[i + j];
      if (byte < (j === 1 ? lower : 0x80) || byte > (j === 1 ? upper : 0xbf)) break;
      cp = (cp << 6) | (byte & 0x3f);
    }
    if (j === need) {
      text += String.fromCodePoint(cp);
      i += need;
    } else if (i + j === bytes.length && !final) {
      return { text, tail: bytes.slice(i) };
    } else {
      // 不完整或非法：替换掉已读的部分，从下一个字节重新开始。
      text += '�';
      i += j;
    }
  }
  return { text, tail: [] };
}

/**
 * 流式解码器：一次喂一个 token 的字节，只吐出已经收齐的字符，不完整的尾巴先存着。
 * 这就是流式输出时「一个汉字被拆成两个 token」也不会出现乱码的原因。
 */
export class Utf8Stream {
  /** 还没收齐的字节。 */
  pending: number[] = [];

  /** 喂入字节，返回这次可以显示的文字。 */
  push(bytes: readonly number[]): string {
    const { text, tail } = decodeWithTail([...this.pending, ...bytes], false);
    this.pending = tail;
    return text;
  }

  /** 流结束：剩下的不完整字节变成 U+FFFD。 */
  flush(): string {
    const text = this.pending.length ? utf8Decode(this.pending) : '';
    this.pending = [];
    return text;
  }
}

/** 两位大写十六进制，字节展示用。 */
export const hex2 = (byte: number): string => byte.toString(16).toUpperCase().padStart(2, '0');
