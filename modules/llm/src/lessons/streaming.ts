/**
 * 第十四课：停止条件与流式输出。逐 token 解码，一个汉字的 3 个字节跨了几个 token，用 Utf8Stream 缓住没收齐的字节；
 * 服务端把收齐的文字包成 SSE 帧推给客户端；三种停法对应三种 finish_reason。
 * 文案里的数字全部取自下面导出的计算结果，tests/narrative.sample.test.ts 核对。
 */
import { tokenIds, utf8Text, wire } from '../decode/structures';
import { LayerWriter } from '../decode/writer';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { hex2, utf8Decode, utf8Encode, Utf8Stream } from '@explorer/llm-core/utf8';
import { shortLabel } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { labelBelow, sampledRun } from './sample-common';
import type { DsCell, GridPrim, Lesson, LessonEvent, PacketEvent, RowPrim } from './types';

const T = TOKENIZER;

export const PROMPT = 'the ';
export const MODEL_NAME = 'mini-llm';
export const MAX_TOKENS = 16;
export const STOP = '。';
/// 第三种停法用的 max_tokens：故意卡在一个汉字的中间。
export const SHORT_LIMIT = 4;

const promptIds = T.encode(PROMPT);
/** 贪心生成：这条路径上有一个被拆成三个 token 的汉字。 */
export const run = sampledRun(promptIds, { temperature: 0 }, null, MAX_TOKENS, false);
const tokens = run.tokens;

// ---------- 流式解码 ----------

export interface Piece {
  id: number;
  bytes: number[];
  /** 单独解码这个 token 的结果（朴素做法）。 */
  naive: string;
  /** 喂进 Utf8Stream 之后吐出的文字。 */
  out: string;
  /** 喂进去之后还扣在里面的字节。 */
  pending: number[];
}

function pieces(ids: readonly number[]): Piece[] {
  const stream = new Utf8Stream();
  return ids.map((id) => {
    const bytes = T.bytesOf(id);
    const out = stream.push(bytes);
    return { id, bytes, naive: utf8Decode(bytes), out, pending: [...stream.pending] };
  });
}
export const parts = pieces(tokens);
/** 有多少个 token 的字节没能单独成字。 */
export const brokenNaive = parts.filter((part) => part.naive.includes('�')).length;
/** 逐 token 吐出的文字拼起来，等于一次性解码。 */
export const streamed = parts.map((part) => part.out).join('');
/** 被拆开的汉字：每个汉字占几个 token。 */
export const charSpans = (() => {
  const spans: Array<{ char: string; tokens: number }> = [];
  let count = 0;
  for (const part of parts) {
    count++;
    if (!part.out) continue;
    [...part.out].forEach((char, i) => spans.push({ char, tokens: i === 0 ? count : 0 }));
    count = 0;
  }
  return spans;
})();
/** 汉字「读」的 3 个字节在迷你分词器里分成几个 token：证明跨 token 不是个别现象。 */
export const splitExample = (() => {
  const ids = T.encode('读');
  return { char: '读', ids, labels: ids.map((id) => T.label(id)) };
})();

// ---------- 三种停法 ----------

export type FinishReason = 'stop' | 'length';

export interface Served {
  name: string;
  /** 请求里的限制。 */
  request: string;
  /** 本次推理用了几步（含结束符那一步）。 */
  steps: number;
  /** 推给客户端的文字（每个 delta 一项，空串表示这一步没东西可推）。 */
  deltas: string[];
  text: string;
  finish: FinishReason;
  /** 结束时还扣着的字节。 */
  pending: number[];
  /** 触发的是什么：结束符、stop 序列、max_tokens。 */
  cause: 'eos' | 'stop' | 'max_tokens';
}

