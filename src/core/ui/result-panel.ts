// T024: 填写结果面板（FR-013 报告清单 / S8）
// T041: 已填条目上的「记住本次修改」显式触发（FR-020；未点击不监听不写入）

import { getActiveSession } from "../filling/session-state"
import { currentValueOf } from "../matching/match"
import { sendToBackground } from "../messaging"
import type { FillReport, FillItemStatus } from "../model/types"
import { createPanel } from "./panel-host"

const PANEL_ID = "result"

const STATUS_TEXT: Record<FillItemStatus, string> = {
  filled: "已填写",
  needs_confirm: "需确认",
  not_found: "未找到",
  missing_in_profile: "资料缺失",
  manual_required: "需人工处理"
}

function countByStatus(report: FillReport): Record<FillItemStatus, number> {
  const counts: Record<FillItemStatus, number> = {
    filled: 0,
    needs_confirm: 0,
    not_found: 0,
    missing_in_profile: 0,
    manual_required: 0
  }
  for (const item of report.items) counts[item.status] += 1
  return counts
}

/** T041: 「记住本次修改」——读取页面当前值显式写入记忆（source = user_edit, FR-020） */
function rememberButton(semanticFieldId: string | null, label: string): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "remember-btn"
  btn.textContent = "记住本次修改"
  btn.title = "把该字段在页面上的当前值记为本机记忆（仅本次点击才写入）"
  btn.addEventListener("click", () => {
    const session = getActiveSession()
    const planItem = session?.executed.find(
      (i) =>
        i.match.semanticFieldId === semanticFieldId &&
        i.match.field.labelText === label &&
        (i.action === "fill" || i.action === "confirm")
    )
    if (!session || !planItem || !semanticFieldId) {
      btn.textContent = "会话已结束，无法记住"
      btn.disabled = true
      return
    }
    const field = planItem.match.field
    const value = currentValueOf(field)
    if (value.trim() === "") {
      btn.textContent = "页面当前值为空"
      return
    }
    const valueKind = field.controlKind === "select" || field.controlKind === "radio"
      ? "option"
      : "text"
    void sendToBackground("memory:write", [
      {
        signature: field.signature,
        semanticFieldId,
        ambiguous: false,
        value,
        valueKind,
        source: "user_edit"
      }
    ]).then((res) => {
      btn.textContent = res.ok ? "已记住本机（user_edit）" : `记住失败：${res.error.message}`
      btn.disabled = true
    })
  })
  return btn
}

/** 渲染（或复用）右下角结果面板 */
export function renderResultPanel(report: FillReport): void {
  const panel = createPanel(PANEL_ID)
  const counts = countByStatus(report)

  const header = document.createElement("h3")
  const title = document.createElement("span")
  title.textContent = `填写结果（${report.items.length}）`
  const close = document.createElement("button")
  close.className = "close"
  close.type = "button"
  close.setAttribute("aria-label", "关闭")
  close.textContent = "×"
  close.addEventListener("click", () => panel.destroy())
  header.append(title, close)

  const summary = document.createElement("div")
  summary.className = "panel-section"
  const summaryLine = document.createElement("div")
  summaryLine.textContent = `已填 ${counts.filled} · 待确认 ${counts.needs_confirm} · 未找到 ${counts.not_found} · 缺资料 ${counts.missing_in_profile} · 需人工 ${counts.manual_required}`
  summary.appendChild(summaryLine)

  const list = document.createElement("div")
  list.className = "panel-section"
  for (const item of report.items) {
    const row = document.createElement("div")
    row.className = "panel-item"

    const label = document.createElement("span")
    label.className = "label"
    label.textContent = item.label
    if (item.reason) label.title = item.reason

    const right = document.createElement("span")
    right.className = "value"
    if (item.value) right.textContent = `${item.value} `
    const chip = document.createElement("span")
    chip.className = `status-chip ${item.status}`
    chip.textContent = STATUS_TEXT[item.status]
    right.appendChild(chip)

    row.append(label, right)
    // T041: 已填条目才提供显式记忆触发（FR-020）
    if (item.status === "filled" && item.semanticFieldId) {
      row.appendChild(rememberButton(item.semanticFieldId, item.label))
    }
    list.appendChild(row)
  }

  const footer = document.createElement("div")
  footer.className = "panel-section"
  const note = document.createElement("div")
  note.style.color = "#6b7280"
  note.style.fontSize = "11px"
  note.textContent = "数据仅存本机，未上传任何网站。"
  footer.appendChild(note)

  panel.root.replaceChildren(header, summary, list, footer)
}

// ---------- P2: 实时进度面板（填写期间占位，finalize 后被 renderResultPanel 覆盖） ----------

export interface ProgressView {
  done: number
  total: number
  current?: string
  paused?: boolean
  /** 匹配到的计划项总数（含确认/未找到，供头部一次展示） */
  matched?: number
}

/** 渲染（或复用）右下角实时进度面板；与结果面板共用宿主，最终渲染自动覆盖 */
export function renderProgressPanel(view: ProgressView): void {
  const panel = createPanel(PANEL_ID)

  const header = document.createElement("h3")
  const title = document.createElement("span")
  title.textContent = view.paused ? "已暂停" : "正在填写…"
  header.append(title)

  const section = document.createElement("div")
  section.className = "panel-section"

  const line = document.createElement("div")
  line.textContent = view.paused
    ? `已填 ${view.done}/${view.total}，剩余字段归入「需人工」`
    : `已填 ${view.done}/${view.total}${view.matched !== undefined ? ` · 匹配 ${view.matched} 项` : ""}`
  section.appendChild(line)

  if (!view.paused && view.current) {
    const cur = document.createElement("div")
    cur.style.color = "#6b7280"
    cur.style.fontSize = "12px"
    cur.style.marginTop = "2px"
    cur.textContent = `当前：${view.current}`
    section.appendChild(cur)
  }

  const bar = document.createElement("div")
  bar.className = "panel-progress"
  const fillBar = document.createElement("div")
  fillBar.className = "panel-progress-fill"
  const pct = view.total > 0 ? Math.round((view.done / view.total) * 100) : 0
  fillBar.style.width = `${pct}%`
  if (view.paused) fillBar.style.background = "#9ca3af"
  bar.appendChild(fillBar)
  section.appendChild(bar)

  const footer = document.createElement("div")
  footer.className = "panel-section"
  if (view.paused) {
    const note = document.createElement("div")
    note.style.color = "#6b7280"
    note.style.fontSize = "11px"
    note.textContent = "已暂停：本次不再自动填写任何字段。"
    footer.appendChild(note)
  } else {
    const pauseBtn = document.createElement("button")
    pauseBtn.type = "button"
    pauseBtn.className = "remember-btn"
    pauseBtn.textContent = "暂停（剩余转需人工）"
    pauseBtn.title = "停止自动填写，剩余字段归入「需人工」由你自己操作"
    pauseBtn.addEventListener("click", () => {
      const session = getActiveSession()
      if (session) session.paused = true
      pauseBtn.textContent = "已暂停"
      pauseBtn.disabled = true
    })
    footer.appendChild(pauseBtn)
  }

  panel.root.replaceChildren(header, section, footer)
}
