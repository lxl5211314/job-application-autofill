// T065-T068: 交互控件驱动层 —— 自定义下拉（combobox）与日历面板（date）
// 只读输入 / div[role=combobox] 触发器：点击打开弹层 → 定位目标项 → 点选 → 回读校验；
// 任一步失败返回 reason "widget"，由 executeFills / confirm-panel 降级「需人工」。
// 黑名单控件（密码/上传/协议/验证码）不会进入这里——scan 阶段已被 manual 排除（FR-019）。

import { findEquivalentOption, normOption } from "../matching/vocabulary"
import type { ScannedField } from "../matching/scan"
import { widgetTriggerText } from "../matching/scan"
import { dateEquivalent, toIsoDate } from "../model/date"
import { setNativeValue, type FillOptions, type FillResult } from "./fill"

function cleanText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim()
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 弹层可见性判定（jsdom/真实页通用：显式 hidden、样式、隐藏类名） */
const HIDDEN_CLASS_RE = /(?:^|[\s-])(?:hidden|hide|invisible)(?:$|[\s-])|dropdown-hidden/i

function isShown(el: Element | null | undefined): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.hidden) return false
  if (el.getAttribute("aria-hidden") === "true") return false
  if (el.closest("[hidden]")) return false
  const style = el.getAttribute("style") ?? ""
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return false
  const cls = typeof el.className === "string" ? el.className : ""
  if (HIDDEN_CLASS_RE.test(cls)) return false
  return true
}

/** 轮询等待弹层渲染（框架常在 click 后异步挂载 popup） */
async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 500,
  stepMs = 20
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = probe()
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await sleep(stepMs)
  }
}

function pressLike(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  el.click()
}

// ---------- combobox：自定义下拉 ----------

const LISTBOX_SELECTORS = [
  '[role="listbox"]',
  '[role="list"]',
  ".ant-select-dropdown",
  ".el-select-dropdown",
  ".el-select-dropdown__list",
  "[class*='select-dropdown']",
  "[class*='select-list']",
  "[class*='select-panel']",
  "[class*='option-list']",
  "[class*='optionList']",
  "[class*='dropdown-menu']"
]

function findListbox(doc: Document): HTMLElement | null {
  for (const sel of LISTBOX_SELECTORS) {
    for (const el of doc.querySelectorAll(sel)) {
      if (isShown(el)) return el as HTMLElement
    }
  }
  return null
}

function optionElementsOf(listbox: Element): HTMLElement[] {
  const primary = Array.from(
    listbox.querySelectorAll('[role="option"], li, dd, [class*="dropdown__item"], [class*="select-item"]')
  )
  const pool = primary.length > 0 ? primary : Array.from(listbox.querySelectorAll('[class*="option"]'))
  return pool.filter((el) => isShown(el) && cleanText(el.textContent) !== "") as HTMLElement[]
}

function findSearchInput(trigger: HTMLElement): HTMLInputElement | null {
  if (trigger instanceof HTMLInputElement) return trigger
  return trigger.querySelector<HTMLInputElement>(
    'input[role="combobox"], input[class*="search"], input[class*="input"], input[type="text"]'
  )
}

function readTriggerValue(el: HTMLElement): string {
  const raw = widgetTriggerText(el)
  if (raw !== "") return raw
  const input = el instanceof HTMLInputElement ? el : el.querySelector("input")
  return cleanText(input?.value)
}

/** 长列表兜底：规范串互相包含（资料「硕士研究生」↔选项「硕士」这类不完全同形） */
function looseOptionMatch(value: string, texts: string[]): string | null {
  const nv = normOption(value)
  if (nv === "") return null
  return texts.find((t) => {
    const nt = normOption(t)
    return nt !== "" && (nt.includes(nv) || nv.includes(nt))
  }) ?? null
}

