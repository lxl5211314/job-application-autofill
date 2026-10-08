// T074: 多段经历自动展开——资料条目多于页面可见行数时，点「添加」类按钮创建新行，
// 新行由既有补扫（FR-016 观察者 + 元素级去重）扫到并按行号填入对应条目。
// 参考牛客「自动点+添加」交互，规则为自研安全边界：
// 1) 只点添加类按钮（严格词表），保存/提交/删除/上一步…黑名单永不触碰（FR-018 精神）
// 2) 按节容器归属按钮：按钮与某类经历字段共享的最近容器须只含这一类——
//    容器横跨多类（歧义）或找不到归属 → 不点
// 3) 每类最多 5 次点击；每次点击必须在超时窗口内观测到行数增长，否则停（不空转）
// 4) 会话已暂停（用户点暂停）→ 不再展开

import { buildFillPlan } from "../matching/match"
import { scanDocument, scanReadonlyFields, type ScannedField } from "../matching/scan"
import type { EntryKind, ExperienceEntry, FieldMemory, Profile } from "../model/types"

/** 添加类按钮文案：+添加 / 添加一条经历 / 新增教育经历 / 加一行 … */
const ADD_LABEL_RE = /^(?:[＋+]\s*)?(?:添加|新增|增加|新建|加一[条项行个段张])/
/** 任何带这些词的按钮都不碰（截断到"添加并保存"这类组合文案） */
const ADD_BLOCK_RE =
  /删除|移除|清空|重置|保存|提交|关闭|取消|完成|上一步|下一步|返回|登录|退出|上传|下载|复制|覆盖/
const MAX_CLICKS_PER_KIND = 5
const GROWTH_TIMEOUT_MS = 1500
const GROWTH_POLL_MS = 150

export interface ExpandOptions {
  doc: Document
  profile: Profile
  entries: ExperienceEntry[]
  /** 与会话共享的记忆表（影响标量匹配，经历行不依赖） */
  memoryBySig?: Map<string, FieldMemory>
  /** ActiveSession.paused 实时读取：已暂停则不再展开 */
  isPaused?: () => boolean
  /** 测试注入：点击间隔轮询（默认 setTimeout 150ms） */
  sleep?: (ms: number) => Promise<void>
}

export interface ExpandResult {
  clicked: number
  addedByKind: Partial<Record<EntryKind, number>>
}

function cleanText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim()
}

function isShowable(el: HTMLElement): boolean {
  if (el.hidden) return false
  if (el.closest("[hidden]")) return false
  if (el.hasAttribute("disabled")) return false
  const style = el.getAttribute("style") ?? ""
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return false
  const cls = typeof el.className === "string" ? el.className : ""
  if (/(?:^|[\s-])(?:hidden|hide|invisible)(?:$|[\s-])/i.test(cls)) return false
  return true
}

function buttonLabel(el: HTMLElement): string {
  if (el instanceof HTMLInputElement) return cleanText(el.value)
  return cleanText(el.textContent)
}

/** 全页「添加」类按钮（严格词表 + 黑名单 + 可见性；排除扩展自己的面板） */
export function findAddButtons(doc: Document): HTMLElement[] {
  const nodes = Array.from(
    doc.querySelectorAll('button, [role="button"], input[type="button"], a')
  ) as HTMLElement[]
  const out: HTMLElement[] = []
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue
    if (el.closest('[id^="job-autofill-"]')) continue
    if (!isShowable(el)) continue
    const text = buttonLabel(el)
    if (text === "" || !ADD_LABEL_RE.test(text)) continue
    if (ADD_BLOCK_RE.test(text)) continue
    out.push(el)
  }
  return out
}

interface Analyze {
  /** 每类当前可见行数（max entryIndex + 1；无匹配字段的类不出现=0） */
  counts: Map<EntryKind, number>
  /** 每类经历字段的元素（按钮归属判定用） */
  elems: Map<EntryKind, Element[]>
}

