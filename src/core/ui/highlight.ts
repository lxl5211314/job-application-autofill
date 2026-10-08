// T069: 填写现场反馈——滚动跟随到当前字段 + 黄色高亮（参考牛客交互，自研实现）
// 用 CSSOM 直接写行内 outline（不注入页面样式表，规避站点 CSP style-src）

import type { FillPlanItem } from "../matching/match"

interface SavedOutline {
  outline: string
  outlinePriority: string
  offset: string
  offsetPriority: string
  timer: ReturnType<typeof setTimeout> | null
}

const saved = new WeakMap<HTMLElement, SavedOutline>()
const HL_OUTLINE = "3px solid #f59e0b"

/** 滚动到目标字段视野中央并高亮 1.5s（多次调用刷新计时，恢复原行内样式） */
export function focusField(el: Element): void {
  if (!(el instanceof HTMLElement)) return

  if (typeof el.scrollIntoView === "function") {
    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" })
    } catch {
      try {
        el.scrollIntoView()
      } catch {
        // jsdom/极老浏览器：忽略滚动，仅高亮
      }
    }
  }

  let state = saved.get(el)
  if (!state) {
    state = {
      outline: el.style.getPropertyValue("outline"),
      outlinePriority: el.style.getPropertyPriority("outline"),
      offset: el.style.getPropertyValue("outline-offset"),
      offsetPriority: el.style.getPropertyPriority("outline-offset"),
      timer: null
    }
    saved.set(el, state)
  } else if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }

  el.style.setProperty("outline", HL_OUTLINE, "important")
  el.style.setProperty("outline-offset", "2px", "important")

  state.timer = setTimeout(() => {
    restore(el, state as SavedOutline)
    saved.delete(el)
  }, 1500)
}

function restore(el: HTMLElement, state: SavedOutline): void {
  if (state.outline === "") el.style.removeProperty("outline")
  else el.style.setProperty("outline", state.outline, state.outlinePriority)
  if (state.offset === "") el.style.removeProperty("outline-offset")
  else el.style.setProperty("outline-offset", state.offset, state.offsetPriority)
  state.timer = null
}

// ---------- T078: 未填标红（P4）——会话结束时把「待确认/资料缺失/需人工」的
// 页面字段画红色行内描边，帮用户在页面上一眼定位剩余工作；
// 用户在确认面板点选成功后 unmark 恢复原样式（跳过则保留红色）。

const UNFILLED_OUTLINE = "2px solid #ef4444"

interface SavedMark {
  outline: string
  outlinePriority: string
  offset: string
  offsetPriority: string
}

const marked = new WeakMap<HTMLElement, SavedMark>()

/** 标红一个未填字段（幂等）；若该元素正处于黄色高亮计时中，先还原再标红 */
export function markUnfilled(el: Element): void {
  if (!(el instanceof HTMLElement)) return

  const pending = saved.get(el)
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer)
    restore(el, pending)
    saved.delete(el)
  }

  if (marked.has(el)) return
  marked.set(el, {
    outline: el.style.getPropertyValue("outline"),
    outlinePriority: el.style.getPropertyPriority("outline"),
    offset: el.style.getPropertyValue("outline-offset"),
    offsetPriority: el.style.getPropertyPriority("outline-offset")
  })
  el.style.setProperty("outline", UNFILLED_OUTLINE, "important")
  el.style.setProperty("outline-offset", "2px", "important")
}

/** 撤销标红（确认面板点选成功后调用）；未标过则无操作 */
export function unmarkUnfilled(el: Element): void {
  if (!(el instanceof HTMLElement)) return
  const orig = marked.get(el)
  if (!orig) return
  marked.delete(el)
  if (orig.outline === "") el.style.removeProperty("outline")
  else el.style.setProperty("outline", orig.outline, orig.outlinePriority)
  if (orig.offset === "") el.style.removeProperty("outline-offset")
  else el.style.setProperty("outline-offset", orig.offset, orig.offsetPriority)
}

/** T078: 该计划条目是否要在页面上标红。
   * 待确认/资料缺失 → 必标；manual 里的「只读/交互失败/已暂停」是确实没填上的
   * 页面字段 → 标；非填写区黑名单（密码/提交）是刻意跳过 → 不标（噪音）；
   * skip（弱信号降噪）与已填字段 → 不标 */
export function shouldMarkUnfilled(item: FillPlanItem): boolean {
  if (item.action === "confirm" || item.action === "missing") return true
  if (item.action === "manual") {
    return /只读控件|控件交互失败|已暂停/.test(item.reason ?? "")
  }
  return false
}

/** T078: 批量标红会话中未填的页面字段（幂等，可重复调用） */
export function markUnfilledItems(items: FillPlanItem[]): void {
  for (const item of items) {
    if (shouldMarkUnfilled(item)) markUnfilled(item.match.field.element)
  }
}