function serve(name: string, request: string, options: { maxTokens: number; stop?: string }): Served {
  const stream = new Utf8Stream();
  const deltas: string[] = [];
  let text = '';
  let steps = 0;
  for (const id of tokens) {
    steps++;
    const out = stream.push(T.bytesOf(id));
    text += out;
    deltas.push(out);
    if (options.stop && text.endsWith(options.stop)) {
      deltas[deltas.length - 1] = out.slice(0, out.length - options.stop.length);
      return { name, request, steps, deltas, text: text.slice(0, -options.stop.length), finish: 'stop', pending: [...stream.pending], cause: 'stop' };
    }
    if (steps >= options.maxTokens) return { name, request, steps, deltas, text, finish: 'length', pending: [...stream.pending], cause: 'max_tokens' };
  }
  // 模型自己写出了结束符：这一步也要推理一次，但没有文字。
  return { name, request, steps: steps + 1, deltas, text, finish: 'stop', pending: [...stream.pending], cause: 'eos' };
}

export const byEos = serve('结束符', `max_tokens=${MAX_TOKENS}`, { maxTokens: MAX_TOKENS });
export const byStop = serve('stop 序列', `stop=["${STOP}"]`, { maxTokens: MAX_TOKENS, stop: STOP });
export const byLength = serve('max_tokens', `max_tokens=${SHORT_LIMIT}`, { maxTokens: SHORT_LIMIT });
export const served = [byEos, byStop, byLength];
/** max_tokens 把输出卡在字符中间时，flush 吐出的字符。 */
export const flushed = (() => {
  const stream = new Utf8Stream();
  for (const id of tokens.slice(0, SHORT_LIMIT)) stream.push(T.bytesOf(id));
  return stream.flush();
})();

// ---------- SSE 帧 ----------

const chunkJson = (delta: Record<string, string>, finish: FinishReason | null) =>
  JSON.stringify({ id: 'chatcmpl-example', object: 'chat.completion.chunk', created: 1700000000, model: MODEL_NAME, choices: [{ index: 0, delta, finish_reason: finish }] });

export interface Frame {
  name: string;
  /** data: 后面的内容。 */
  data: string;
  /** 这一帧在讲什么。 */
  note: string;
}

const frameOf = (delta: Record<string, string>, finish: FinishReason | null, label: string, comment: string): Frame => ({ name: label, data: chunkJson(delta, finish), note: comment });
/** 整个 EOS 路径的帧序列：角色帧、每段文字一帧、结束帧、[DONE]。 */
export const frames: Frame[] = [
  frameOf({ role: 'assistant', content: '' }, null, '角色帧', '第一帧只带 role，内容为空'),
  ...byEos.deltas.flatMap((delta, i) => (delta ? [frameOf({ content: delta }, null, `「${delta}」`, `第 ${i + 1} 个 token 收齐了一个字符`)] : [])),
  frameOf({}, byEos.finish, '结束帧', `delta 为空，finish_reason 是 "${byEos.finish}"`),
  { name: '[DONE]', data: '[DONE]', note: '约定的流结束标记，不是 JSON' },
];
export const frameBytes = (frame: Frame) => utf8Encode(`data: ${frame.data}\n\n`);

let serial = 0;
/** 一帧 SSE：字段名 data、冒号加空格、JSON、两个换行（空行）。字节就是服务端写进 TCP 的内容。 */
function sseLayer(frame: Frame, color: 'blue' | 'green' | 'amber' = 'green'): LayerWriter {
  const layer = new LayerWriter(`st${serial++}`, `text/event-stream · ${frameBytes(frame).length} 字节`, color, 'SSE：一个事件以空行结束');
  layer.field('data: · +0', 'data: ', () => layer.raw(utf8Encode('data: ')), { note: 'SSE 的字段名 data，冒号和一个空格；一个事件可以有多行 data。' });
  layer.field('payload · +6', frame.data.length > 40 ? `${frame.data.slice(0, 38)}…` : frame.data, () => layer.raw(utf8Encode(frame.data)), { note: frame.note, example: frame.data.includes('chatcmpl-example') });
  layer.field('\\n\\n · 结尾', '空行', () => layer.raw([0x0a, 0x0a]), { note: '一个换行结束这一行，再一个换行（空行）结束整个事件，客户端此时才触发 onmessage。' });
  return layer;
}

