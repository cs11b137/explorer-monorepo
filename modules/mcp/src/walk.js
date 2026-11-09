// 找出原站数据里所有给人看的讲解文字，交给 tr 换成译文。页面运行时和 scripts/extract.mjs 共用这一份规则。
// 原样内联进页面，在原站的数据脚本之后执行，所以能直接读到它的顶层 const。不依赖 DOM。
// tr(text, where) 返回替换后的字符串；返回原值表示不换。where.key 是这条文字所在的字段，字典可以用 "字段|原文" 给某个位置单独配译文。
globalThis.__mcpWalk = function (tr) {
  /** 这些键的值是标识符、枚举或线上报文，不是讲解文字。json 是线上报文，保持英文。 */
  const SKIP = new Set(['json', 'id', 'kind', 'icon', 'group', 'from', 'to', 'mono', 'vid', 'ids', 'layer', 'dt', 'step', 'risk']);
  /** 地址和锚点不翻译。 */
  const isLink = (text) => /^(?:https?:\/\/|#)/.test(text);
  const seen = new Set();
  const visit = (node, where) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        // facts 的第三项是 "dep" 标记，不是文字。
        if (where.key === 'facts' && Array.isArray(node[i])) {
          visitRow(node[i], where, 2);
          continue;
        }
        // notes 每行是 [键, 解释]。键常常是字段名或头名，单独标成 notes.key，字典可以只给这个位置另配译文。
        if (where.key === 'notes' && Array.isArray(node[i])) {
          visitRow(node[i], where, node[i].length, { lesson: where.lesson, key: 'notes.key' });
          continue;
        }
        if ((where.key === 'links' || where.key === 'wip') && Array.isArray(node[i])) {
          visitRow(node[i], where, node[i].length);
          continue;
        }
        cell(node, i, where);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      cell(node, key, { lesson: where.lesson, key });
    }
  };
  const visitRow = (row, where, count, first = where) => {
    if (seen.has(row)) return;
    seen.add(row);
    for (let i = 0; i < count; i++) cell(row, i, i === 0 ? first : where);
  };
  const cell = (holder, key, where) => {
    const value = holder[key];
    if (typeof value === 'string') {
      if (value.trim() && !isLink(value)) holder[key] = tr(value, where);
    } else visit(value, where);
  };

  // 课程本身。EXTRA 已经被原站合并进 LESSONS，同一批对象，不用单独走。
  for (const lesson of LESSONS) visit(lesson, { lesson: lesson.id, key: '' });
  // 各规范版本的覆盖内容：TM[课][版本]。
  for (const id of Object.keys(TM)) for (const version of Object.keys(TM[id])) visit(TM[id][version], { lesson: `${id}@${version}`, key: '' });
  // 列表和时间线用到的全局文字。
  for (const row of VERSIONS) row[1] = tr(row[1], { lesson: 'ui', key: 'VERSIONS' });
  for (const row of GROUPS) row[1] = tr(row[1], { lesson: 'ui', key: 'GROUPS' });
  for (let i = 0; i < LAYERS.length; i++) LAYERS[i] = tr(LAYERS[i], { lesson: 'ui', key: 'LAYERS' });
  for (const key of Object.keys(GROUP_HEAD)) GROUP_HEAD[key] = tr(GROUP_HEAD[key], { lesson: 'ui', key: 'GROUP_HEAD' });
  for (const key of Object.keys(GROUP_LABEL)) GROUP_LABEL[key] = tr(GROUP_LABEL[key], { lesson: 'ui', key: 'GROUP_LABEL' });
  for (const row of WHATS_NEXT) for (let i = 0; i < 2; i++) row[i] = tr(row[i], { lesson: 'ui', key: 'WHATS_NEXT' });
};
