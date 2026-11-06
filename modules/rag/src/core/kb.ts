/**
 * 内置知识库：网店「小铺」的规则、商品和售后文档。和 CONTEXT EXPLORER 上下文工程组的客服 Agent 是同一家店
 * （订单 A1024、漏水的保温杯、《售后规则》第 3 条、《退款说明》、《运费说明》的原文照搬），RAG 课讲的就是那个 Agent 的 search_docs 工具背后发生了什么。
 *
 * - 每篇文档有若干段落（`paragraphs`），段落是嵌入模型的训练单位（见 embed.ts），也是「按段落切分」时的天然边界。
 * - `meta` 是元数据：分类、更新日期、状态。元数据过滤课用它（比如只要现行版本、只要售后类）。
 * - 《退款说明（2025 版）》是一篇已作废的旧版本，和现行版本的到账时间冲突：失败案例和元数据过滤课用它。
 * - 全部是示例数据，不是真实店铺的规则。
 *
 * 改这里会改变嵌入模型（在段落上训练）和所有课程的数字：改完跑测试，按报错改文案。
 */

export type Category = '售后' | '退款' | '物流' | '商品' | '账务' | '会员' | '客服';

export interface DocMeta {
  category: Category;
  /** 最后更新日期，YYYY-MM-DD。 */
  updated: string;
  /** current：现行；archived：已作废的旧版本（仍在库里，过滤掉才不会被检索到）。 */
  status: 'current' | 'archived';
}

export interface KbDoc {
  /** 文档 id，ASCII，用在段落 id 和来源编号里。 */
  id: string;
  title: string;
  meta: DocMeta;
  paragraphs: string[];
}

export const SHOP = '小铺';
export const ORDER_ID = 'A1024';

export const KB: readonly KbDoc[] = [
  {
    id: 'aftersale',
    title: '《售后规则》',
    meta: { category: '售后', updated: '2026-09-01', status: 'current' },
    paragraphs: [
      '《售后规则》第 1 条：签收后 7 天内可以无理由退货，商品和配件要完好，非质量问题寄回的运费由买家承担。',
      '《售后规则》第 2 条：签收后 15 天内出现质量问题可以换货，换货来回的运费都由店铺承担。',
      '《售后规则》第 3 条：签收后 7 天内，质量问题可退款或换货，运费由店铺承担。',
      '《售后规则》第 4 条：申请售后要先在订单详情里拍照上传问题部位，客服确认是质量问题后再寄回。',
    ],
  },
  {
    id: 'refund',
    title: '《退款说明》',
    meta: { category: '退款', updated: '2026-09-01', status: 'current' },
    paragraphs: [
      '《退款说明》：退款原路退回，支付宝 1–3 个工作日到账，银行卡 3–7 个工作日。',
      '退款申请审核通过后才会打款，审核一般在 24 小时内完成，周末顺延。',
      '只退其中一件商品时，按这件商品的实付金额退款，已经用掉的优惠券不退回。',
    ],
  },
  {
    id: 'refund-2025',
    title: '《退款说明（2025 版）》',
    meta: { category: '退款', updated: '2025-03-01', status: 'archived' },
    paragraphs: ['《退款说明（2025 版）》：退款原路退回，支付宝 3–5 个工作日到账，银行卡 7–15 个工作日。'],
  },
  {
    id: 'shipping-fee',
    title: '《运费说明》',
    meta: { category: '物流', updated: '2026-06-15', status: 'current' },
    paragraphs: [
      '《运费说明》：非质量问题退货，寄回的运费由买家承担。',
      '订单满 99 元包邮，不满 99 元收 8 元运费，新疆、西藏另加 10 元。',
    ],
  },
  {
    id: 'delivery',
    title: '《配送说明》',
    meta: { category: '物流', updated: '2026-06-15', status: 'current' },
    paragraphs: [
      '默认用顺丰快递发货，江浙沪一般次日送达，其他地区 2–4 天送达。',
      '下单后 48 小时内发货，发货后在订单详情里可以看到物流单号和配送进度。',
      '发货前可以在订单详情里修改收货地址，发货后只能联系快递改派。',
    ],
  },
  {
    id: 'cup',
    title: '《商品：真空保温杯 BW-350》',
    meta: { category: '商品', updated: '2026-08-20', status: 'current' },
    paragraphs: [
      '真空保温杯 BW-350：容量 350 毫升，316 不锈钢内胆，售价 129 元，保温 12 小时。',
      '保温杯的杯盖带硅胶密封圈。杯盖漏水、渗水，多半是密封圈没装好或者老化开裂，先取下密封圈重新装好再试。',
      '保温杯的密封圈可以单独购买，配件编号 SR-35，售价 9 元，一年左右换一次。',
      '保温杯不能装碳酸饮料和牛奶久放，不能放进微波炉，杯身不建议用洗碗机清洗。',
    ],
  },
  {
    id: 'kettle',
    title: '《商品：电热水壶 KT-15》',
    meta: { category: '商品', updated: '2026-08-20', status: 'current' },
    paragraphs: [
      '电热水壶 KT-15：容量 1.5 升，功率 1800 瓦，售价 199 元，水烧开后自动断电。',
      '电热水壶的底座不能沾水，壶身有水垢时用柠檬酸加水煮开再倒掉。',
    ],
  },
  {
    id: 'warranty',
    title: '《保修政策》',
    meta: { category: '售后', updated: '2026-09-01', status: 'current' },
    paragraphs: [
      '保温杯、电热水壶自签收起保修一年，保修期内的质量问题免费维修或换新。',
      '人为损坏不在保修范围内，比如摔裂、磕碰变形、自行拆开内胆。',
    ],
  },
  {
    id: 'invoice',
    title: '《发票说明》',
    meta: { category: '账务', updated: '2026-05-10', status: 'current' },
    paragraphs: [
      '可以开电子普通发票：下单时填写发票抬头和税号，发货后 24 小时内发到邮箱。',
      '企业要开增值税专用发票，请联系客服并提供营业执照和开票信息。',
    ],
  },
  {
    id: 'points',
    title: '《会员积分》',
    meta: { category: '会员', updated: '2026-01-05', status: 'current' },
    paragraphs: [
      '会员每消费 1 元积 1 分，结算时 100 积分可以抵扣 1 元。',
      '积分有效期一年，退货时用积分抵扣的部分会退回积分账户。',
    ],
  },
  {
    id: 'coupon',
    title: '《优惠券规则》',
    meta: { category: '会员', updated: '2026-01-05', status: 'current' },
    paragraphs: ['优惠券不能叠加使用，一个订单只能用一张，过期后不补发。'],
  },
  {
    id: 'contact',
    title: '《联系客服》',
    meta: { category: '客服', updated: '2026-03-01', status: 'current' },
    paragraphs: [
      '在线客服每天 9:00–22:00 在线，电话 400-800-1024，投诉一般 48 小时内处理完。',
    ],
  },
];

