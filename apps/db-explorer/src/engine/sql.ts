/** 一个足够解析本课 SQL 的小解析器，节点名和字段名取自 PostgreSQL 的 gram.y 与 debug_print_parse 输出。 */
export interface Token {
  kind: 'keyword' | 'ident' | 'iconst' | 'op' | 'punct' | 'sconst';
  /** gram.y 里的终结符名字。 */
  token: string;
  text: string;
  from: number;
  to: number;
}

const KEYWORDS: Record<string, string> = { select: 'SELECT', from: 'FROM', where: 'WHERE', and: 'AND', order: 'ORDER', by: 'BY' };

/** scan.l 的最小子集：关键字不区分大小写，未加引号的标识符折叠成小写。 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      const text = sql.slice(start, i);
      const keyword = KEYWORDS[text.toLowerCase()];
      tokens.push(keyword ? { kind: 'keyword', token: keyword, text, from: start, to: i } : { kind: 'ident', token: 'IDENT', text: text.toLowerCase(), from: start, to: i });
    } else if (/[0-9]/.test(c)) {
      while (i < sql.length && /[0-9]/.test(sql[i])) i++;
      tokens.push({ kind: 'iconst', token: 'ICONST', text: sql.slice(start, i), from: start, to: i });
    } else if (c === "'") {
      i++;
      while (i < sql.length && sql[i] !== "'") i++;
      i++;
      tokens.push({ kind: 'sconst', token: 'SCONST', text: sql.slice(start + 1, i - 1), from: start, to: i });
    } else if ('=<>+-*/'.includes(c)) {
      i++;
      tokens.push({ kind: 'op', token: `'${c}'`, text: c, from: start, to: i });
    } else if (',;().'.includes(c)) {
      i++;
      tokens.push({ kind: 'punct', token: `'${c}'`, text: c, from: start, to: i });
    } else throw new SyntaxError(`无法识别的字符 ${c}`);
  }
  return tokens;
}

export interface TreeNode {
  name: string;
  /** 节点的主要字段。 */
  detail?: string;
  children?: TreeNode[];
  hot?: boolean;
}

export interface Parsed {
  columns: string[];
  table: string;
  where: { column: string; op: string; value: number };
  raw: TreeNode;
}

export class SqlSyntaxError extends Error {
  constructor(readonly near: string, readonly position: number) {
    super(`syntax error at or near "${near}"`);
  }
}

/** gram.y 里 simple_select 的一小部分，产出和 raw parse tree 同名的节点。 */
export function parseSelect(tokens: Token[]): Parsed {
  let at = 0;
  const peek = () => tokens[at];
  const fail = (): never => {
    const t = peek() ?? tokens[tokens.length - 1];
    throw new SqlSyntaxError(t.text, t.from + 1);
  };
  const expect = (token: string) => {
    if (peek()?.token !== token) fail();
    return tokens[at++];
  };
  expect('SELECT');
  const columns = [expect('IDENT').text];
  while (peek()?.token === "','") {
    at++;
    columns.push(expect('IDENT').text);
  }
  expect('FROM');
  const table = expect('IDENT').text;
  expect('WHERE');
  const column = expect('IDENT').text;
  const op = peek()?.kind === 'op' ? tokens[at++].text : fail();
  const value = Number(expect('ICONST').text);
  if (peek()?.token === "';'") at++;
  if (at !== tokens.length) fail();
  const raw: TreeNode = {
    name: 'SelectStmt',
    children: [
      { name: 'targetList', children: columns.map((c) => ({ name: 'ResTarget', detail: `ColumnRef "${c}"` })) },
      { name: 'fromClause', children: [{ name: 'RangeVar', detail: `relname "${table}"` }] },
      { name: 'whereClause', children: [{ name: 'A_Expr', detail: `"${op}"`, children: [{ name: 'ColumnRef', detail: `"${column}"` }, { name: 'A_Const', detail: String(value) }] }] },
    ],
  };
  return { columns, table, where: { column, op, value }, raw };
}

export interface CatalogColumn {
  name: string;
  attnum: number;
  typid: number;
  typname: string;
}

export interface CatalogTable {
  name: string;
  oid: number;
  columns: CatalogColumn[];
}

export class AnalyzeError extends Error {
  constructor(readonly code: string, message: string, readonly position: number) {
    super(message);
  }
}

/** transformSelectStmt 的最小版本：查目录，把名字换成 OID 和列号。 */
export function analyze(parsed: Parsed, tables: CatalogTable[], operators: Record<string, { opno: number; opfuncid: number; resulttype: number }>): { tree: TreeNode; vars: Array<{ column: CatalogColumn }>; rel: CatalogTable; op: { opno: number; opfuncid: number; resulttype: number } } {
  const rel = tables.find((table) => table.name === parsed.table);
  if (!rel) throw new AnalyzeError('42P01', `relation "${parsed.table}" does not exist`, 0);
  const lookup = (name: string) => {
    const column = rel.columns.find((c) => c.name === name);
    if (!column) throw new AnalyzeError('42703', `column "${name}" does not exist`, 0);
    return column;
  };
  const vars = parsed.columns.map((name) => ({ column: lookup(name) }));
  const whereCol = lookup(parsed.where.column);
  const op = operators[`${whereCol.typname} ${parsed.where.op} int4`];
  if (!op) throw new AnalyzeError('42883', 'operator does not exist', 0);
  const tree: TreeNode = {
    name: 'Query',
    detail: 'commandType 1 (SELECT)',
    children: [
      { name: 'rtable', children: [{ name: 'RangeTblEntry', detail: `relid ${rel.oid} relkind r` }] },
      { name: 'targetList', children: vars.map(({ column }, index) => ({ name: 'TargetEntry', detail: `resno ${index + 1} Var(1,${column.attnum},${column.typid})` })) },
      { name: 'jointree', children: [{ name: 'OpExpr', detail: `opno ${op.opno} opfuncid ${op.opfuncid}`, children: [{ name: 'Var', detail: `(1,${whereCol.attnum},${whereCol.typid})` }, { name: 'Const', detail: `int4 ${parsed.where.value}` }] }] },
    ],
  };
  return { tree, vars, rel, op };
}