// ---------- 图元 ----------

const tokenRow = (done: number): RowPrim => ({
  kind: 'row',
  id: 't',
  w: 34,
  cells: Array.from({ length: tokens.length + 1 }, (_, i): DsCell => {
    if (i >= done) return { v: '', tone: 'empty' };
    if (i === tokens.length) return { v: '结束', tone: 'blue', sub: 'eos' };
    return { v: shortLabel(tokens[i], 3), tone: parts[i].bytes.length === 1 && parts[i].bytes[0] >= 0x80 ? 'amber' : 'violet', sub: String(tokens[i]) };
  }),
});

const decodeGrid = (done: number): GridPrim => ({
  kind: 'grid',
  id: 'g',
  w: 34,
  rows: parts.map((_, i) => `token ${i + 1}`),
  cols: ['字节', '单独解码', '流式解码'],
  cells: parts.map((part, i): DsCell[] =>
    i < done
      ? [
          { v: part.bytes.map(hex2).join(' '), tone: 'violet' },
          { v: part.naive.includes('�') ? '�' : part.naive, tone: part.naive.includes('�') ? 'amber' : undefined },
          { v: part.out || '…', tone: part.out ? 'green' : 'dim' },
        ]
      : [{ v: '', tone: 'empty' }, { v: '', tone: 'empty' }, { v: '', tone: 'empty' }],
  ),
});

const receivedRow = (count: number): RowPrim => {
  const chars = [...byEos.text].slice(0, count);
  return { kind: 'row', id: 'r', w: 44, cells: chars.map((char): DsCell => ({ v: char, tone: 'green' })), marks: chars.length ? [{ at: chars.length - 1, text: '已显示', color: 'green' }] : undefined };
};

const finishGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'f',
  w: 60,
  rows: served.map((item) => item.name),
  cols: ['步数', 'finish_reason', '文字'],
  cells: served.map((item): DsCell[] => [
    { v: String(item.steps) },
    { v: item.finish, tone: item.finish === 'length' ? 'amber' : 'green' },
    { v: item.text || '空', tone: item.pending.length ? 'amber' : undefined },
  ]),
});

const ops = run.prefillFlops + run.decodeFlops;
const bytesText = (bytes: readonly number[]) => bytes.map(hex2).join(' ');
const requestJson = JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'user', content: PROMPT }], stream: true, max_tokens: MAX_TOKENS });
const firstSplit = parts.findIndex((part) => part.pending.length > 0);
const firstChar = charSpans[0];

/** 一帧从服务端推到客户端的事件。 */
const framePacket = (frame: Frame, index: number, shown: number): PacketEvent =>
  pk('server', 'client', frame.name === '[DONE]' ? 'slate' : frame.name === '结束帧' ? 'amber' : 'green', frame.name, [`data: ${frame.data.length > 26 ? `${frame.data.slice(0, 24)}…` : frame.data}`], [ops, 'STREAM', `第 ${index + 1} 帧：${frame.note}`, frameBytes(frame).length],
    wire(`SSE 第 ${index + 1} 帧`, 'mem', 'format', sseLayer(frame, frame.name === '结束帧' ? 'amber' : 'green')), { ds: { out: [receivedRow(shown)] } });

const textFrames = frames.filter((frame) => frame.name.startsWith('「'));
const textDeltaPacket = (frame: Frame, shown: number): PacketEvent => {
  const char = frame.name.slice(1, -1);
  return pk('detok', 'server', 'violet', `文字 ${char}`, [`「${char}」`], [ops, 'TEXT', `收齐了一个字符「${char}」，交给服务端打包`, utf8Encode(char).length],
    wire('detok 吐出的文字', 'mem', 'format', utf8Text('delta', char, { color: 'violet' })), { ds: { out: [receivedRow(shown - 1)] } });
};

