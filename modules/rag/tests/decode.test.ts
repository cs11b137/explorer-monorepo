/**
 * 逐字节解码：每个写入器写出的字节和 core/ 的编码一致，字段区间正确，打码显示为 ··。
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '@explorer/llm-core/utf8';
import { base64Encode, buildPrompt, embeddingsHttpRequest, encodeJson, f16VectorBytes, f32VectorBytes, fixedChunks, paragraphById, PARAGRAPH_VECTORS, pqEncode, quantizeInt8, trainPq, type Vec } from '../src/core';
import { base64Text, chunkBytes, concept, floatVector, httpHead, int8Vector, jsonBody, pqCodes, promptParts, tokenIds, utf8Lines, utf8Text, wire } from '../src/decode/structures';
import { decode, FIDELITY_TEXT } from '../src/decode/writer';

const v = PARAGRAPH_VECTORS[0] as Vec;

describe('向量', () => {
  it('float32 / float16：字节和 core 的编码一致，每个分量一个字段', () => {
    const f32 = floatVector('v', v, 'f32');
    expect(f32.bytes).toEqual(f32VectorBytes(v));
    expect(f32.fields).toHaveLength(16);
    expect(f32.fields[1]).toMatchObject({ from: 4, to: 8 });
    expect(floatVector('v', v, 'f16').bytes).toEqual(f16VectorBytes(v));
    const bits = floatVector('v', [1], 'f32', { bits: true });
    expect(bits.bytes).toEqual([0, 0, 0x80, 0x3f]);
    expect(bits.words).toHaveLength(1);
  });

  it('int8：4 字节 float32 缩放系数 + 每个分量 1 字节', () => {
    const q = quantizeInt8(v);
    const layer = int8Vector('v', q);
    expect(layer.bytes.length).toBe(4 + 16);
    expect(layer.bytes.slice(4)).toEqual(q.codes.map((c) => c & 0xff));
  });

  it('PQ 码：M 个 uint8', () => {
    const cb = trainPq(PARAGRAPH_VECTORS as Vec[], 4, 8, { seed: 1 });
    const codes = pqEncode(cb, v);
    expect(pqCodes('code', codes, cb).bytes).toEqual(codes);
  });

  it('base64：字节是 base64 字符本身（ASCII），每 4 个字符一个字段', () => {
    const bytes = f32VectorBytes(v);
    const text = base64Encode(bytes);
    const layer = base64Text('b64', text, bytes);
    expect(layer.bytes).toEqual([...text].map((c) => c.charCodeAt(0)));
    expect(layer.fields).toHaveLength(Math.ceil(text.length / 4));
    expect(layer.fields.at(-1)!.value.split(' ').length).toBe(bytes.length % 3 || 3);
  });
});

describe('文本、块、提示', () => {
  it('UTF-8：每个汉字 3 个字节，拆出首字节和续字节', () => {
    const layer = utf8Text('t', '杯a');
    expect(layer.bytes).toEqual(utf8Encode('杯a'));
    expect(layer.fields.filter((f) => !f.depth)).toHaveLength(2);
    expect(layer.fields.filter((f) => f.depth)).toHaveLength(3);
    expect(utf8Lines('t', 'a\n汉').fields.map((f) => [f.from, f.to])).toEqual([[0, 2], [2, 5]]);
  });

  it('切块：整篇一个字段，每块是子字段（可以重叠），区间是字节区间', () => {
    const text = paragraphById('refund#0').text;
    const chunks = fixedChunks(text, 12, 4);
    const layer = chunkBytes('doc', text, chunks);
    expect(layer.bytes).toEqual(utf8Encode(text));
    const subs = layer.fields.filter((f) => f.depth);
    expect(subs.map((f) => [f.from, f.to])).toEqual(chunks.map((c) => [c.byteFrom, c.byteTo]));
  });

  it('提示：每部分一个字段，拼起来就是整段提示的 UTF-8', () => {
    const prompt = buildPrompt('多久到账？', [paragraphById('refund#0')]);
    const layer = promptParts('p', prompt);
    expect(layer.bytes).toEqual(utf8Encode(prompt.text));
    expect(layer.fields).toHaveLength(prompt.parts.length);
  });

  it('token id：int32 小端', () => {
    expect(tokenIds('ids', [300]).bytes).toEqual([0x2c, 0x01, 0, 0]);
  });
});

describe('HTTP 和 JSON', () => {
  it('请求头的密钥打码，字节数不变', () => {
    const { layout } = embeddingsHttpRequest({ input: 'x', model: 'm' });
    const layer = httpHead('头', layout, { mask: { authorization: 'Bearer sk-proj-'.length } });
    expect(layer.bytes.length).toBe(layout.body[0]);
    const auth = layer.fields.find((f) => f.name === 'authorization')!;
    expect(auth.hidden).toBe(true);
    expect(layer.bytes.slice(auth.from, auth.to).filter((b) => b === null).length).toBe(48);
  });

  it('JSON：顶层字段覆盖键到值，展开的路径是子字段', () => {
    const json = encodeJson({ input: ['a', 'b'], model: 'm' });
    const layer = jsonBody('体', json, { expand: ['input[1]'] });
    expect(layer.bytes).toEqual(json.bytes);
    expect(layer.fields.filter((f) => !f.depth).map((f) => f.name)).toEqual(['input', 'model']);
    expect(layer.fields.find((f) => f.depth)!.name).toBe('input[1]');
  });
});

describe('解码结构', () => {
  it('多层拼接，示意结构没有字节，三种可信度都有说明', () => {
    const frame = decode(wire('x', 'mem', 'format', utf8Lines('a', 'ab'), concept('c', [['k', 'v']])));
    expect(frame.bytes).toEqual([0x61, 0x62]);
    expect(decode(wire('x', 'vals', '示意', concept('c', [['a', '1']]))).bytes).toEqual([]);
    expect(Object.keys(FIDELITY_TEXT).sort()).toEqual(['format', 'internal', '示意'].sort());
  });
});
