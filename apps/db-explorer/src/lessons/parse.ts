import { protocolMessage, concept, wire } from '../decode/structures';
import { commandComplete, dataRow, errorResponse, queryMessage, readyForQuery, rowDescription } from '../engine/protocol';
import { analyze, AnalyzeError, parseSelect, tokenize, type TreeNode, type CatalogTable } from '../engine/sql';
import { LayerWriter } from '../decode/writer';
import type { LanesBoard, TreeBoard } from '../scene/board-types';
import { board, note, pk, render, show, type as typed } from './dsl';
import { us } from './shared';
import type { Lesson } from './types';

const SQL = 'SELECT id, balance FROM accounts WHERE id = 42;';
const BAD = 'SELECT nope FROM accounts WHERE id = 42;';
/** 表 OID 只是示例；opno 96、opfuncid 65、类型 23 是系统目录里固定的值，用 debug_print_parse 核对过。 */
const TABLES: CatalogTable[] = [{
  name: 'accounts',
  oid: 16517,
  columns: [
    { name: 'id', attnum: 1, typid: 23, typname: 'int4' },
    { name: 'owner', attnum: 2, typid: 25, typname: 'text' },
    { name: 'balance', attnum: 3, typid: 23, typname: 'int4' },
  ],
}];
const OPS = { 'int4 = int4': { opno: 96, opfuncid: 65, resulttype: 16 } };

const tokens = tokenize(SQL);
const parsed = parseSelect(tokens);
const query = analyze(parsed, TABLES, OPS);
let missing = '';
let missingCode = '';
try {
  analyze(parseSelect(tokenize(BAD)), TABLES, OPS);
} catch (error) {
  missing = (error as AnalyzeError).message;
  missingCode = (error as AnalyzeError).code;
}

function flatten(node: TreeNode, depth = 0, hot: string[] = []): TreeBoard['rows'] {
  const row = { depth, name: node.name, detail: node.detail, hot: hot.includes(node.name) ? ('amber' as const) : undefined };
  return [row, ...(node.children ?? []).flatMap((child) => flatten(child, depth + 1, hot))];
}

const treeSpec = (title: string, sub: string, node: TreeNode | null, hot: string[] = []): TreeBoard => ({ kind: 'tree', title, sub, rows: node ? flatten(node, 0, hot) : [] });

