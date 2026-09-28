// T043: 纯文本简历解析（.txt/.md 全文抽取后走统一抽取规则；FR-009 空文本报错）

import { assertReadableText, extractFromText, type ExtractResult } from "./extract"

/** .txt/.md：全文即文本，无可识别文本 → FR-009 */
export function parseTextResume(content: string): ExtractResult {
  assertReadableText(content, 1)
  return extractFromText(content)
}
