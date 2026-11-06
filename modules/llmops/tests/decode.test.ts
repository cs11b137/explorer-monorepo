/**
 * 逐字节解码：每个写入器写出的字节和 core/ 的编码一致，字段区间正确，打码显示为 ··。
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '@explorer/llm-core/utf8';
import { callModel, detect, encodeJson, formatTraceparent, spanIdOf, traceIdOf } from '../src/core';
import { byteOffset, concept, gramBytes, httpHead, jsonBody, segmentsOf, textSpans, traceparentField, utf8Lines, wire } from '../src/decode/structures';
import { decode, FIDELITY_TEXT } from '../src/decode/writer';
import { INJECTION_ASK, NORMAL_ASK, NORMAL_REPLY, supportRequest } from '../src/lessons/scenario';

describe('HTTP 和 JSON', () => {
  const call = callModel(supportRequest(NORMAL_ASK), NORMAL_REPLY, 300);

  it('请求头：x-api-key 只露前缀，其余是未知字节，字节数不变', () => {
    const layer = httpHead('h', call.http.request, { mask: { 'x-api-key': 'sk-ant-api03-'.length } });
    expect(layer.bytes.length).toBe(call.http.request.body[0]);
    expect(layer.fields.find((f) => f.name === 'x-api-key')!.hidden).toBe(true);
    expect(layer.bytes.filter((b) => b === null).length).toBe(95);
  });

  it('请求体：顶层字段依次是 model、max_tokens、system、metadata、messages', () => {
    const json = encodeJson(call.request);
    const layer = jsonBody('b', json, { expand: ['metadata.user_id'] });
    expect(layer.bytes).toEqual(json.bytes);
    expect(layer.fields.filter((f) => !f.depth).map((f) => f.name)).toEqual(['model', 'max_tokens', 'system', 'metadata', 'messages']);
    expect(layer.fields.find((f) => f.name === 'metadata.user_id')!.depth).toBe(1);
  });
});

describe('本站加的层', () => {
  it('片段：首尾相接，重叠的区间合并', () => {
    const segs = segmentsOf('abcdefg', [{ from: 1, to: 3, label: 'R1' }, { from: 2, to: 4, label: 'R2' }, { from: 5, to: 6, label: 'R3' }]);
    expect(segs.map((s) => [s.text, s.hit])).toEqual([['a', null], ['bcd', 'R1、R2'], ['e', null], ['f', 'R3'], ['g', null]]);
  });

  it('textSpans：字节就是原文的 UTF-8，命中片段的字节区间和 UTF-16 下标换算一致', () => {
    const d = detect(INJECTION_ASK);
    const segs = segmentsOf(INJECTION_ASK, d.rules.map((h) => ({ from: h.from, to: h.to, label: h.rule.id })));
    const layer = textSpans('t', INJECTION_ASK, segs);
    expect(layer.bytes).toEqual(utf8Encode(INJECTION_ASK));
    const r2 = layer.fields.find((f) => f.name === 'R2')!;
    const hit = d.rules.find((h) => h.rule.id === 'R2')!;
    expect([r2.from, r2.to]).toEqual([byteOffset(INJECTION_ASK, hit.from), byteOffset(INJECTION_ASK, hit.to)]);
    expect(r2.to - r2.from).toBe(12);
  });

  it('gramBytes：每个片段一个字段，字节是片段的 UTF-8', () => {
    const top = detect(INJECTION_ASK).prediction.contributions.slice(0, 3);
    const layer = gramBytes('g', top);
    expect(layer.bytes).toEqual(top.flatMap((c) => utf8Encode(c.grams[0])));
    expect(layer.fields.map((f) => f.name)).toEqual(top.map((c) => c.grams[0]));
  });

  it('traceparent：55 个字节，切成 7 段', () => {
    const value = formatTraceparent({ traceId: traceIdOf(1), spanId: spanIdOf(1), flags: 1 });
    const layer = traceparentField('tp', value);
    expect(layer.bytes).toEqual(utf8Encode(value));
    expect(layer.fields.map((f) => [f.name, f.to - f.from])).toEqual([['version', 2], ['-', 1], ['trace-id', 32], ['-', 1], ['parent-id', 16], ['-', 1], ['trace-flags', 2]]);
  });

  it('文本按行；概念层没有字节；三种可信度都有说明', () => {
    expect(utf8Lines('t', 'a\n汉').fields.map((f) => [f.from, f.to])).toEqual([[0, 2], [2, 5]]);
    expect(decode(wire('x', 'mem', '示意', concept('c', [['a', 'b']]))).bytes).toHaveLength(0);
    expect(Object.keys(FIDELITY_TEXT)).toEqual(['format', 'internal', '示意']);
  });
});
