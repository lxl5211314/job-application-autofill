// T011: 扩展内部消息协议（contracts/messages.md）
// 信封 Request/Response、14 类消息定义（v1 注册 12 类 + autofill:event 广播；
// llm:match / llm:rewrite 为 v1.1 预留，第一版不注册——spec FR-028）、错误码、10s 超时

import type {
  ExperienceEntry,
  FieldMemory,
  FillReport,
  MemoryWriteItem,
  Profile,
  ResumeDraft,
  Settings
} from "./model/types"

export const MESSAGE_TIMEOUT_MS = 10_000

export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  LLM_UNAVAILABLE: "LLM_UNAVAILABLE",
  NO_PROFILE: "NO_PROFILE",
  TAB_UNAVAILABLE: "TAB_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL: "INTERNAL"
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface Request<T = unknown> {
  type: MessageType
  payload: T
}

export type Response<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, string> } }

export interface MessageMap {
  "profile:get": {
    req: Record<string, never>
    res: Profile & { entries: ExperienceEntry[] }
  }
  "profile:save": {
    req: { profile?: Profile; entries?: ExperienceEntry[] }
    res: Record<string, never>
  }
  "settings:get": { req: Record<string, never>; res: Settings }
  "settings:save": { req: Settings; res: Settings }
  "memory:lookup": {
    req: { signatures: string[] }
    res: Array<{ signature: string; memory: FieldMemory | null }>
  }
  "memory:write": { req: MemoryWriteItem[]; res: Record<string, never> }
  "report:save": { req: FillReport; res: Record<string, never> }
  "report:list": { req: Record<string, never>; res: FillReport[] }
  "resume:confirm": {
    req: {
      draftId: string
      /** 资料库已有数据时必填（FR-010）；首次导入省略 */
      importMode?: "overwrite" | "merge"
      fields: ResumeDraft["fields"]
      entries: ExperienceEntry[]
    }
    res: Record<string, never>
  }
  "resume:discard": { req: { draftId: string }; res: Record<string, never> }
  "autofill:run": { req: { startedAt: number }; res: { sessionId: string } }
  "autofill:event": {
    req: {
      sessionId: string
      phase: "scanning" | "filling" | "done"
      report?: FillReport
    }
    res: Record<string, never>
  }
  "confirm:resolve": {
    req: {
      sessionId: string
      signature: string
      choice: { kind: "pick"; value: string } | { kind: "skip" }
      semanticFieldId?: string
      ambiguous?: boolean
      valueKind?: "text" | "option"
      reportId?: string
    }
    res: Record<string, never>
  }
}

export type MessageType = keyof MessageMap

export type RequestOf<K extends MessageType> = Request<MessageMap[K]["req"]> & { type: K }
export type ResponseOf<K extends MessageType> = Response<MessageMap[K]["res"]>

export function ok<T>(data: T): Response<T> {
  return { ok: true, data }
}

export function fail(
  code: string,
  message: string,
  details?: Record<string, string>
): Response<never> {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } }
}

function withTimeout<T>(promise: Promise<T>, ms = MESSAGE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error("消息超时"), { code: ErrorCode.TIMEOUT })),
      ms
    )
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 扩展内任意上下文 → background */
export async function sendToBackground<K extends MessageType>(
  type: K,
  payload: MessageMap[K]["req"]
): Promise<Response<MessageMap[K]["res"]>> {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime
  if (!runtime?.sendMessage) throw new Error("chrome.runtime 不可用")
  const res = (await withTimeout(
    runtime.sendMessage({ type, payload } as Request) as Promise<Response<MessageMap[K]["res"]>>
  ))
  if (res === undefined) return fail(ErrorCode.INTERNAL, "无响应")
  return res
}

/** background/popup → 指定标签页内容脚本 */
export async function sendToTab<K extends MessageType>(
  tabId: number,
  type: K,
  payload: MessageMap[K]["req"]
): Promise<Response<MessageMap[K]["res"]>> {
  const tabs = (globalThis as { chrome?: typeof chrome }).chrome?.tabs
  if (!tabs?.sendMessage) throw new Error("chrome.tabs 不可用")
  const res = await withTimeout(
    tabs.sendMessage(tabId, { type, payload } as Request) as Promise<
      Response<MessageMap[K]["res"]>
    >
  )
  if (res === undefined) return fail(ErrorCode.INTERNAL, "无响应")
  return res
}

/** 转发器：background 内把请求原样路由到内容脚本并透传响应 */
export async function forwardToTab<K extends MessageType>(
  tabId: number,
  request: Request<MessageMap[K]["req"]> & { type: K }
): Promise<Response<MessageMap[K]["res"]>> {
  return sendToTab(tabId, request.type, request.payload)
}
