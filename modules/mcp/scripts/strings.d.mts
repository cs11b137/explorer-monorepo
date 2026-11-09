export const DATA_START: string;
/** 原站页面里的数据脚本（不含 <script> 标签）。 */
export function dataScript(html: string): string;
/** 按页面中出现的顺序返回全部待译文字和它们的出处。 */
export function collectStrings(html?: string): Array<{ en: string; where: string[] }>;
