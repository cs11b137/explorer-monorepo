/**
 * 一次 Messages API 调用：请求体、示例回复（脚本）→ 真实的 usage、费用、HTTP 字节。
 * 用共享包 llm-core 的 createMessage（token 数是本站分词器的真实计数）、costOf（示例单价）、messagesHttpRequest / Response。
 * 课程里每一次模型调用（客服回答、评委打分、筛查）都经这里，轨迹表的「费用」列就是这些调用的 cost.total 累加。
 */
import { createMessage, messagesHttpRequest, messagesHttpResponse, type ContentBlock, type Message, type MessagesRequest } from '@explorer/llm-core/anthropic';
import { encodeRequest, encodeResponse, type HttpLayout } from '@explorer/llm-core/http';
import { EXAMPLE_EPOCH, exampleId, httpDate } from '@explorer/llm-core/ids';
import { costOf, type Cost } from '@explorer/llm-core/pricing';

export interface ModelCall {
  request: MessagesRequest;
  message: Message;
  /** 这次调用的费用（纳美元）。 */
  cost: Cost;
  http: { request: HttpLayout; response: HttpLayout };
}

/** 回复可以直接写文字（变成一个 text 块）。seed 决定 msg / req id（示例）。at 是相对 EXAMPLE_EPOCH 的秒数，写进 date 头。 */
export function callModel(request: MessagesRequest, reply: string | readonly ContentBlock[], seed: number, at = 0): ModelCall {
  const blocks: readonly ContentBlock[] = typeof reply === 'string' ? [{ type: 'text', text: reply }] : reply;
  const message = createMessage(request, blocks, { id: exampleId('msg', seed) });
  return {
    request,
    message,
    cost: costOf(message.usage, request.model),
    http: {
      request: encodeRequest(messagesHttpRequest(request)),
      response: encodeResponse(messagesHttpResponse(message, { requestId: exampleId('req', seed), date: httpDate(EXAMPLE_EPOCH + at) })),
    },
  };
}

/** 一条消息的全部文字。 */
export const replyText = (message: Message): string => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
