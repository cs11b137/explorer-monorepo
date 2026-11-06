/**
 * 文案和计算结果对得上（接口组）。
 * 课程文案里的数字尽量从计算结果取值，这里核对两类东西：
 * 1. 取值之后的文字是否还等于手算结果（防止取错字段），关键的数写死在这里，改了输入会立刻报错；
 * 2. 文字里没法取值的说法，比如「每个汉字 3 个字节」「迷你词表里没有 system 这些词」「写比读贵」。
 *
 * 每加一节课，在对应组的 narrative.<组>.test.ts 里加一个 describe（messages 在这里）。
 */
import { describe, expect, it } from 'vitest';
import { encodeText, encodeWithSpecials, formatUsd, PRICES } from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { body, breakdown, cost, httpRequest, httpResponse, message, MESSAGE_ID, numbers, QUESTION, REPLY, REQUEST, REQUEST_ID, SYSTEM } from '../src/lessons/messages';
import { utf8Encode } from '@explorer/llm-core/utf8';

const lesson = LESSON_BY_ID.messages;
const factsOf = (step: number) => Object.fromEntries(lesson.steps[step].facts);
const stepOf = (step: number) => lesson.steps[step];
const enc = (text: string) => new TextEncoder().encode(text).length;

describe('一次 Messages API 调用', () => {
  it('请求体：和 JSON.stringify 的字节数一致，中文每字 3 字节', () => {
    expect(numbers.bodyBytes).toBe(enc(JSON.stringify(REQUEST)));
    expect(numbers.bodyBytes).toBe(168);
    expect(stepOf(0).desc).toBe('4 个参数，序列化成 168 字节 JSON');
    expect(Object.keys(REQUEST)).toHaveLength(4);
    for (const char of SYSTEM.replace(/[，。]/g, '')) expect(utf8Encode(char), char).toHaveLength(3);
    // system 的值连引号：17 个字符，都是 3 字节的汉字或全角标点，加 2 个引号。
    expect(factsOf(0).system).toBe(`17 个字符，${17 * 3 + 2} 字节（含引号）`);
  });

  it('HTTP 请求：请求行 + 5 个头 + 空行 + 请求体，content-length 等于请求体字节数', () => {
    const expectedHead = [
      'POST /v1/messages HTTP/1.1\r\n',
      'host: api.anthropic.com\r\n',
      'content-type: application/json\r\n',
      'anthropic-version: 2026-10-21\r\n',
      `x-api-key: sk-ant-api03-${'x'.repeat(95)}\r\n`,
      'content-length: 168\r\n',
      '\r\n',
    ].join('');
    expect(numbers.headBytes).toBe(enc(expectedHead));
    expect(httpRequest.bytes).toEqual([...utf8Encode(expectedHead), ...body.bytes]);
    expect(numbers).toMatchObject({ headers: 5, contentLength: 168, headBytes: 260, requestBytes: 428, keyLength: 108 });
    expect(stepOf(1).desc).toBe('5 个头 + 空行 + 请求体，共 428 字节');
    expect(stepOf(1).detail).toContain('（示例长度 108 个字符，这里打码）');
    expect(stepOf(1).detail).toContain('请求体字节数 168');
  });

  it('TLS 记录：5 字节头 + 明文 + 1 字节内容类型 + 16 字节标签', () => {
    expect(numbers.tlsRequest).toBe(5 + 428 + 1 + 16);
    expect(numbers.tlsRequest).toBe(450);
    expect(stepOf(2).desc).toBe('加密成 450 字节，API 解密、校验');
    expect(stepOf(2).detail).toContain('5 字节的记录头和 445 字节密文');
    expect(numbers.tlsResponse).toBe(5 + numbers.responseBytes + 17);
  });

  it('input_tokens = system + 问题 + 模板，等于整段 ChatML 文本的编码长度', () => {
    const text = `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n${QUESTION}<|im_end|>\n<|im_start|>assistant\n`;
    expect(breakdown.prompt.text).toBe(text);
    expect(numbers.input).toBe(encodeWithSpecials(text).length);
    expect(numbers.system).toBe(encodeText(SYSTEM).length);
    expect(numbers.user).toBe(encodeText(QUESTION).length);
    expect(numbers.system + numbers.user + numbers.template).toBe(numbers.input);
    expect([numbers.system, numbers.user, numbers.template, numbers.input]).toEqual([37, 13, 28, 78]);
    expect(stepOf(3).desc).toBe('input_tokens = 37 + 13 + 28 = 78');
    expect(message.usage.input_tokens).toBe(78);
  });

  it('「迷你词表里没有 system、assistant 这些词，所以模板开销被放大了」', () => {
    expect(encodeText('system').length).toBeGreaterThan(1);
    expect(encodeText('assistant').length).toBeGreaterThan(1);
    // 模板开销里，四个特殊 token 各 1 个，其余是角色名和换行。
    expect(breakdown.prompt.pieces.filter((piece) => piece.kind === 'special' || (piece.kind === 'prompt' && piece.text === '<|im_start|>')).map((piece) => piece.tokens)).toEqual([1, 1, 1, 1, 1]);
    expect(stepOf(3).detail).toContain('Claude Opus 5.5 是 286 个 token');
  });

  it('回复：示例文字，真实计数；自然停下是 end_turn；request-id 一致', () => {
    const text = (REPLY[0] as { text: string }).text;
    expect(numbers.output).toBe(encodeText(text).length);
    expect(numbers.output).toBe(54);
    expect(numbers.replyChars).toBe([...text].length);
    expect(message.stop_reason).toBe('end_turn');
    expect(numbers.output).toBeLessThan(REQUEST.max_tokens);
    expect(message.id).toBe(MESSAGE_ID);
    expect(httpResponse.headers.find((header) => header.name === 'request-id')!.value).toBe(REQUEST_ID);
    expect(REQUEST_ID).toMatch(/^req_011C/);
    expect(numbers.responseBody).toBe(enc(JSON.stringify(message)));
    expect(numbers.responseBytes).toBe(630);
    expect(stepOf(4).desc).toBe(`54 个输出 token，响应 ${numbers.responseBytes} 字节`);
    expect(factsOf(4).stop_reason).toBe('end_turn');
  });

  it('费用：78 × $4 + 54 × $20（每百万 token），输出单价是输入的 5 倍', () => {
    expect(cost.input).toBe(78 * 4000);
    expect(cost.output).toBe(54 * 20000);
    expect(formatUsd(cost.total)).toBe('$0.00139');
    expect(PRICES['claude-opus-5-5'].output / PRICES['claude-opus-5-5'].input).toBe(5);
    expect(stepOf(5).detail).toContain('输出单价是输入的 5 倍');
    expect(stepOf(5).detail).toContain('$0.000312 + $0.00108 = $0.00139');
    expect(stepOf(5).desc).toBe('输入 78 + 输出 54 token，$0.00139');
  });

  it('概览和总结里的数字', () => {
    expect(lesson.overview.description).toContain('168 字节的 JSON 请求体、428 字节的 HTTP 请求、加密后 450 字节的 TLS 记录');
    expect(lesson.overview.description).toContain(`模型读到的 78 个 token，回复变成 ${numbers.responseBytes} 字节的响应`);
    expect(lesson.outro.desc).toBe(`428 字节进，${numbers.responseBytes} 字节出`);
    expect(Object.fromEntries(lesson.overview.facts).版本头).toBe('anthropic-version: 2026-10-21');
  });
});