const tokenSpec = (count: number): LanesBoard => {
  const shown = tokens.slice(0, count);
  const per = 8;
  const rows: LanesBoard['rows'] = [];
  for (let i = 0; i < tokens.length; i += per) {
    rows.push({
      label: i === 0 ? '单词' : '',
      cells: tokens.slice(i, i + per).map((t, k) => ({ text: t.text, sub: t.token.replace(/'/g, ''), muted: !shown.includes(tokens[i + k]), hot: i + k === count - 1 ? ('amber' as const) : undefined })),
    });
  }
  return { kind: 'lanes', title: 'scan.l 产出的单词', sub: `${count} / ${tokens.length}`, rows, cell: 96, labelWidth: 42 };
};

/** SQL 文本本身：每个单词是一个字段，字节范围就是它在字符串里的真实位置。 */
function sqlBytes(): LayerWriter {
  const layer = new LayerWriter('sqltext', '查询字符串', 'teal', '按单词切开');
  const bytes = new TextEncoder().encode(SQL);
  let at = 0;
  for (const t of tokens) {
    if (t.from > at) {
      const from = at;
      layer.field('空白', '跳过', () => layer.raw(bytes.subarray(from, t.from)));
    }
    layer.field(t.text, t.token, () => layer.raw(bytes.subarray(t.from, t.to)), { note: t.kind === 'keyword' ? '关键字。不区分大小写，查 kwlist.h。' : t.kind === 'ident' ? '标识符。没加引号就折叠成小写。' : t.kind === 'iconst' ? '整数常量。' : '' });
    at = t.to;
  }
  return layer;
}

const fields = query.vars.map(({ column }) => ({ name: column.name, tableOid: query.rel.oid, attnum: column.attnum, typeOid: column.typid, typlen: 4 }));
const empty: LanesBoard = { kind: 'lanes', title: 'scan.l 产出的单词', sub: `0 / ${tokens.length}`, rows: [], labelWidth: 42 };

export const parse: Lesson = {
  id: 'parse',
  name: 'PARSE',
  title: '解析与语义分析',
  group: 'query',
  layer: [7, 7],
  timeUnit: 'µs',
  nodes: ['client', 'backend', 'parser', 'catalog', 'planner'],
  place: { client: [90, 70], backend: [280, 165], parser: [470, 70], catalog: [660, 165], planner: [850, 70] },
  labels: {
    client: ['客户端', 'psql'],
    backend: ['后端进程', 'exec_simple_query'],
    parser: ['解析器', 'scan.l + gram.y'],
    catalog: ['系统目录', 'pg_class 等'],
    planner: ['优化器', '下一课'],
  },
  start: ['client'],
  boards: {
    tokens: { rect: [20, 250, 900, 132], initial: empty },
    tree: { rect: [20, 390, 900, 285], initial: treeSpec('语法树', '还没有', null) },
  },
  legend: [['blue', '协议消息'], ['teal', '词法与语法'], ['violet', '查目录'], ['amber', '错误'], ['green', '交给下一阶段'], [null, '节点名来自 debug_print_parse']],
  overview: {
    full: 'SQL 文本如何变成带类型的查询树',
    description: '数据库收到的只是一段字符串。它要先切成单词，再按语法组成树，最后查系统目录把名字换成 OID、列号和类型。语法对不对和对象存不存在是两个阶段的事，所以两类错误的 SQLSTATE 不一样。',
    facts: [
      ['基准', 'PostgreSQL 17'],
      ['词法', 'scan.l（flex）'],
      ['语法', 'gram.y（bison）'],
      ['语义', 'parse_analyze_fixedparams'],
      ['入口', 'exec_simple_query'],
      ['通用原理', '词法 → 语法 → 语义，几乎所有数据库都这样分层'],
    ],
  },
  steps: [
    {
      title: '发送查询',
      desc: 'Query 消息把 SQL 字符串送到后端进程',
      detail: '每个连接有一个专属的后端进程。psql 用简单查询协议发一条 Query 消息：类型字节 Q、4 字节长度，然后是以 0 结尾的 SQL 文本。这时服务器还完全不知道这段文字的含义。',
      facts: [['消息类型', "'Q'"], ['字节序', '长度字段是大端'], ['服务端入口', 'exec_simple_query']],
      events: [
        typed(SQL),
        show('backend'),
        pk('client', 'backend', 'blue', 'Query', [`${queryMessage(SQL).length} 字节`], [0, 'MSG', '简单查询协议：Q 消息', queryMessage(SQL).length],
          wire('客户端到后端的 TCP 连接或 Unix 套接字', 'mem', 'protocol', protocolMessage(queryMessage(SQL)))),
      ],
    },
    {
      title: '切成单词',
      desc: 'scan.l 把字符流变成单词流',
      detail: '词法分析只看字符。SELECT 不区分大小写，查关键字表；没加引号的标识符折叠成小写，所以 Accounts 和 accounts 是同一张表。它不管这些单词排得对不对，也不知道 accounts 存不存在。',
      facts: [['单词数', String(tokens.length)], ['函数', 'core_yylex'], ['标识符', '折叠成小写']],
      events: [
        show('parser'),
        pk('backend', 'parser', 'teal', 'pg_parse_query', ['raw_parser'], [us(40), 'PARSE', '把字符串交给 raw_parser', new TextEncoder().encode(SQL).length],
          wire('后端进程内存，raw_parser 的输入', 'mem', 'protocol', sqlBytes())),
        board('tokens', tokenSpec(4)),
        board('tokens', tokenSpec(10)),
        board('tokens', tokenSpec(tokens.length)),
      ],
    },
    {
      title: '组成语法树',
      desc: 'gram.y 按语法规则产生原始语法树',
      detail: 'Bison 生成的解析器用语法规则把单词归约成树：SelectStmt 下面挂 targetList、fromClause、whereClause。这一步只看形状，列名还只是字符串。写错关键字会在这里失败，报 42601 语法错误。',
      facts: [['根节点', 'SelectStmt（包在 RawStmt 里）'], ['列引用', 'ColumnRef，只是名字'], ['语法错误', 'SQLSTATE 42601']],
      events: [
        board('tree', treeSpec('原始语法树', 'raw parse tree，未查目录', parsed.raw, ['SelectStmt'])),
        note('parser', '语法正确'),
        pk('parser', 'backend', 'teal', 'RawStmt', ['SelectStmt'], [us(62), 'PARSE', '返回原始语法树', null],
          wire('后端进程内存。节点是 C 结构体，这里只列真实字段名', 'vals', '示意', concept('SelectStmt', [
            ['targetList', `${parsed.columns.length} 个 ResTarget`, '要输出的列，此时还没有和表关联。'],
            ['fromClause', `RangeVar "${parsed.table}"`, '只是一个名字。'],
            ['whereClause', `A_Expr "${parsed.where.op}"`, '操作符也还只是字符串 "="。'],
          ], 'teal'))),
      ],
    },
    {
      title: '查系统目录',
      desc: '把名字换成 OID、列号和类型',
      detail: 'transformSelectStmt 查 pg_class 确定表，查 pg_attribute 得到列号和类型，查 pg_operator 把 "=" 解析成 int4 的等值操作符。系统目录本身也是普通的表，这些查询有专门的缓存（syscache）。',
      facts: [['pg_class', `accounts 的 OID（示例 ${query.rel.oid}）`], ['pg_attribute', 'id 是第 1 列，类型 23（int4）'], ['pg_operator', 'opno 96，函数 65（int4eq）']],
      events: [
        show('catalog'),
        pk('parser', 'catalog', 'violet', '查表和列', ['accounts', 'id, balance'], [us(70), 'PARSE', 'parse_analyze_fixedparams：查 pg_class、pg_attribute', null],
          wire('系统目录缓存（syscache）', 'vals', '示意', concept('要查的名字', [
            ['relname', 'accounts', '按 search_path 解析。'],
            ['ColumnRef', 'id, balance', '在 FROM 里的表中查找。'],
            ['操作符', 'int4 = int4', '按参数类型挑选重载。'],
          ], 'violet'))),
        pk('catalog', 'parser', 'violet', '返回定义', ['relid', 'attnum, typid'], [us(95), 'PARSE', '得到 OID、列号和类型', null],
          wire('系统目录缓存。数值来自真实表的 debug_print_parse', 'vals', '示意', concept('查到的定义', [
            ['relid', `${query.rel.oid} E.G.`, 'pg_class.oid，随表变化。'],
            ['id', `attnum ${query.vars[0].column.attnum}，typid ${query.vars[0].column.typid}`, '23 是 int4。'],
            ['balance', `attnum ${query.vars[1].column.attnum}，typid ${query.vars[1].column.typid}`, ''],
            ['=', `opno ${query.op.opno}，opfuncid ${query.op.opfuncid}，返回 ${query.op.resulttype}`, 'int4eq，返回 bool（类型 16）。'],
          ], 'violet'))),
        board('tree', treeSpec('Query 树', '已绑定目录对象', query.tree, ['Query', 'OpExpr', 'Var', 'Const'])),
      ],
    },
    {
      title: '语义错误',
      desc: '语法对了，列不存在，就在这一步报错',
      detail: `把列名换成 nope 再发一次：语法树照样建得出来，查 pg_attribute 时才失败，报 ${missingCode}。这就是分层的后果：写错关键字报 42601，列不存在报 42703，错误位置和产生错误的源文件也不同。`,
      facts: [['语法错误', '42601，scan.l'], ['列不存在', `${missingCode}，parse_relation.c`], ['错误函数', 'errorMissingColumn']],
      events: [
        note('parser', missing, 'amber'),
        pk('backend', 'client', 'amber', 'ErrorResponse', [missingCode, missing], [us(120), 'MSG', `换一条错误的 SQL：${missing}`, errorResponse([['S', 'ERROR'], ['V', 'ERROR'], ['C', '42703'], ['M', missing], ['P', '8'], ['F', 'parse_relation.c'], ['L', '3721'], ['R', 'errorMissingColumn']]).length],
          wire('后端到客户端。字段和真实抓包一致；行号来自 PostgreSQL 17.11', 'mem', 'protocol',
            protocolMessage(errorResponse([['S', 'ERROR'], ['V', 'ERROR'], ['C', '42703'], ['M', missing], ['P', '8'], ['F', 'parse_relation.c'], ['L', '3721'], ['R', 'errorMissingColumn']])),
            protocolMessage(readyForQuery()))),
      ],
    },
    {
      title: '交给下一阶段',
      desc: '重写规则之后，Query 树进入优化器',
      detail: '正确的 Query 接着走重写器：视图在这里展开成子查询。然后交给优化器选执行方式。最后结果用 RowDescription、DataRow、CommandComplete、ReadyForQuery 四种消息发回客户端，值默认都是文本格式。',
      facts: [['重写', 'pg_rewrite_query，视图展开'], ['下一步', 'pg_plan_queries'], ['结果格式', '简单查询协议用文本']],
      events: [
        show('planner'),
        pk('parser', 'planner', 'green', 'Query', ['commandType 1'], [us(160), 'PLAN', 'pg_analyze_and_rewrite_fixedparams → pg_plan_queries', null],
          wire('后端进程内存。字段值与 debug_print_parse 的输出一致', 'vals', '示意', concept('Query', [
            ['commandType', '1', 'CMD_SELECT。'],
            ['rtable', `RangeTblEntry relid ${query.rel.oid} relkind r`, '查询涉及的表。'],
            ['targetList', 'Var(1,1,23)、Var(1,3,23)', '(表序号, 列号, 类型)。'],
            ['jointree.quals', 'OpExpr opno 96', 'id = 42。'],
          ], 'green'))),
        pk('backend', 'client', 'green', '结果', ['T D C Z'], [us(420), 'MSG', '返回 RowDescription、DataRow、CommandComplete、ReadyForQuery', rowDescription(fields).length + dataRow(['42', '100']).length + commandComplete('SELECT 1').length + readyForQuery().length],
          wire('后端到客户端。假设第 42 行余额是 100。编码器已用真实抓包验证', 'mem', 'protocol',
            protocolMessage(rowDescription(fields)),
            protocolMessage(dataRow(['42', '100'])),
            protocolMessage(commandComplete('SELECT 1')),
            protocolMessage(readyForQuery()))),
        render,
      ],
    },
  ],
  outro: {
    title: '从字符串到查询树',
    desc: '名字都换成了 OID，优化器不用再猜',
    text: '词法、语法、语义是通用的三段式；scan.l、gram.y、syscache 和 SQLSTATE 是 PostgreSQL 的具体做法。预备语句把解析结果留下来，下次只传参数，所以省掉的就是这几步。',
    facts: [['语法错误', '42601'], ['列不存在', '42703'], ['下一课', 'PLANNER']],
  },
};
