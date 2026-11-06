/**
 * 逐字节解码：每个写入器写出的字节和 core/ 的编码一致，字段区间正确，打码显示为 ··。
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '@explorer/llm-core/utf8';
import { buildRequest, encodeJson, encodeLines, encodeRequest, encodeStream, inputBreakdown, lineSpans, mcpPost, messagesHttpRequest, META, PROTOCOL_VERSION, rpcNotification, rpcRequest } from '../src/core';
import { concept, httpHead, jsonBody, promptPieces, sseBody, stdioLines, utf8Lines, wire } from '../src/decode/structures';
import { decode, FIDELITY_TEXT } from '../src/decode/writer';
import { SUPPORT, USER_ASK } from '../src/lessons/scenario';

const req = buildRequest(SUPPORT, [{ role: 'user', content: USER_ASK }]);
const meta = { [META.protocolVersion]: PROTOCOL_VERSION, [META.clientCapabilities]: {} };

describe('HTTP 和 JSON', () => {
  it('请求头：每个头一个字段，x-api-key 只露前缀，其余是未知字节；字节数不变', () => {
    const layout = encodeRequest(messagesHttpRequest(req));
    const layer = httpHead('h', layout, { mask: { 'x-api-key': 'sk-ant-api03-'.length } });
    expect(layer.bytes.length).toBe(layout.body[0]);
    const key = layer.fields.find((field) => field.name === 'x-api-key')!;
    expect(key.hidden).toBe(true);
    expect(layer.bytes.filter((byte) => byte === null).length).toBe(95);
  });

  it('请求体：顶层字段和 JSON 的字节区间对上，expand 的子字段缩进一级', () => {
    const json = encodeJson(req);
    const layer = jsonBody('b', json, { expand: ['messages[0]'] });
    expect(layer.bytes).toEqual(json.bytes);
    expect(layer.fields.filter((field) => !field.depth).map((field) => field.name)).toEqual(['model', 'max_tokens', 'system', 'tools', 'messages']);
    expect(layer.fields.find((field) => field.name === 'messages[0]')!.depth).toBe(1);
  });

  it('MCP 的 POST：头和体都按真实字节', () => {
    const layout = encodeRequest(mcpPost(rpcRequest(1, 'tools/list', { _meta: meta })));
    const head = httpHead('h', layout);
    expect(head.fields.map((field) => field.name)).toEqual(['POST /mcp HTTP/1.1', 'host', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'content-length', 'CRLF']);
  });
});

describe('stdio、SSE、文本、提示', () => {
  it('stdio：每行一个字段，行尾的 0A 是子字段', () => {
    const text = encodeLines([rpcRequest(1, 'server/discover', { _meta: meta }), rpcNotification('notifications/cancelled', { requestId: 1 })]);
    const bytes = utf8Encode(text);
    const layer = stdioLines('stdin', bytes, lineSpans(bytes));
    expect(layer.bytes).toEqual(bytes);
    const lines = layer.fields.filter((field) => !field.depth);
    expect(lines).toHaveLength(2);
    const lf = layer.fields.filter((field) => field.depth);
    expect(lf.map((field) => bytes[field.from])).toEqual([0x0a, 0x0a]);
    expect(lf.every((field) => field.to - field.from === 1)).toBe(true);
  });

  it('SSE：每个事件一个字段，data 行和结束的空行是子字段', () => {
    const stream = encodeStream([{ data: '{"a":1}' }, { data: '{"b":2}' }]);
    const layer = sseBody('s', stream);
    expect(layer.bytes).toEqual(stream.bytes);
    expect(layer.fields.filter((field) => !field.depth)).toHaveLength(2);
  });

  it('文本按行，提示按段（各段之和是总 token 数）', () => {
    expect(utf8Lines('t', 'a\n汉').fields.map((field) => [field.from, field.to])).toEqual([[0, 2], [2, 5]]);
    const prompt = inputBreakdown(req).prompt;
    const layer = promptPieces('p', prompt);
    expect(layer.bytes).toEqual(prompt.bytes);
    expect(prompt.pieces.reduce((sum, piece) => sum + piece.tokens, 0)).toBe(prompt.tokens);
  });

  it('概念层没有字节；三种可信度都有说明', () => {
    const frame = decode(wire('x', 'mem', '示意', concept('c', [['a', 'b']])));
    expect(frame.bytes).toHaveLength(0);
    expect(Object.keys(FIDELITY_TEXT)).toEqual(['format', 'internal', '示意']);
  });
});
