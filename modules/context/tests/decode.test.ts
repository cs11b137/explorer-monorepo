/**
 * 逐字节解码：每个写入器写出的字节和 core/ 的编码一致，字段区间正确，打码和密文显示为 ··。
 */
import { describe, expect, it } from 'vitest';
import { encodeJson, encodeRequest, encodeStream, makeRequest, renderChatML } from '../src/core';
import { concept, httpHead, jsonBody, promptPieces, sseBody, tlsRecord, tokenIds, utf8Lines, wire } from '../src/decode/structures';
import { decode, FIDELITY_TEXT } from '../src/decode/writer';
import { utf8Encode } from '@explorer/llm-core/utf8';

describe('HTTP 头', () => {
  const layout = encodeRequest(makeRequest('POST', '/v1/messages', [['host', 'h'], ['x-api-key', 'sk-ant-secret']], '{}'));

  it('字节和报文的头部一致，打码的部分是未知字节', () => {
    const layer = httpHead('头', layout, { mask: { 'x-api-key': 7 } });
    expect(layer.bytes.length).toBe(layout.body[0]);
    const key = layer.fields.find((field) => field.name === 'x-api-key')!;
    const bytes = layer.bytes.slice(key.from, key.to);
    // 「x-api-key: 」11 个字节 + 前 7 个字符「sk-ant-」，其余 6 个打码，最后是 CRLF。
    expect(bytes.slice(0, 18)).toEqual(utf8Encode('x-api-key: sk-ant-'));
    expect(bytes.slice(18, 24)).toEqual([null, null, null, null, null, null]);
    expect(bytes.slice(24)).toEqual([0x0d, 0x0a]);
    expect(key.hidden).toBe(true);
    expect(layer.fields.map((field) => field.name)).toEqual(['POST /v1/messages HTTP/1.1', 'host', 'x-api-key', 'content-length', 'CRLF']);
  });
});

describe('JSON 体', () => {
  const json = encodeJson({ model: 'm', messages: [{ role: 'user', content: '你好' }] });

  it('顶层字段覆盖键到值的区间，展开的路径是缩进一级的子字段', () => {
    const layer = jsonBody('体', json, { expand: ['messages[0].content'], example: ['model'] });
    expect(layer.bytes).toEqual(json.bytes);
    const top = layer.fields.filter((field) => !field.depth);
    expect(top.map((field) => [field.name, field.from, field.to])).toEqual([['model', 1, 12], ['messages', 13, json.bytes.length - 1]]);
    const sub = layer.fields.find((field) => field.depth)!;
    expect(sub.name).toBe('messages[0].content');
    expect(utf8Encode('"content":"你好"').length).toBe(sub.to - sub.from);
    expect(top[0].example).toBe(true);
  });

  it('root 指定子对象时，列出它的成员', () => {
    const usage = encodeJson({ id: 'x', usage: { input_tokens: 1, output_tokens: 2 } });
    expect(jsonBody('usage', usage, { root: 'usage' }).fields.map((field) => field.name)).toEqual(['input_tokens', 'output_tokens']);
  });
});

describe('SSE、文本、token、TLS', () => {
  it('SSE：每个事件一个字段，每一行一个子字段（event: ping↵ 12 字节，data 行 6 + 15 + 1 = 22 字节，空行 1 字节）', () => {
    const stream = encodeStream([{ event: 'ping', data: '{"type":"ping"}' }]);
    const layer = sseBody('流', stream);
    expect(layer.bytes).toEqual(stream.bytes);
    expect(layer.fields.map((field) => [field.name, field.from, field.to])).toEqual([['ping · +0', 0, 35], ['event:', 0, 12], ['data:', 12, 34], ['空行', 34, 35]]);
  });

  it('文本按行、提示按段、token id 是 int32 小端', () => {
    expect(utf8Lines('t', 'a\n汉').fields.map((field) => [field.from, field.to])).toEqual([[0, 2], [2, 5]]);
    const prompt = renderChatML([{ role: 'user', parts: [{ text: 'hi', source: 's' }] }]);
    const pieces = promptPieces('p', prompt);
    expect(pieces.bytes).toEqual(prompt.bytes);
    expect(pieces.fields).toHaveLength(prompt.pieces.length);
    expect(tokenIds('ids', [353]).bytes).toEqual([0x61, 0x01, 0, 0]);
  });

  it('TLS 1.3 记录：0x17、0x0303、大端长度 = 明文 + 1 + 16，密文显示为未知', () => {
    const layer = tlsRecord('r', 100);
    expect(layer.bytes.slice(0, 5)).toEqual([0x17, 0x03, 0x03, 0x00, 117]);
    expect(layer.bytes.length).toBe(5 + 117);
    expect(layer.bytes.slice(5).every((byte) => byte === null)).toBe(true);
    expect(() => tlsRecord('r', 16385)).toThrow();
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
