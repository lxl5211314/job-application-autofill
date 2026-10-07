// T033/T036: 页内确认面板（FR-013 拿不准不乱填、FR-022 歧义说明、T036 无候选自定义值）
// 候选值逐字来自页面选项（select/radio）或资料库值；点选 → 填入页面 + confirm:resolve；
// 跳过 → 不填不记忆（FR-023）

import { fillField } from "../filling/fill"
import type { ActiveSession } from "../filling/session-state"
import { planReportLabel, type FillPlanItem } from "../matching/match"
import { sendToBackground } from "../messaging"
import { maskValue } from "../model/mask"
import type { FillItemStatus, FillReportItem } from "../model/types"
import { el } from "./dom"
import { createPanel } from "./panel-host"
import { renderResultPanel } from "./result-panel"

const PANEL_ID = "confirm"

export function statusText(status: FillItemStatus): string {
  return {
    filled: "已填写",
    needs_confirm: "待确认",
    not_found: "未找到",
    missing_in_profile: "资料缺失",
    manual_required: "需人工处理"
  }[status]
}

function pendingItems(session: ActiveSession): FillPlanItem[] {
  return session.executed.filter((i) => i.action === "confirm" && !session.resolved.has(i))
}

/** 可选候选：select/radio 用页面选项原文；否则用计划值（资料库/记忆值） */
function candidatesOf(item: FillPlanItem): string[] {
  const field = item.match.field
  if (field.controlKind === "select" || field.controlKind === "radio") {
    return (field.optionTexts ?? []).filter((o) => o.trim() !== "")
  }
  if (item.value && item.value.trim() !== "") return [item.value]
  return []
}

function findReportItem(session: ActiveSession, item: FillPlanItem): FillReportItem | undefined {
  const id = item.match.semanticFieldId
  if (id) {
    const byId = session.reportItems.find(
      (r) => r.semanticFieldId === id && r.status === "needs_confirm"
    )
    if (byId) return byId
  }
  const labelText = item.match.field.labelText || item.match.field.nameIdPlaceholder
  return session.reportItems.find(
    (r) => r.status === "needs_confirm" && (r.label === labelText || r.label === id)
  )
}

function markResolved(session: ActiveSession, item: FillPlanItem, value: string): void {
  const reportItem = findReportItem(session, item)
  if (reportItem) {
    reportItem.status = "filled"
    reportItem.value = maskValue(reportItem.semanticFieldId, value)
    delete reportItem.reason
  }
  session.resolved.add(item)
  // T035: 同步刷新结果面板（FR-014 状态即时可见）
  if (session.report) renderResultPanel(session.report)
}

function resolve(
  session: ActiveSession,
  item: FillPlanItem,
  choice: { kind: "pick"; value: string } | { kind: "skip" },
  valueKind: "text" | "option"
): void {
  void sendToBackground("confirm:resolve", {
    sessionId: session.sessionId,
    signature: item.match.field.signature,
    choice,
    semanticFieldId: item.match.semanticFieldId ?? undefined,
    ambiguous: item.match.ambiguous,
    valueKind,
    reportId: session.reportId
  })
  // 报告条目已在 markResolved 就地更新（含 semanticFieldId=null 的歧义项），重存一次持久化（FR-014）
  if (session.report) void sendToBackground("report:save", session.report)
}

// P2-2：确认项按原因分组展示（先看真歧义/页面冲突，噪音类靠后）
const GROUPS: Array<{ title: string; test: (item: FillPlanItem) => boolean }> = [
  { title: "标签有歧义（可能对应多个字段），请选择", test: (i) => i.match.ambiguous },
  { title: "页面已有值与资料库不一致（不自动覆盖）", test: (i) => /页面已有内容/.test(i.reason ?? "") },
  { title: "下拉/单选选项与资料库措辞不一致", test: (i) => /选项措辞/.test(i.reason ?? "") },
  { title: "资料库字段待核对", test: (i) => /待核对/.test(i.reason ?? "") },
  { title: "其他待确认", test: () => true }
]

function reportStatsLine(session: ActiveSession): string | null {
  const report = session.report
  if (!report) return null
  let filled = 0
  let notFound = 0
  let manual = 0
  for (const item of report.items) {
    if (item.status === "filled") filled += 1
    else if (item.status === "not_found") notFound += 1
    else if (item.status === "manual_required") manual += 1
  }
  return `本次已填 ${filled} · 未找到 ${notFound} · 需人工 ${manual}`
}

