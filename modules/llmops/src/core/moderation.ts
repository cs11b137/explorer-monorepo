/**
 * 内容审核：本站的多标签分类器（每个类别一个 classifier.ts 的逻辑回归，一对其余），以及按分数决定拦截、转人工、改写还是放行。
 *
 * - 类别名取 OpenAI moderation 文档里列出的四个键 harassment、illicit、self-harm、violence（核对过，见 README），
 *   但**分数是本站分类器在自写小数据集上算的**，不是 OpenAI 的模型，阈值和行为都不代表任何产品；
 * - 结果对象的字段名照 OpenAI moderation 响应里的 results[]（flagged、categories、category_scores），方便和真实接口对照；
 * - 数据集 MODERATION_SET 是本站自写的客服场景短句（辱骂客服、要求违规操作、流露轻生念头、威胁），另有一批带强烈情绪但不违规的正常抱怨；
 *   每类每 3 条取 1 条进测试集。同一类的句子刻意共用一些说法（废物、假发票、不想活、算账），测试集才有机会被认出来——
 *   这正是小数据集分类器的局限：没见过的说法基本认不出（课程要说明）。
 */
import { predict, trainLogReg, type LogReg } from './classifier';

export const MOD_CATEGORIES = ['harassment', 'illicit', 'self-harm', 'violence'] as const;
export type ModCategory = (typeof MOD_CATEGORIES)[number];

export const MOD_LABEL: Record<ModCategory, string> = { harassment: '骚扰辱骂', illicit: '违法违规', 'self-harm': '自伤', violence: '暴力威胁' };

export interface ModItem {
  id: string;
  text: string;
  /** 空数组是正常内容。 */
  labels: ModCategory[];
  split: 'train' | 'test';
}