/** 一个段落：嵌入模型的训练单位，也是检索课默认的「块」。 */
export interface Paragraph {
  /** `文档 id#段落序号`，序号从 0 开始，比如 `aftersale#2`。 */
  id: string;
  doc: string;
  index: number;
  title: string;
  text: string;
  meta: DocMeta;
}

/** 全部段落，按文档顺序。 */
export const PARAGRAPHS: readonly Paragraph[] = KB.flatMap((doc) => doc.paragraphs.map((text, index) => ({ id: `${doc.id}#${index}`, doc: doc.id, index, title: doc.title, text, meta: doc.meta })));

export const paragraphById = (id: string): Paragraph => {
  const found = PARAGRAPHS.find((item) => item.id === id);
  if (!found) throw new Error(`没有段落 ${id}`);
  return found;
};

export const docById = (id: string): KbDoc => {
  const found = KB.find((doc) => doc.id === id);
  if (!found) throw new Error(`没有文档 ${id}`);
  return found;
};

/** 一篇文档的全文：段落之间换行。切分课的输入。 */
export const docText = (doc: KbDoc): string => doc.paragraphs.join('\n');

/**
 * 标注好的评估问题：每个问题有人工标注的相关段落（`relevant`）和参考答案里的关键事实（`facts`）。
 * 评估课用它算 context precision / recall、faithfulness；其余课也可以从这里挑问题。标注是本站写的示例。
 */
export interface EvalItem {
  id: string;
  question: string;
  /** 能回答这个问题的段落 id。 */
  relevant: string[];
  /** 参考答案里必须出现的关键事实（按字面核对）。 */
  facts: string[];
}

export const EVAL_SET: readonly EvalItem[] = [
  { id: 'leak', question: '保温杯漏水了怎么办？', relevant: ['cup#1', 'aftersale#2'], facts: ['密封圈', '换货'] },
  { id: 'refund-time', question: '退款多久能到账？', relevant: ['refund#0', 'refund#1'], facts: ['1–3 个工作日', '3–7 个工作日'] },
  { id: 'return-fee', question: '不想要了退货，运费谁出？', relevant: ['aftersale#0', 'shipping-fee#0'], facts: ['买家承担'] },
  { id: 'invoice', question: '怎么开发票？', relevant: ['invoice#0', 'invoice#1'], facts: ['抬头', '税号'] },
  { id: 'address', question: '地址写错了还能改吗？', relevant: ['delivery#2'], facts: ['发货前', '改派'] },
  { id: 'seal', question: '杯盖的密封圈坏了在哪买？', relevant: ['cup#2'], facts: ['SR-35', '9 元'] },
  { id: 'warranty', question: '热水壶保修多久？', relevant: ['warranty#0'], facts: ['一年'] },
  { id: 'points', question: '积分能抵现金吗？', relevant: ['points#0'], facts: ['100 积分', '1 元'] },
];