/** 渲染（或复用）确认面板；仅列出仍待确认的 confirm 项 */
export function renderConfirmPanel(session: ActiveSession): void {
  const pending = pendingItems(session)
  const panel = createPanel(PANEL_ID)
  if (pending.length === 0) {
    panel.destroy()
    return
  }

  const header = el(
    "h3",
    {},
    [`需要你确认（${pending.length}）`]
  )
  const close = el(
    "button",
    {
      className: "close",
      type: "button",
      "aria-label": "关闭",
      onClick: () => panel.destroy()
    },
    ["×"]
  )
  header.append(close)

  const root = el("div", { className: "panel-section" })

  const rerender = (): void => renderConfirmPanel(session)

  const assigned = new Set<FillPlanItem>()
  for (const group of GROUPS) {
    const inGroup = pending.filter((i) => !assigned.has(i) && group.test(i))
    if (inGroup.length === 0) continue
    inGroup.forEach((i) => assigned.add(i))
    root.append(
      el(
        "div",
        { style: "font-size:12px;font-weight:600;color:#374151;margin:10px 0 2px" },
        [`${group.title}（${inGroup.length}）`]
      )
    )

    for (const item of inGroup) {
      const card = el("div", {
        className: "panel-item",
        style:
          "flex-direction:column;align-items:stretch;gap:4px;padding:8px 0;border-bottom:1px solid #f3f4f6"
      })

      // P2-1：标题用可读中文（语义字段名优先），页面原始标识降级为副行
      const pageLabel =
        item.match.field.labelText || item.match.field.nameIdPlaceholder || "(未识别字段)"
      const primary = planReportLabel(item.match)
      card.append(el("div", { className: "label" }, [primary]))
      if (primary !== pageLabel) {
        card.append(
          el("div", { className: "ambiguous-note", style: "color:#9ca3af" }, [
            `页面字段：${pageLabel}`
          ])
        )
      }

      if (item.match.ambiguous) {
        card.append(
          el("div", { className: "ambiguous-note" }, [
            "该标签存在歧义（可能对应多个字段），请手动选择（FR-022）"
          ])
        )
      }
      if (item.reason) {
        card.append(el("div", { className: "ambiguous-note", style: "color:#6b7280" }, [item.reason]))
      }

      const candidates = candidatesOf(item)
      const valueKind: "text" | "option" =
        item.match.field.controlKind === "select" || item.match.field.controlKind === "radio"
          ? "option"
          : "text"

      const pick = (value: string): void => {
        const result = fillField(item.match.field, value, { allowConflict: true })
        if (!result.filled) {
          card.append(el("div", { className: "ambiguous-note" }, [`填入失败（${result.reason}）`]))
          return
        }
        const applied = result.appliedValue ?? value
        markResolved(session, item, applied)
        resolve(session, item, { kind: "pick", value: applied }, valueKind)
        rerender()
      }

      const options = el("div", { className: "confirm-options" })
      for (const candidate of candidates) {
        const btn = el("button", { type: "button", onClick: () => pick(candidate) }, [candidate])
        options.append(btn)
      }
      card.append(options)

      // T036: 无候选（或都不合适）→ 自定义值
      const custom = el("div", { className: "confirm-custom" })
      const input = el("input", {
        type: "text",
        placeholder: candidates.length === 0 ? "无候选，请输入值…" : "或输入自定义值…"
      }) as HTMLInputElement
      const okBtn = el("button", { className: "primary", type: "button" }, ["填入"])
      okBtn.addEventListener("click", () => {
        const value = input.value.trim()
        if (value === "") return
        pick(value)
      })
      custom.append(input, okBtn)
      card.append(custom)

      const actions = el("div", { className: "confirm-actions" })
      const skipBtn = el("button", { type: "button" }, ["跳过（保持页面原状）"])
      skipBtn.addEventListener("click", () => {
        // 跳过：不填、不写记忆（FR-023）；报告条目保持 needs_confirm
        session.resolved.add(item)
        resolve(session, item, { kind: "skip" }, valueKind)
        rerender()
      })
      actions.append(skipBtn)
      card.append(actions)

      root.append(card)
    }
  }

  const statsLine = reportStatsLine(session)
  const stats = statsLine
    ? el("div", { className: "ambiguous-note", style: "color:#6b7280" }, [statsLine])
    : null

  panel.root.replaceChildren(header, ...(stats ? [stats] : []), root)
}

/** T034 入口：会话结束后若有待确认条目则弹出确认面板 */
export function showConfirmPanel(session: ActiveSession): void {
  renderConfirmPanel(session)
}