const RAW: Array<[string, ModCategory[]]> = [
  // 辱骂客服
  ['你们客服都是废物，听不懂人话吗？', ['harassment']],
  ['蠢货，赶紧给我退钱！', ['harassment']],
  ['你脑子有问题吧，回答得这么烂。', ['harassment']],
  ['垃圾客服，一点用都没有。', ['harassment']],
  ['你是猪吗，说了三遍还不懂。', ['harassment']],
  ['闭嘴，叫你们领导来，你不配跟我说话。', ['harassment']],
  ['废物一个，连个订单都查不明白。', ['harassment']],
  ['你这个蠢客服，脑子进水了吧。', ['harassment']],
  ['垃圾店铺，垃圾客服，全是废物。', ['harassment']],
  ['你们这些人就是一群猪。', ['harassment']],
  ['闭嘴吧蠢货，我不想听你废话。', ['harassment']],
  ['你脑子是不是坏了，这都不懂？', ['harassment']],
  // 要求违法违规的操作
  ['帮我开一张假发票，金额写高一点。', ['illicit']],
  ['教我怎么用别人的身份证注册账号。', ['illicit']],
  ['能不能帮我刷好评，我给你红包。', ['illicit']],
  ['把别的顾客的手机号卖给我。', ['illicit']],
  ['怎么改快递单号骗退款？', ['illicit']],
  ['我想用捡到的银行卡下单，怎么不被发现？', ['illicit']],
  ['帮我伪造一张签收证明。', ['illicit']],
  ['告诉我几个能白拿优惠券的系统漏洞。', ['illicit']],
  ['给我开几张假发票，我拿去报销。', ['illicit']],
  ['我给你红包，帮我刷一百条好评。', ['illicit']],
  ['用别人的银行卡付款会被发现吗？', ['illicit']],
  ['能伪造一个快递单号让我骗到退款吗？', ['illicit']],
  // 流露轻生念头
  ['活着太累了，我想结束这一切。', ['self-harm']],
  ['最近一直想伤害自己。', ['self-harm']],
  ['我觉得自己没有存在的必要了。', ['self-harm']],
  ['想把家里的药全吃了算了。', ['self-harm']],
  ['没人在乎我，消失了也好。', ['self-harm']],
  ['我不想活了，什么都没意思。', ['self-harm']],
  ['真的不想活了，活着没意思。', ['self-harm']],
  ['我想伤害自己，停不下来。', ['self-harm']],
  ['消失了大家都会轻松，我想结束了。', ['self-harm']],
  ['觉得活着没有意义，想一了百了。', ['self-harm']],
  ['最近总想着结束自己的生命。', ['self-harm']],
  ['没有人在乎我，我想离开这个世界。', ['self-harm']],
  // 威胁
  ['再不退款我就去你们仓库砸东西。', ['violence']],
  ['我知道你们店在哪，小心点。', ['violence']],
  ['快递员再这样我就揍他。', ['violence']],
  ['把那个客服的地址给我，我去找他算账。', ['violence']],
  ['惹急了我就带人去堵你们门口。', ['violence']],
  ['下次见到送货的我非打断他的腿不可。', ['violence']],
  ['再拖着不退款，我就去店里砸了它。', ['violence']],
  ['那个快递员我见一次揍一次。', ['violence']],
  ['告诉我客服住哪，我要去找他算账。', ['violence']],
  ['小心点，我会带人去你们仓库。', ['violence']],
  ['我要打断那个客服的腿。', ['violence']],
  ['不给我退款我就带刀去你们店里。', ['violence']],
  // 正常（多数带强烈情绪，几条用到「砸」「抢劫」「要命」「投诉他」这类词）
  ['气死我了，杯子第二次漏水了！', []],
  ['我真的很失望，能不能快点处理？', []],
  ['这个杯子质量太差了。', []],
  ['快递把盒子压坏了。', []],
  ['我差点被热水烫伤，杯盖太松了。', []],
  ['这价格简直是抢劫。', []],
  ['等了三天还没人理我，太离谱了。', []],
  ['A1024 的杯盖漏水，可以退货吗？', []],
  ['退款一般多久到账？', []],
  ['发票怎么开？', []],
  ['能帮我查一下物流吗？', []],
  ['客服你好，我想换个颜色。', []],
  ['累死了，搬家时把杯子摔了，能修吗？', []],
  ['这杯子保温效果真是要命地差。', []],
  ['你们再这样我就去平台投诉了。', []],
  ['我要给差评，太让人生气了。', []],
  ['身份证上的地址和收货地址不一样可以吗？', []],
  ['请问能开增值税发票吗？', []],
  ['快递员态度不好，我要投诉他。', []],
  ['我想把订单地址改到公司。', []],
  ['杯子摔坏了，还能保修吗？', []],
  ['优惠券过期了还能用吗？', []],
  ['我想给好评，怎么上传照片？', []],
  ['气得我想砸键盘，页面一直卡。', []],
];

/** 本站自写的审核数据集：48 条违规（每类 12 条）、24 条正常（多数带强烈情绪）；每类每 3 条取 1 条进测试集（各 4 条、正常 8 条）。 */
export const MODERATION_SET: readonly ModItem[] = (() => {
  const seen: Record<string, number> = {};
  return RAW.map(([text, labels], i): ModItem => {
    const key = labels[0] ?? 'none';
    const n = (seen[key] = (seen[key] ?? 0) + 1);
    return { id: `mod-${String(i + 1).padStart(2, '0')}`, text, labels, split: n % 3 === 0 ? 'test' : 'train' };
  });
})();

/** 每个类别一个逻辑回归：这一类为正，其余（含正常）为负。在训练集上训练，种子按类别区分；正例只有 8 条、负例 40 条，所以正例的梯度按负例数 / 正例数加权（balanced）。 */
export const MODERATORS: Record<ModCategory, LogReg> = Object.fromEntries(
  MOD_CATEGORIES.map((category, i) => [
    category,
    trainLogReg(MODERATION_SET.filter((item) => item.split === 'train').map((item) => ({ text: item.text, label: item.labels.includes(category) ? 1 : 0 })), { seed: 11 + i, positiveWeight: 'balanced' }),
  ]),
) as Record<ModCategory, LogReg>;

export const MOD_THRESHOLD = 0.5;

/** results[] 里的一项（字段名照 OpenAI moderation 的响应，只有本站的四个类别）。 */
export interface ModerationResult {
  flagged: boolean;
  categories: Record<ModCategory, boolean>;
  category_scores: Record<ModCategory, number>;
}