export const streaming: Lesson = labelBelow(
  {
    id: 'streaming',
    name: 'STREAMING',
    title: '停止条件与流式输出',
    group: 'sample',
    layer: [1, 7],
    layerNote: '从字节拼成文字，到服务端用 SSE 推给客户端，再到 API 返回的 finish_reason。',
    opsUnit: 'FLOPs：提示词预填充一次，之后每个生成的 token 一次解码；解码文字、打包 SSE 帧不计入',
    opsShort: 'FLOPs',
    nodes: ['client', 'server', 'sampler', 'tokens', 'detok', 'out'],
    place: { client: [110, 90], server: [400, 90], sampler: [690, 90], tokens: [730, 340], detok: [440, 340], out: [160, 400] },
    labels: {
      client: ['应用', 'stream=true，边收边显示'],
      server: ['推理服务', 'POST /v1/chat/completions'],
      sampler: ['采样器', '贪心，一次一个 token'],
      tokens: ['生成的 token', '每个 token 对应一段字节'],
      detok: ['反分词', 'Utf8Stream：缓住半个字符'],
      out: ['解码与显示', '字节 → 文字 → 屏幕'],
    },
    radius: { tokens: 50, out: 50 },
    initial: { tokens: [], out: [] },
    start: ['client', 'server', 'sampler'],
    legend: [['violet', 'token 的字节'], ['amber', '半个字符 / 提前停'], ['green', '已经可以显示的文字'], [null, '运算量：前向的 FLOPs']],
    overview: {
      full: '半个汉字不能显示，什么时候停也有三种',
      description: `API 的 stream=true 让模型每生成一点就推给客户端。可是 token 是按字节切的，一个汉字的 3 个字节可能分在好几个 token 里，单独解码会得到乱码。这一课用迷你模型真实生成「${PROMPT}」的续写，看反分词怎样缓住没收齐的字节、服务端怎样把文字打成 SSE 帧；最后对比三种停法：写出结束符、碰到 stop 序列、达到 max_tokens。`,
      facts: [
        ['提示词', `「${PROMPT}」`],
        ['生成', `${tokens.length} 个 token，再加一个结束符`],
        ['文字', `「${streamed}」`],
        ['传输', 'HTTP + SSE（text/event-stream）'],
        ['停法', '结束符 / stop 序列 / max_tokens'],
        ['运算量', 'FLOPs（前向）'],
      ],
    },
    steps: [
      {
        title: '请求：stream=true 和停止条件',
        desc: `max_tokens=${MAX_TOKENS}，服务端边生成边推`,
        detail: `请求体里 "stream": true 让服务端不要等整段写完再回，而是每生成一点就推一次，响应头是 Content-Type: text/event-stream。"max_tokens" 是生成长度的上限，可选的 "stop" 是一串停止序列。服务端把提示词交给推理引擎，引擎先预填充，然后每次解码一个 token。`,
        facts: [['stream', 'true'], ['max_tokens', String(MAX_TOKENS)], ['提示词', `${promptIds.length} 个 token`], ['预填充', `${run.prefillFlops} FLOPs`]],
        events: [
          type(`curl -N .../v1/chat/completions -d '{"stream":true,"max_tokens":${MAX_TOKENS},…}'`),
          pk('client', 'server', 'blue', 'POST', ['stream: true', `max_tokens: ${MAX_TOKENS}`], [0, 'HTTP', '请求体是 JSON；服务端会以 text/event-stream 回应', utf8Encode(requestJson).length],
            wire('请求体（HTTP 头略）', 'mem', 'format', utf8Text('body', requestJson, { color: 'blue', summary: '字段名沿用 OpenAI 的 chat completions' }))),
          pk('server', 'sampler', 'blue', '提示词', [`${promptIds.length} 个 token`], [run.prefillFlops, 'IDS', `「${PROMPT}」编码成 ${promptIds.length} 个 token，预填充后开始解码`, promptIds.length * 4],
            wire('交给引擎的 token id', 'mem', 'format', tokenIds('prompt', promptIds, { labels: (id) => T.label(id) }))),
        ],
      },
      {
        title: '逐个 token 解码',
        desc: `${tokens.length} 个 token 加结束符，一共 ${tokens.length + 1} 步`,
        detail: `采样器每步选一个 token，把它接到输入后面再解码下一步。这里用贪心，写出的 token 依次是 ${tokens.map((id) => T.label(id)).join(' ')}。注意前 ${firstChar.tokens} 个都是单个字节：迷你分词器没有学过「${firstChar.char}」这个字，它的 3 个字节分在 ${firstChar.tokens} 个 token 里。第 ${tokens.length + 1} 步模型写出了结束符，表示它认为话说完了。`,
        facts: [['token', tokens.map((id) => T.label(id)).join(' ')], ['步数', `${tokens.length + 1}（最后一步是结束符）`], ['解码', `${run.decodeFlops} FLOPs`]],
        events: [
          show('tokens'),
          pk('sampler', 'tokens', 'violet', `${tokens.length} 个 token`, [tokens.map((id) => T.label(id)).join(' '), '+ 结束符'], [ops, 'SAMPLE', `贪心解码 ${tokens.length + 1} 步：${tokens.map((id) => T.label(id)).join(' → ')} → ${T.label(T.eos)}`, (tokens.length + 1) * 4],
            wire('生成的 token id（最后一个是结束符）', 'mem', 'format', tokenIds('ids', [...tokens, T.eos], { color: 'violet', labels: (id) => T.label(id) })), { ds: { tokens: [tokenRow(tokens.length + 1)] } }),
          note('tokens', '橙色：单独一个字节，还不是完整的字符', 'amber'),
        ],
      },
      {
        title: '半个字符先缓着',
        desc: `单独解码有 ${brokenNaive} 个 token 是乱码，流式解码一个也没有`,
        detail: `如果把每个 token 单独解码，「${firstChar.char}」的 3 个字节 ${bytesText(parts.slice(0, firstChar.tokens).map((part) => part.bytes[0]))} 会变成 ${firstChar.tokens} 个 U+FFFD（�），共有 ${brokenNaive} 个 token 是这样。反分词器用 Utf8Stream：首字节 ${hex2(parts[0].bytes[0])} 声明这个字符占 3 个字节，在收齐之前把已有的字节存着，第 ${firstChar.tokens} 个 token 到了才吐出「${firstChar.char}」，最后拼起来是「${streamed}」，和一次性解码完全一样。分词器学过的字不一样，情况也不同：「${splitExample.char}」的前两个字节合成了一个 token，第三个字节单独一个，同样是跨 token。`,
        facts: [['「向」', `${bytesText(parts.slice(0, firstChar.tokens).map((part) => part.bytes[0]))}，分在 ${firstChar.tokens} 个 token`], ['单独解码', `${brokenNaive} 个乱码`], ['流式解码', `「${streamed}」`], ['「读」', `${splitExample.labels.join(' | ')}`]],
        events: [
          show('detok', 'out'),
          pk('tokens', 'detok', 'violet', '逐个喂入', [`${tokens.length} 个 token`], [ops, 'IDS', `逐个 token 把字节喂给 Utf8Stream；第 ${firstSplit + 1} 个 token 之后扣着 ${bytesText(parts[firstSplit].pending)}`, tokens.length * 4],
            wire('每个 token 的字节', 'mem', 'format', tokenIds('ids', tokens, { color: 'violet', labels: (id) => T.label(id) })), { ds: { tokens: [tokenRow(tokens.length)] } }),
          pk('detok', 'out', 'green', 'Utf8Stream', [`单独解码：${brokenNaive} 个乱码`, `流式：「${streamed}」`], [ops, 'TEXT', `逐 token 吐出的文字：${parts.map((part) => (part.out ? `「${part.out}」` : '·')).join(' ')}`, utf8Encode(streamed).length],
            wire('流式解码出的文字', 'mem', 'format', utf8Text('text', streamed, { color: 'green', summary: '拼起来和一次性解码相同' })), { ds: { out: [decodeGrid(tokens.length)] } }),
        ],
      },
      {
        title: 'SSE：收齐一个字就推一帧',
        desc: `${frames.length} 帧，每帧以空行结束`,
        detail: `服务端每收到反分词器吐出的一段文字，就写一个 SSE 事件：以 "data: " 开头，后面是 JSON，再加一个空行。这里的 JSON 是 OpenAI chat completions 流式响应的写法，delta.content 里就是新增的文字，还省略了 system_fingerprint 等字段，id 和 created 是示例值。第一帧只带 role，最后一帧的 delta 为空、finish_reason 说明为什么停，再以 data: [DONE] 收尾。`,
        facts: [['帧数', `${frames.length}（含角色帧、结束帧、[DONE]）`], ['文字帧', textFrames.map((frame) => frame.name).join(' ')], ['首帧大小', `${frameBytes(frames[0]).length} 字节`]],
        events: [
          framePacket(frames[0], 0, 0),
          ...textFrames.flatMap((frame, i): LessonEvent[] => [textDeltaPacket(frame, i + 1), framePacket(frame, frames.indexOf(frame), i + 1)]),
          framePacket(frames[frames.length - 2], frames.length - 2, textFrames.length),
          framePacket(frames[frames.length - 1], frames.length - 1, textFrames.length),
          render,
        ],
      },
      {
        title: '三种停法，两种 finish_reason',
        desc: `结束符和 stop 序列都是 "stop"，max_tokens 是 "length"`,
        detail: `生成什么时候停有三种原因。模型写出结束符，用了 ${byEos.steps} 步，finish_reason 是 "${byEos.finish}"；文字碰到 stop 序列「${STOP}」，用了 ${byStop.steps} 步，比等结束符少一步，序列本身不会推给客户端，finish_reason 也是 "${byStop.finish}"；达到 max_tokens=${SHORT_LIMIT}，只用了 ${byLength.steps} 步，finish_reason 是 "${byLength.finish}"。最后一种恰好卡在汉字中间，流里还扣着 ${bytesText(byLength.pending)}，flush 时本站把它变成 ${JSON.stringify(flushed)}，真实服务端怎么处理各家不同。`,
        facts: served.map((item): [string, string] => [item.name, `${item.request} → ${item.finish}，${item.steps} 步，「${item.text}」`]),
        events: [
          pk('server', 'client', 'amber', 'finish_reason', served.map((item) => `${item.name}：${item.finish}`), [ops, 'STREAM', `${served.map((item) => `${item.name} → "${item.finish}"，${item.steps} 步`).join('；')}`, frameBytes(frameOf({}, byLength.finish, '', '')).length],
            wire('max_tokens 到了：结束帧', 'mem', 'format', sseLayer(frameOf({}, byLength.finish, '结束帧', `delta 为空，finish_reason 是 "${byLength.finish}"，意思是被长度截断`), 'amber')), { ds: { out: [finishGrid()] } }),
          state('server', { 结束符: `"${byEos.finish}"`, stop序列: `"${byStop.finish}"`, max_tokens: `"${byLength.finish}"` }),
        ],
      },
    ],
    outro: {
      title: '流式只是把一次响应切碎',
      desc: '字节收齐才显示，停止原因写在最后一帧',
      text: `真实服务的流式输出和这里一样：引擎每解码一步，反分词器吐出能显示的文字，服务端打成 SSE 帧推给浏览器。停止序列是在文字上匹配的，可能横跨多个 token，所以常见的做法是把可能是停止序列开头的文字先扣着。Anthropic 的 API 用 stop_reason 区分 end_turn、stop_sequence 和 max_tokens，OpenAI 的 finish_reason 把前两种合并成 "stop"。最后一课看另一头：模型的参数是怎么来的，以及怎样只改很小一部分参数就让它学会新东西。`,
      facts: [['finish_reason', '"stop" / "length"'], ['缓住的字节', '半个字符'], ['下一课', '训练一步与 LoRA 微调']],
    },
  },
  ['tokens', 'out'],
);
