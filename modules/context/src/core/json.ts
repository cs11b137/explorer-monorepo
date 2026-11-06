/**
 * JSON 序列化，同时记下每个值在 UTF-8 字节里的区间。
 *
 * 输出和 JSON.stringify(value, null, indent) 逐字节相同（tests/core.test.ts 核对），
 * 所以逐字节解码时，检查器里的每个字段都能精确对到请求体、响应体里的字节。
 * 字段顺序就是对象的插入顺序：API 不要求顺序，但同一份请求每次序列化都一样，这对提示缓存很重要。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonSpan {
  /** 路径：顶层是 ''，成员写成 a.b，数组元素写成 a[0]，比如 messages[0].content。 */
  path: string;
  /** 所在层级，顶层的值是 0。 */
  depth: number;
  kind: JsonKind;
  /** 成员的键（含引号）开始的字节；数组元素和顶层值没有键，等于 valueFrom。 */
  from: number;
  /** 值开始的字节。 */
  valueFrom: number;
  /** 值结束的字节（不含）。 */
  to: number;
}

export interface JsonBytes {
  text: string;
  bytes: number[];
  /** 按出现顺序：父节点在子节点之前。 */
  spans: JsonSpan[];
}

const childPath = (parent: string, key: string | number) => (typeof key === 'number' ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key);

/** 序列化。indent 为 0 时是紧凑写法（SDK 发出的请求体就是这样）。 */
export function encodeJson(value: unknown, indent = 0): JsonBytes {
  let text = '';
  let at = 0;
  const spans: JsonSpan[] = [];
  const put = (piece: string) => {
    text += piece;
    at += utf8Encode(piece).length;
  };
  const pad = (depth: number) => (indent ? `\n${' '.repeat(indent * depth)}` : '');

  function write(node: unknown, path: string, depth: number, from: number): void {
    const valueFrom = at;
    const span: JsonSpan = { path, depth, kind: 'null', from, valueFrom, to: 0 };
    spans.push(span);
    if (node === null) {
      put('null');
    } else if (Array.isArray(node)) {
      span.kind = 'array';
      put('[');
      node.forEach((item, index) => {
        if (index) put(',');
        put(pad(depth + 1));
        // 和 JSON.stringify 一样：数组里的 undefined、函数写成 null。
        write(item === undefined || typeof item === 'function' ? null : item, childPath(path, index), depth + 1, at);
      });
      if (node.length) put(pad(depth));
      put(']');
    } else if (typeof node === 'object') {
      span.kind = 'object';
      put('{');
      const entries = Object.entries(node as Record<string, unknown>).filter(([, item]) => item !== undefined && typeof item !== 'function');
      entries.forEach(([key, item], index) => {
        if (index) put(',');
        put(pad(depth + 1));
        const keyFrom = at;
        put(`${JSON.stringify(key)}:${indent ? ' ' : ''}`);
        write(item, childPath(path, key), depth + 1, keyFrom);
      });
      if (entries.length) put(pad(depth));
      put('}');
    } else if (typeof node === 'string') {
      span.kind = 'string';
      put(JSON.stringify(node));
    } else if (typeof node === 'number') {
      span.kind = 'number';
      put(JSON.stringify(node));
    } else if (typeof node === 'boolean') {
      span.kind = 'boolean';
      put(String(node));
    } else {
      throw new Error(`JSON 不能表示 ${typeof node}`);
    }
    span.to = at;
  }

  write(value, '', 0, 0);
  return { text, bytes: utf8Encode(text), spans };
}

/** 按路径取一个值的区间。路径不存在时报错，课程里写错路径会立刻发现。 */
export function spanOf(json: JsonBytes, path: string): JsonSpan {
  const span = json.spans.find((item) => item.path === path);
  if (!span) throw new Error(`JSON 里没有 ${path}`);
  return span;
}

/** 某个值的直接子节点（对象成员或数组元素）。 */
export const childrenOf = (json: JsonBytes, path: string): JsonSpan[] => {
  const parent = spanOf(json, path);
  return json.spans.filter((span) => span.depth === parent.depth + 1 && span.from >= parent.valueFrom && span.to <= parent.to);
};

/** 一个值序列化后的字节数（紧凑写法）。 */
export const jsonSize = (value: unknown): number => encodeJson(value).bytes.length;