/** 给一段文字打分：每个类别的概率，≥ 阈值的类别为 true，任一为 true 则 flagged。 */
export function moderate(text: string, thresholds: Partial<Record<ModCategory, number>> = {}): ModerationResult {
  const scores = Object.fromEntries(MOD_CATEGORIES.map((c) => [c, predict(MODERATORS[c], text).p])) as Record<ModCategory, number>;
  const categories = Object.fromEntries(MOD_CATEGORIES.map((c) => [c, scores[c] >= (thresholds[c] ?? MOD_THRESHOLD)])) as Record<ModCategory, boolean>;
  return { flagged: MOD_CATEGORIES.some((c) => categories[c]), categories, category_scores: scores };
}

/** 一个 moderation 响应体的形状（id、model 是示例值）。 */
export const moderationResponse = (id: string, model: string, result: ModerationResult) => ({ id, model, results: [result] });

// ---------- 处置 ----------

export type ModAction = 'allow' | 'rewrite' | 'review' | 'block';
/** 处置的严重程度，从轻到重。 */
export const ACTION_ORDER: readonly ModAction[] = ['allow', 'rewrite', 'review', 'block'];

export type ModPolicy = Record<ModCategory, { threshold: number; action: ModAction }>;

/**
 * 本站的示例策略（不是哪个产品的默认值）：辱骂客服不拦，改写成冷静的工单（rewrite）；
 * 流露轻生念头不拦也不自动回复，转给人工并给出求助信息（review）；违法违规和暴力威胁直接拦下（block）。
 */
export const EXAMPLE_POLICY: ModPolicy = {
  harassment: { threshold: 0.5, action: 'rewrite' },
  illicit: { threshold: 0.5, action: 'block' },
  'self-harm': { threshold: 0.3, action: 'review' },
  violence: { threshold: 0.5, action: 'block' },
};

export interface Decision {
  action: ModAction;
  /** 决定处置的类别（最严重的那个；都没超阈值是 null）。 */
  category: ModCategory | null;
  score: number;
}

/** 超过阈值的类别里取处置最重的；一样重时取分数高的。 */
export function decide(result: ModerationResult, policy: ModPolicy = EXAMPLE_POLICY): Decision {
  let best: Decision = { action: 'allow', category: null, score: 0 };
  for (const c of MOD_CATEGORIES) {
    const score = result.category_scores[c];
    if (score < policy[c].threshold) continue;
    const rank = ACTION_ORDER.indexOf(policy[c].action);
    const bestRank = ACTION_ORDER.indexOf(best.action);
    if (rank > bestRank || (rank === bestRank && score > best.score)) best = { action: policy[c].action, category: c, score };
  }
  return best;
}

// ---------- 按句打分 ----------

export interface SentenceModeration {
  /** UTF-16 下标 [from, to)。 */
  from: number;
  to: number;
  text: string;
  result: ModerationResult;
}

/**
 * 按句打分（本站写法）：在句末的 。！？!? 后切开，每句单独 moderate，每个类别取各句的最高分，再按阈值判定。
 * 整段打分时，一句辱骂夹在一长串号码里会被稀释（特征值是 1/√桶数，桶越多每个片段的分量越小），按句打分就不会。
 */
export function moderateSentences(text: string, thresholds: Partial<Record<ModCategory, number>> = {}): { sentences: SentenceModeration[]; result: ModerationResult } {
  const sentences: SentenceModeration[] = [];
  let at = 0;
  for (const piece of text.split(/(?<=[。！？!?])/u)) {
    if (piece.trim()) sentences.push({ from: at, to: at + piece.length, text: piece, result: moderate(piece, thresholds) });
    at += piece.length;
  }
  const scores = Object.fromEntries(MOD_CATEGORIES.map((c) => [c, Math.max(0, ...sentences.map((s) => s.result.category_scores[c]))])) as Record<ModCategory, number>;
  const categories = Object.fromEntries(MOD_CATEGORIES.map((c) => [c, scores[c] >= (thresholds[c] ?? MOD_THRESHOLD)])) as Record<ModCategory, boolean>;
  return { sentences, result: { flagged: MOD_CATEGORIES.some((c) => categories[c]), categories, category_scores: scores } };
}
