/**
 * 索引流水线（ingest）的前半段：原始文件 → 加载、清洗 → 切块 → 每块一条记录（元数据 + 正文），之后嵌入、写进向量库。
 *
 * - sourceFile：一篇文档在文档库里的原始文件。本站的写法是 Markdown 加 YAML 风格的 front matter（`---` 之间每行 `键: 值`），
 *   正文前有一个 `# 标题`，段落之间空一行。这是示例格式，不是某个产品的规定；真实的加载器面对的是 HTML、PDF、Word，清洗要做的事更多。
 * - loadSource：加载器的清洗：读出 front matter 里的元数据，去掉标题行和空行，段落之间只留一个换行（和 kb.ts 的 docText 相同）。
 *   loadSource(sourceFile(doc)) 还原出原来的文档（测试核对）。
 * - chunkRecords：按段落切块（paragraphChunks），每块一条记录：块 id、文档 id、标题、状态、更新日期、分类、段落序号、
 *   块在清洗后正文里的字符区间，以及块的正文。向量库按块 id 把向量和这条记录对上（向量库通常把它叫 payload 或 metadata）。
 */
import { paragraphChunks, type Chunk } from './chunk';
import { docText, KB, type Category, type DocMeta, type KbDoc } from './kb';

/** 原始文件：front matter + 标题 + 段落（空行隔开）。 */
export function sourceFile(doc: KbDoc): string {
  const front = ['---', `id: ${doc.id}`, `title: ${doc.title}`, `category: ${doc.meta.category}`, `updated: ${doc.meta.updated}`, `status: ${doc.meta.status}`, '---'];
  return `${front.join('\n')}\n\n# ${doc.title}\n\n${doc.paragraphs.join('\n\n')}\n`;
}

export interface LoadedDoc {
  doc: KbDoc;
  /** 原始文件。 */
  raw: string;
  /** 清洗后的正文：段落之间一个换行。 */
  body: string;
  /** front matter（含两行 ---）在原始文件里的字符数。 */
  frontChars: number;
  /** 去掉的标题行（含 `# `）。 */
  heading: string;
  /** 去掉的空行数。 */
  blankLines: number;
}

/** 加载器：拆出 front matter 和正文，去掉标题行和空行。 */
export function loadSource(raw: string): LoadedDoc {
  const lines = raw.split('\n');
  if (lines[0] !== '---') throw new Error('原始文件要以 --- 开头');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('front matter 没有结束的 ---');
  const fields = Object.fromEntries(lines.slice(1, end).map((line) => {
    const at = line.indexOf(': ');
    return [line.slice(0, at), line.slice(at + 2)];
  }));
  const rest = lines.slice(end + 1);
  const headingLine = rest.find((line) => line.startsWith('# ')) ?? '';
  const paragraphs = rest.filter((line) => line.trim() && line !== headingLine);
  const meta: DocMeta = { category: fields.category as Category, updated: fields.updated, status: fields.status as DocMeta['status'] };
  const doc: KbDoc = { id: fields.id, title: fields.title, meta, paragraphs };
  return {
    doc,
    raw,
    body: docText(doc),
    frontChars: [...lines.slice(0, end + 1).join('\n')].length,
    heading: headingLine,
    blankLines: rest.filter((line) => !line.trim()).length,
  };
}

/** 一块在元数据存储里的记录。 */
export interface ChunkRecord {
  /** 块 id：`文档 id#段落序号`，和 PARAGRAPHS 的 id 相同。 */
  id: string;
  doc: string;
  title: string;
  status: DocMeta['status'];
  updated: string;
  category: Category;
  /** 段落序号（从 0 开始）。 */
  para: number;
  /** 块在清洗后正文里的字符区间（码点下标，左闭右开）。 */
  from: number;
  to: number;
  text: string;
}

export interface IngestChunk extends Chunk {
  doc: string;
  id: string;
}

/** 一篇加载好的文档按段落切块，每块一条记录。 */
export function chunkRecords(loaded: LoadedDoc): { chunks: IngestChunk[]; records: ChunkRecord[] } {
  const { doc } = loaded;
  const chunks = paragraphChunks(loaded.body).map((chunk) => ({ ...chunk, doc: doc.id, id: `${doc.id}#${chunk.index}` }));
  const records = chunks.map((chunk): ChunkRecord => ({ id: chunk.id, doc: doc.id, title: doc.title, status: doc.meta.status, updated: doc.meta.updated, category: doc.meta.category, para: chunk.index, from: chunk.from, to: chunk.to, text: chunk.text }));
  return { chunks, records };
}

/** 整个知识库走一遍：原始文件、加载结果、全部块和记录（顺序和 PARAGRAPHS 一致，测试核对）。 */
export function ingestAll(docs: readonly KbDoc[] = KB): { loaded: LoadedDoc[]; chunks: IngestChunk[]; records: ChunkRecord[] } {
  const loaded = docs.map((doc) => loadSource(sourceFile(doc)));
  const parts = loaded.map(chunkRecords);
  return { loaded, chunks: parts.flatMap((part) => part.chunks), records: parts.flatMap((part) => part.records) };
}
