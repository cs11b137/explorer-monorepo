/**
 * 原在 CONTEXT EXPLORER 的 src/core/template.ts（那里转导出，接口不变；AGENT EXPLORER 也用）。核对过的事实见 modules/context/README.md。
 *
 * Chat template：把 system 和多轮消息展开成模型实际读到的一段文本和 token 序列。
 *
 * 用的是公开的 ChatML 写法（Qwen 系列等模型的 chat_template 用它，Hugging Face 的聊天模板文档以它为例）：
 *
 *   <|im_start|>system
 *   你是……<|im_end|>
 *   <|im_start|>user
 *   你好<|im_end|>
 *   <|im_start|>assistant
 *
 * 最后一行是「生成提示」（add_generation_prompt）：告诉模型轮到助手说话了。
 * 不同模型的模板、特殊 token 都不同，Claude 的模板不公开，所以检查器里标 internal：真实但属于某个实现。
 *
 * 本站的两处写法（不是任何模型的原样）：
 *   - 一轮里有多个内容块时，块之间用一个空行隔开；
 *   - 工具定义放在 system 这一轮的最前面，写成 <tools> 包起来的 JSON，每个工具一行；
 *     工具调用写成 <tool_call> 包起来的 JSON，工具结果写成 <tool_response>。这三个标签借自 Qwen2.5 的模板。
 *   工具放在最前面是为了和 Anthropic 文档里的缓存渲染顺序（tools → system → messages）一致。
 */
import { utf8ByteLength, utf8Encode } from './utf8';
import { encodeJson } from './json';
import { encodeWithSpecials, tokenBytes } from './tokens';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatPart {
  text: string;
  /** 这段内容来自请求的哪里，比如 system、tools、messages[0].content[1]。按它汇总每部分的 token 数。 */
  source: string;
}

export interface ChatTurn {
  role: ChatRole;
  parts: ChatPart[];
}

/**
 * 渲染出的一段：
 * - special：<|im_start|>、<|im_end|>
 * - header：角色名和它后面的换行
 * - content：真正的内容（有 source）
 * - separator：块之间的空行、每轮末尾的换行
 * - prompt：生成提示 <|im_start|>assistant 和换行
 */
export type PieceKind = 'special' | 'header' | 'content' | 'separator' | 'prompt';

export interface Piece {
  kind: PieceKind;
  /** 第几轮；生成提示算作最后一轮之后的一轮。 */
  turn: number;
  role: ChatRole;
  source?: string;
  text: string;
  /** 在整段文本里的 UTF-8 字节区间。 */
  from: number;
  to: number;
  /** 起点落在这一段里的 token 数。 */
  tokens: number;
  /** 这些 token 在 ids 里的下标区间。 */
  ids: [number, number];
}

export interface RenderedPrompt {
  template: 'chatml';
  text: string;
  bytes: number[];
  ids: number[];
  pieces: Piece[];
  /** 总 token 数。 */
  tokens: number;
  /** 每个 source 的 token 数（只算 content）。 */
  bySource: Record<string, number>;
  /** 模板自己带来的 token：特殊 token、角色名、换行、生成提示。 */
  overhead: number;
}

export interface TemplateOptions {
  /** 末尾加上 <|im_start|>assistant 和换行，默认 true。 */
  generationPrompt?: boolean;
}

/** 按 ChatML 渲染，再整段编码，把每个 token 归到它第一个字节所在的那一段。 */
export function renderChatML(turns: readonly ChatTurn[], options: TemplateOptions = {}): RenderedPrompt {
  const raw: Array<Omit<Piece, 'from' | 'to' | 'tokens' | 'ids'>> = [];
  turns.forEach((turn, index) => {
    raw.push({ kind: 'special', turn: index, role: turn.role, text: '<|im_start|>' });
    raw.push({ kind: 'header', turn: index, role: turn.role, text: `${turn.role}\n` });
    turn.parts.forEach((part, j) => {
      if (j) raw.push({ kind: 'separator', turn: index, role: turn.role, text: '\n\n' });
      raw.push({ kind: 'content', turn: index, role: turn.role, source: part.source, text: part.text });
    });
    raw.push({ kind: 'special', turn: index, role: turn.role, text: '<|im_end|>' });
    raw.push({ kind: 'separator', turn: index, role: turn.role, text: '\n' });
  });
  if (options.generationPrompt ?? true) {
    raw.push({ kind: 'prompt', turn: turns.length, role: 'assistant', text: '<|im_start|>' });
    raw.push({ kind: 'prompt', turn: turns.length, role: 'assistant', text: 'assistant\n' });
  }
  const text = raw.map((piece) => piece.text).join('');
  const ids = encodeWithSpecials(text);
  let at = 0;
  const pieces: Piece[] = raw.filter((piece) => piece.text).map((piece) => {
    const from = at;
    at += utf8ByteLength(piece.text);
    return { ...piece, from, to: at, tokens: 0, ids: [0, 0] };
  });
  // 每个 token 的起始字节。特殊 token 的字节就是它的字面文字，所以偏移和文本对得上。
  let byte = 0;
  let p = 0;
  ids.forEach((id, index) => {
    while (p < pieces.length - 1 && byte >= pieces[p].to) p++;
    const piece = pieces[p];
    if (piece.tokens === 0) piece.ids = [index, index];
    piece.tokens++;
    piece.ids[1] = index + 1;
    byte += tokenBytes(id).length;
  });
  if (byte !== at) throw new Error(`模板编码后的字节数 ${byte} 和文本 ${at} 不一致`);
  const bySource: Record<string, number> = {};
  let overhead = 0;
  for (const piece of pieces) {
    if (piece.kind === 'content' && piece.source) bySource[piece.source] = (bySource[piece.source] ?? 0) + piece.tokens;
    else overhead += piece.tokens;
  }
  return { template: 'chatml', text, bytes: utf8Encode(text), ids, pieces, tokens: ids.length, bySource, overhead };
}

