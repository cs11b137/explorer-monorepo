/**
 * 内置小语料：分词器在它上面训练合并表，迷你模型在它上面预训练（scripts/train.ts）。
 * 英文多、中文少，和大多数公开语料的比例方向一致：这正是中文更费 token 的原因之一。
 * 每一行是一篇「文档」，训练模型时文档之间插入结束符 <|end|>。
 *
 * 改这里会改变合并表、权重和所有课程的数字：改完要重新运行 npm run train -w llm-explorer，
 * 再跑测试，按报错改文案。
 */
export const CORPUS: readonly string[] = [
  'the model reads the tokens and the model writes the next token.',
  'a token is a piece of text. the tokenizer turns text into tokens.',
  'the model turns each token into a vector, and the vectors go through the layers.',
  'attention lets each token look at the tokens before it.',
  'the next token is sampled from the model output, one token at a time.',
  'the cache keeps the keys and values, so the model does not read the prompt again.',
  'a longer prompt costs more tokens, and more tokens cost more time.',
  'the tokenizer reads bytes, merges the bytes into tokens, and writes token ids.',
  'the model is trained to predict the next token in the text.',
  'temperature makes the output more random or less random.',
  'the model writes text one token at a time, and the text streams to the screen.',
  'tokens in, tokens out: the model only sees token ids.',
  '模型读 token，模型写 token。',
  '大模型一次生成一个 token。',
  '中文的一个字是三个字节，模型先读字节。',
  '分词器把文本变成 token，模型把 token 变成向量。',
  '模型的输出是下一个 token 的概率。',
  '大模型的上下文有长度上限。',
];

/** 分词器学习的合并规则条数。词表大小 = 256 个字节 + 合并数 + 1 个结束符。 */
export const NUM_MERGES = 96;

/** 结束符的文本形式，只用于展示；它不是由字节合并出来的。 */
export const EOS_TEXT = '<|end|>';