function analyze(
  doc: Document,
  profile: Profile,
  entries: ExperienceEntry[],
  memoryBySig?: Map<string, FieldMemory>
): Analyze {
  const fields: ScannedField[] = [...scanDocument(doc), ...scanReadonlyFields(doc)]
  const plan = buildFillPlan(fields, profile, entries, { memoryBySig })
  const counts = new Map<EntryKind, number>()
  const elems = new Map<EntryKind, Element[]>()
  for (const item of plan.items) {
    const kind = item.entryKind
    if (kind === undefined) continue
    const list = elems.get(kind)
    if (list) list.push(item.match.field.element)
    else elems.set(kind, [item.match.field.element])
    if (item.entryIndex !== undefined && item.entryIndex >= 0) {
      counts.set(kind, Math.max(counts.get(kind) ?? 0, item.entryIndex + 1))
    }
  }
  return { counts, elems }
}

/** 按钮 → 它所在的「节容器」里出现了哪几类经历字段（自 button 父链向上，
 *  找到第一个含经历字段的祖先即返回；到 body 仍没有 → 空集） */
function kindsNearButton(
  button: HTMLElement,
  doc: Document,
  elems: Map<EntryKind, Element[]>
): Set<EntryKind> {
  const present = new Set<EntryKind>()
  let cur = button.parentElement
  while (cur && cur !== doc.body) {
    present.clear()
    for (const [kind, els] of elems) {
      if (els.some((e) => cur !== null && cur.contains(e))) present.add(kind)
    }
    if (present.size > 0) return new Set(present)
    cur = cur.parentElement
  }
  return present
}

function pickButtonForKind(
  buttons: HTMLElement[],
  kind: EntryKind,
  doc: Document,
  elems: Map<EntryKind, Element[]>
): HTMLElement | null {
  for (const btn of buttons) {
    const kinds = kindsNearButton(btn, doc, elems)
    // 容器恰好只含目标类 → 归属明确；含多类 → 歧义不点
    if (kinds.size === 1 && kinds.has(kind)) return btn
  }
  return null
}

/** 轮询等待行数增长（按次数封顶而非 Date.now——测试注入 sleep 时也不会死等） */
async function waitForGrowth(
  probe: () => boolean,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  const maxPolls = Math.ceil(GROWTH_TIMEOUT_MS / GROWTH_POLL_MS)
  for (let i = 0; i <= maxPolls; i++) {
    if (probe()) return true
    if (i < maxPolls) await sleep(GROWTH_POLL_MS)
  }
  return false
}

function pressLike(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  el.click()
}

export async function expandEntryRows(opts: ExpandOptions): Promise<ExpandResult> {
  const { doc, profile, entries } = opts
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const result: ExpandResult = { clicked: 0, addedByKind: {} }

  const initial = analyze(doc, profile, entries, opts.memoryBySig)
  const needed = new Map<EntryKind, number>()
  for (const kind of new Set<EntryKind>([...initial.counts.keys(), ...entries.map((e) => e.kind)])) {
    const total = entries.filter((e) => e.kind === kind).length
    const have = initial.counts.get(kind) ?? 0
    const need = Math.min(total - have, MAX_CLICKS_PER_KIND)
    if (need > 0) needed.set(kind, need)
  }
  if (needed.size === 0) return result

  for (const [kind, need] of needed) {
    for (let i = 0; i < need; i++) {
      if (opts.isPaused?.()) return result

      const state = analyze(doc, profile, entries, opts.memoryBySig)
      const before = state.counts.get(kind) ?? 0
      const btn = pickButtonForKind(findAddButtons(doc), kind, doc, state.elems)
      if (!btn) break

      pressLike(btn)
      const grew = await waitForGrowth(() => {
        const now = analyze(doc, profile, entries, opts.memoryBySig).counts.get(kind) ?? 0
        return now > before
      }, sleep)
      // 点了但行没涨：按钮可能不是这条节的「添加」，或站点有其他机制——立即停
      if (!grew) break

      result.clicked += 1
      result.addedByKind[kind] = (result.addedByKind[kind] ?? 0) + 1
    }
  }
  return result
}