// ---------- 从 API 请求得到对话轮 ----------

/** 和 Anthropic Messages API 的内容块同形的最小类型，避免 template 依赖 anthropic.ts。 */
interface BlockLike {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string | Array<{ type: string; text?: string }>;
}

interface RequestLike {
  system?: string | Array<{ type: string; text: string }>;
  tools?: ReadonlyArray<{ name: string; description?: string; input_schema: unknown }>;
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string | readonly BlockLike[] }>;
}

/** 工具定义在模板里的写法（本站的写法，借自 Qwen2.5）：每个工具一行紧凑 JSON。 */
export function toolsText(tools: NonNullable<RequestLike['tools']>): string {
  const lines = tools.map((tool) => encodeJson({ name: tool.name, description: tool.description, input_schema: tool.input_schema }).text);
  return `# Tools\n<tools>\n${lines.join('\n')}\n</tools>`;
}

/** 一个内容块在模板里的文字。 */
export function blockText(block: BlockLike): string {
  if (block.type === 'text') return block.text ?? '';
  if (block.type === 'tool_use') return `<tool_call>\n${encodeJson({ name: block.name, arguments: block.input }).text}\n</tool_call>`;
  if (block.type === 'tool_result') {
    const content = typeof block.content === 'string' ? block.content : (block.content ?? []).map((item) => item.text ?? '').join('\n');
    return `<tool_response>\n${content}\n</tool_response>`;
  }
  throw new Error(`模板不支持内容块 ${block.type}`);
}

/**
 * Messages API 请求 → 对话轮：tools 和 system 合成第一轮，之后每条消息一轮。
 * 相邻的同角色消息合并成一轮：Messages API 文档说连续的 user 或 assistant 消息会被合并成一轮。
 */
export function turnsOf(request: RequestLike): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const system: ChatPart[] = [];
  if (request.tools?.length) system.push({ text: toolsText(request.tools), source: 'tools' });
  if (typeof request.system === 'string') {
    if (request.system) system.push({ text: request.system, source: 'system' });
  } else if (request.system) {
    request.system.forEach((block, i) => system.push({ text: block.text, source: `system[${i}]` }));
  }
  if (system.length) turns.push({ role: 'system', parts: system });
  request.messages.forEach((message, i) => {
    const parts: ChatPart[] = typeof message.content === 'string'
      ? [{ text: message.content, source: `messages[${i}].content` }]
      : message.content.map((block, j) => ({ text: blockText(block), source: `messages[${i}].content[${j}]` }));
    const last = turns[turns.length - 1];
    if (last && last.role === message.role) last.parts.push(...parts);
    else turns.push({ role: message.role, parts });
  });
  return turns;
}

/** 请求展开后的提示。末尾带生成提示：模型从这里开始写。 */
export const renderRequest = (request: RequestLike, options: TemplateOptions = {}): RenderedPrompt => renderChatML(turnsOf(request), options);

/** 按前缀汇总：source 以 prefix 开头的 content token 数之和，比如 'messages[0]'、'system'。 */
export function tokensUnder(prompt: RenderedPrompt, prefix: string): number {
  let sum = 0;
  for (const [source, tokens] of Object.entries(prompt.bySource)) if (source === prefix || source.startsWith(`${prefix}.`) || source.startsWith(`${prefix}[`)) sum += tokens;
  return sum;
}