async function fillCombobox(field: ScannedField, value: string): Promise<FillResult> {
  const trigger = field.element as unknown as HTMLElement

  // 已回显等价值 → 不点开面板直接成功
  const current = readTriggerValue(trigger)
  if (current !== "" && findEquivalentOption(value, [current])) {
    return { filled: true, appliedValue: current }
  }

  pressLike(trigger)
  let listbox = await waitFor(() => findListbox(trigger.ownerDocument))

  if (!listbox) {
    // 部分实现箭头图标独立可点（suffix/arrow 节点）
    const arrow = trigger.querySelector<HTMLElement>(
      "[class*='arrow'], [class*='caret'], [class*='suffix'], [class*='icon'], [class*='down']"
    )
    if (arrow) {
      pressLike(arrow)
      listbox = await waitFor(() => findListbox(trigger.ownerDocument))
    }
  }
  if (!listbox) return { filled: false, reason: "widget" }

  let texts = optionElementsOf(listbox).map((o) => cleanText(o.textContent))
  let equiv = findEquivalentOption(value, texts) ?? looseOptionMatch(value, texts)

  // 未命中 → 尝试触发器内输入框键入过滤（可搜索下拉）
  if (!equiv) {
    const search = findSearchInput(trigger)
    if (search && search !== (trigger as unknown as HTMLInputElement)) {
      setNativeValue(search, value)
      await sleep(60)
      listbox = (await waitFor(() => findListbox(trigger.ownerDocument))) ?? listbox
      texts = optionElementsOf(listbox).map((o) => cleanText(o.textContent))
      equiv = findEquivalentOption(value, texts) ?? looseOptionMatch(value, texts)
    }
  }
  if (!equiv) return { filled: false, reason: "no_match" }

  const target = optionElementsOf(listbox).find((o) => cleanText(o.textContent) === equiv)
  if (!target) return { filled: false, reason: "no_match" }
  pressLike(target)

  await sleep(40)
  const after = readTriggerValue(trigger)
  if (
    after !== "" &&
    (findEquivalentOption(value, [after]) !== null ||
      normOption(after) === normOption(equiv) ||
      normOption(after).includes(normOption(equiv)))
  ) {
    return { filled: true, appliedValue: after }
  }
  if (!findListbox(trigger.ownerDocument)) {
    // 弹层已关闭：框架已消费选项（回显可能在 hidden input / 事件回调里）
    return { filled: true, appliedValue: equiv }
  }
  return { filled: false, reason: "widget" }
}

// ---------- date：日历面板 ----------

const DATE_PANEL_SELECTORS = [
  ".ant-picker-dropdown",
  ".el-picker-panel",
  ".el-date-panel",
  ".el-date-table",
  ".layui-laydate",
  ".w-picker",
  "[class*='datepicker']",
  "[class*='date-picker']",
  "[class*='datePanel']",
  "[class*='date-panel']",
  "[class*='calendar']"
]

function findDatePanel(doc: Document): HTMLElement | null {
  for (const sel of DATE_PANEL_SELECTORS) {
    for (const el of doc.querySelectorAll(sel)) {
      if (!isShown(el)) continue
      if (el.querySelector('td, [role="gridcell"], [class*="cell"]')) return el as HTMLElement
    }
  }
  return null
}

interface TargetDate {
  y: number
  m: number
  d: number
  iso: string
}

function isOtherMonthCell(cell: Element): boolean {
  const cls = typeof cell.className === "string" ? cell.className : ""
  return /(^|[\s-])(?:prev|next|other)(?:$|[\s-])/.test(cls)
}

function findDayCell(panel: HTMLElement, target: TargetDate): HTMLElement | null {
  const direct = panel.querySelector<HTMLElement>(
    `td[title="${target.iso}"], [data-date="${target.iso}"], td[data-value="${target.iso}"], [data-time="${target.iso}"]`
  )
  if (direct) return direct

  // Element UI：td[data-time]=本地时间戳
  const stamp = new Date(target.y, target.m - 1, target.d).getTime()
  const cells = panel.querySelectorAll<HTMLElement>('td, [role="gridcell"], [class*="-cell"]')
  for (const c of cells) {
    const ts = c.getAttribute("data-time")
    if (ts && Number(ts) === stamp) return c
  }
  // 当前视图月份内的日号文本直选（非 prev/next 月的单元格）
  for (const c of cells) {
    if (isOtherMonthCell(c)) continue
    if (cleanText(c.textContent) === String(target.d)) return c
  }
  return null
}

/** 面板头年月（1999年9月 / 1999-09 等）→ { y, m } */
function parseHeaderDate(text: string): { y: number; m: number } | null {
  const zh = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月?/)
  if (zh) return { y: Number(zh[1]), m: Number(zh[2]) }
  const isoish = text.match(/(\d{4})\s*[-/.]\s*(\d{1,2})/)
  if (isoish) return { y: Number(isoish[1]), m: Number(isoish[2]) }
  return null
}

/** 面板内原生年/月下拉（部分 HR 系统日历头部就是 select） */
async function applyHeaderSelects(panel: HTMLElement, target: TargetDate): Promise<boolean> {
  const selects = Array.from(panel.querySelectorAll("select")) as HTMLSelectElement[]
  if (selects.length === 0) return false
  let changed = false
  for (const s of selects) {
    const texts = Array.from(s.options).map((o) => cleanText(o.textContent))
    const isYear = texts.some((t) => /^\d{4}/.test(t))
    const isMonth =
      texts.some((t) => /月$/.test(t)) ||
      (texts.length > 0 && texts.length <= 12 && texts.every((t) => /^\d{1,2}$/.test(t)))
    if (isYear) {
      const opt = Array.from(s.options).find((o) => cleanText(o.textContent).includes(String(target.y)))
      if (opt && opt.value !== s.value) {
        setNativeValue(s, opt.value)
        changed = true
      }
    } else if (isMonth) {
      const opt = Array.from(s.options).find((o) => {
        const t = cleanText(o.textContent)
        const digits = t.replace(/[^0-9]/g, "")
        return t.includes(`${target.m}月`) || digits === String(target.m) || digits === String(target.m).padStart(2, "0")
      })
      if (opt && opt.value !== s.value) {
        setNativeValue(s, opt.value)
        changed = true
      }
    }
  }
  if (changed) await sleep(50)
  return changed
}

/** 头部 prev/next 箭头翻页到目标年月（有界循环，防死循环） */
async function navigateToTarget(panel: HTMLElement, target: TargetDate): Promise<void> {
  const header = panel.querySelector<HTMLElement>(
    "[class*='header'], [class*='toolbar'], [class*='top'], [class*='title'], [class*='hd']"
  )
  if (!header) return
  const parse = (): { y: number; m: number } | null => parseHeaderDate(header.textContent ?? "")

  for (let i = 0; i < 400; i++) {
    const cur = parse()
    if (!cur) return
    if (cur.y === target.y && cur.m === target.m) return
    const goPrev = cur.y > target.y || (cur.y === target.y && cur.m > target.m)
    const sel = goPrev
      ? "[class*='prev'], [aria-label*='上一'], [title*='上一'], [class*='backward'], [class*='icon-left'], [class*='icon-back']"
      : "[class*='next'], [aria-label*='下一'], [title*='下一'], [class*='forward'], [class*='icon-right']"
    const btn = header.querySelector<HTMLElement>(sel) ?? panel.querySelector<HTMLElement>(sel)
    if (!btn) return
    const before = `${cur.y}-${cur.m}`
    btn.click()
    await sleep(15)
    const after = parse()
    if (!after || `${after.y}-${after.m}` === before) return // 无进展 → 停
  }
}

async function fillDateWidget(field: ScannedField, value: string): Promise<FillResult> {
  const input = field.element as unknown as HTMLInputElement

  // 已是等价日期 → 直接成功（预填值场景不点开面板）
  const current = (input.value ?? "").trim()
  if (current !== "" && dateEquivalent(current, value)) {
    return { filled: true, appliedValue: current }
  }

  const iso = toIsoDate(value)
  if (!iso) return { filled: false, reason: "no_match" }
  const parts = iso.split("-")
  const target: TargetDate = {
    y: Number(parts[0]),
    m: Number(parts[1]),
    d: Number(parts[2]),
    iso
  }

  // 1) 可编辑且是原生 date 输入 → 直接归一化写入
  if (!input.readOnly && input.type === "date") {
    setNativeValue(input, iso)
    if ((input.value ?? "").trim() === iso) return { filled: true, appliedValue: iso }
    return { filled: false, reason: "widget" }
  }

  // 2) 打开面板：点击输入框（部分实现在输入框旁的日历图标上）
  input.click()
  let panel = await waitFor(() => findDatePanel(input.ownerDocument))
  if (!panel) {
    const icon = input.parentElement?.querySelector<HTMLElement>(
      "[class*='calendar'], [class*='date-icon'], [class*='icon-date'], [class*='icon-calendar'], [aria-label*='日历']"
    )
    if (icon) {
      icon.click()
      panel = await waitFor(() => findDatePanel(input.ownerDocument))
    }
  }
  if (!panel) return { filled: false, reason: "widget" }

  // 3) 定位日期单元格：直选 → 年月下拉 → prev/next 翻页 → 再直选
  let cell = findDayCell(panel, target)
  if (!cell) {
    if (await applyHeaderSelects(panel, target)) {
      cell = findDayCell(panel, target)
    }
  }
  if (!cell) {
    await navigateToTarget(panel, target)
    cell = findDayCell(panel, target)
  }
  if (!cell) return { filled: false, reason: "widget" }
  pressLike(cell)

  // 4) 回读校验
  await sleep(50)
  const now = (input.value ?? "").trim()
  if (now !== "" && (now === iso || dateEquivalent(now, iso))) {
    return { filled: true, appliedValue: now }
  }
  // 框架把值写进相邻 hidden input 的兜底
  const hidden = input.parentElement?.querySelector<HTMLInputElement>('input[type="hidden"]')
  if (hidden && dateEquivalent(hidden.value, iso)) {
    return { filled: true, appliedValue: hidden.value }
  }
  return { filled: false, reason: "widget" }
}

// ---------- 入口 ----------

/** T066-T067：widget 字段填充——下拉点选 / 日历驱动；失败 reason="widget" 降级需人工 */
export async function fillWidgetField(
  field: ScannedField,
  value: string,
  _opts: FillOptions = {}
): Promise<FillResult> {
  if (value.trim() === "") return { filled: false, reason: "no_value" }
  const el = field.element as unknown as HTMLElement & { disabled?: boolean }
  if (el.disabled) return { filled: false, reason: "disabled" }

  if (field.widget === "date") return fillDateWidget(field, value)
  return fillCombobox(field, value)
}
