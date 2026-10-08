// T013/T023: 内容脚本 — 填写会话编排（FR-011/016/017/018/019）
// scan → memory:lookup → match → fill → MutationObserver 补扫（300ms 防抖，
// 主窗口 3s + 补扫 ≤5s，research R5/R8）→ FillReport（掩码）→ report:save → 结果面板

import { executeFills, type FillProgress, type ExecuteContext } from "../core/filling/execute"
import { expandEntryRows } from "../core/filling/expand"
import { setActiveSession, type ActiveSession } from "../core/filling/session-state"
import { maskValue } from "../core/model/mask"
import type {
  FieldMemory,
  FillReport,
  FillReportItem,
  Profile
} from "../core/model/types"
import { buildFillPlan, planReportLabel, type FillPlanItem } from "../core/matching/match"
import { scanDocument, scanReadonlyFields, type ScannedField } from "../core/matching/scan"
import { semanticFieldLabel } from "../core/matching/vocabulary"
import { sendToBackground, ok, type Request, type Response } from "../core/messaging"
import { showConfirmPanel } from "../core/ui/confirm-panel"
import { markUnfilledItems } from "../core/ui/highlight"
import { renderProgressPanel, renderResultPanel } from "../core/ui/result-panel"

export const config = {
  matches: ["http://*/*", "https://*/*"],
  run_at: "document_idle",
  all_frames: false
}

const MAIN_WINDOW_MS = 3_000
const RESCAN_BUDGET_MS = 5_000
const RESCAN_DEBOUNCE_MS = 300

let sessionCounter = 0

function newSessionId(): string {
  sessionCounter += 1
  return `s-${Date.now().toString(36)}-${sessionCounter}`
}

function newReportId(): string {
  return `r-${Date.now().toString(36)}-${sessionCounter}`
}

function emit(
  sessionId: string,
  phase: "scanning" | "filling" | "done",
  report?: FillReport,
  progress?: { done: number; total: number; current?: string; matched?: number; paused?: boolean }
): void {
  void sendToBackground("autofill:event", { sessionId, phase, report, progress }).catch(() => {
    // fire-and-forget：popup 可能已关闭
  })
}

function reportItemFromPlan(item: FillPlanItem): FillReportItem {
  const label = planReportLabel(item.match)
  const id = item.match.semanticFieldId
  switch (item.action) {
    case "fill":
      return {
        semanticFieldId: id,
        label,
        status: "filled",
        value: maskValue(id, item.value ?? "")
      }
    case "confirm":
      return {
        semanticFieldId: id,
        label,
        status: "needs_confirm",
        value: item.value !== undefined ? maskValue(id, item.value) : undefined,
        reason: item.reason
      }
    case "missing":
      return { semanticFieldId: id, label, status: "missing_in_profile", reason: item.reason }
    case "skip":
      // P1-3：低置信弱信号跳过 → 报告归「未找到」并附原因（不进确认面板）
      return { semanticFieldId: id, label, status: "not_found", reason: item.reason }
    case "manual":
      return {
        semanticFieldId: id,
        label,
        status: "manual_required",
        reason: item.reason
      }
  }
}

/** P2: 进度回调——渲染页面实时进度面板 + 转发 autofill:event（popup 步骤清单用） */
function progressCtx(session: ActiveSession, matched: number): ExecuteContext {
  return {
    counter: session.progress,
    isPaused: () => session.paused,
    onProgress: (p: FillProgress): void => {
      renderProgressPanel({
        done: p.done,
        total: p.total,
        current: p.current,
        paused: session.paused,
        matched
      })
      emit(session.sessionId, "filling", undefined, {
        done: p.done,
        total: p.total,
        current: p.current,
        matched,
        paused: session.paused
      })
    }
  }
}

function scalarIdsMissingFromPage(
  profile: Profile,
  covered: Set<string>
): string[] {
  const out: string[] = []
  const all: Record<string, { value: string } | undefined> = {
    ...profile.basics,
    ...profile.intent
  }
  for (const [id, field] of Object.entries(all)) {
    if (field && field.value.trim() !== "" && !covered.has(id)) out.push(id)
  }
  return out
}

function collectReportItems(session: ActiveSession): FillReportItem[] {
  const items: FillReportItem[] = session.executed.map(reportItemFromPlan)
  for (const id of scalarIdsMissingFromPage(session.profile, session.coveredIds)) {
    // T060：FR-014 未找到条目显示中文语义名（basic.school → 学校），不暴露内部 ID
    items.push({ semanticFieldId: id, label: semanticFieldLabel(id), status: "not_found" })
  }
  return items
}

function finalize(session: ActiveSession): FillReport {
  const report: FillReport = {
    id: session.reportId,
    hostname: location.hostname,
    url: location.href,
    createdAt: Date.now(),
    usedLlm: false,
    items: collectReportItems(session)
  }
  return report
}

// ---------- 补扫（FR-016） ----------

const processedElements = new WeakSet<Element>()

function markProcessed(fields: ScannedField[]): void {
  for (const f of fields) {
    if (f.radioGroup) f.radioGroup.forEach((r) => processedElements.add(r))
    processedElements.add(f.element)
  }
}

function newFieldsOnly(fields: ScannedField[]): ScannedField[] {
  return fields.filter(
    (f) =>
      !processedElements.has(f.element) &&
      !(f.radioGroup && f.radioGroup.every((r) => processedElements.has(r)))
  )
}

async function rescanRound(session: ActiveSession): Promise<void> {
  const all = [...scanDocument(document), ...scanReadonlyFields(document)]
  const fresh = newFieldsOnly(all)
  if (fresh.length === 0) return
  markProcessed(fresh)

  const signatures = fresh
    .filter((f) => !f.manual || (f.manual === "readonly" && f.widget))
    .map((f) => f.signature)
  const memoryBySig = await lookupMemory(signatures, session)

  // T074: 计划基于全量扫描归组（div/表格行号都是整页位置），但只执行
  // 「新出现元素」的条目——避免重复填写已处理字段，同时让 T073/T074
  // 展开的新行拿到正确的全局行号（按新鲜子集归组会从 0 重数）
  const plan = buildFillPlan(all, session.profile, session.entries, { memoryBySig })
  const freshSet = new Set<Element>(fresh.map((f) => f.element))
  const items = plan.items.filter((i) => freshSet.has(i.match.field.element))
  await executeFills(items, progressCtx(session, items.length))

  for (const item of items) {
    session.executed.push(item)
    const id = item.match.semanticFieldId
    // 仅标量字段计入 notFound 覆盖集（entry.* 不参与 FR-014）
    if (id && !id.startsWith("entry.")) session.coveredIds.add(id)
    session.itemsBySig.set(item.match.field.signature, item)
  }
}

async function lookupMemory(
  signatures: string[],
  session: ActiveSession
): Promise<Map<string, FieldMemory>> {
  const res = await sendToBackground("memory:lookup", { signatures })
  const map = new Map(session.memoryBySig)
  if (res.ok) {
    for (const row of res.data) {
      if (row.memory) map.set(row.signature, row.memory)
    }
  }
  session.memoryBySig = map
  return map
}

/** 观察 DOM：主窗口 3s；期间有变更则最多再补扫 5s；300ms 防抖（FR-016 / R5）
 *  T064：滚动也触发补扫——分步/懒加载表单（学历、求职意向区常滚动到才渲染） */
function observeRescan(session: ActiveSession, startedAt: number): () => Promise<void> {
  const mainDeadline = startedAt + MAIN_WINDOW_MS
  const hardDeadline = startedAt + MAIN_WINDOW_MS + RESCAN_BUDGET_MS
  let sawMutation = false
  let lastMutationAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = Promise.resolve()

  const bump = (): void => {
    sawMutation = true
    lastMutationAt = Date.now()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      running = running.then(() => rescanRound(session))
    }, RESCAN_DEBOUNCE_MS)
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.length === 0) return
    bump()
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["value", "checked", "disabled", "hidden", "style"]
  })

  // T064：capture 捕获子元素滚动（scroll 不冒泡）；防抖后与 mutation 同路复扫
  const onScroll = (): void => bump()
  document.addEventListener("scroll", onScroll, { passive: true, capture: true })

  return async () => {
    while (Date.now() < mainDeadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    // 主窗口内有变更 → 补扫预算：直到变更静默 ≥防抖时间，或硬截止
    while (sawMutation && Date.now() < hardDeadline && Date.now() - lastMutationAt < RESCAN_DEBOUNCE_MS * 4) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await running
    observer.disconnect()
    document.removeEventListener("scroll", onScroll, { capture: true })
  }
}

// ---------- 会话入口 ----------

async function runSession(sessionId: string, startedAt: number): Promise<void> {
  emit(sessionId, "scanning")

  const profileRes = await sendToBackground("profile:get", {})
  if (!profileRes.ok) throw new Error(profileRes.error.message)
  const { entries, ...profile } = profileRes.data

  const scanned = [...scanDocument(document), ...scanReadonlyFields(document)]
  markProcessed(scanned)

  const session: ActiveSession = {
    sessionId,
    reportId: newReportId(),
    startedAt,
    profile,
    entries,
    memoryBySig: new Map(),
    itemsBySig: new Map(),
    executed: [],
    resolved: new Set(),
    reportItems: [],
    report: null,
    coveredIds: new Set(),
    paused: false,
    progress: { done: 0, total: 0 }
  }
  setActiveSession(session)

  const signatures = scanned
    .filter((f) => !f.manual || (f.manual === "readonly" && f.widget))
    .map((f) => f.signature)
  const memoryBySig = await lookupMemory(signatures, session)

  emit(sessionId, "filling")
  const plan = buildFillPlan(scanned, profile, entries, { memoryBySig })
  renderProgressPanel({ done: 0, total: 0, matched: plan.items.length })
  await executeFills(plan.items, progressCtx(session, plan.items.length))

  for (const item of plan.items) {
    session.executed.push(item)
    if (
      item.match.semanticFieldId &&
      !item.match.semanticFieldId.startsWith("entry.")
    ) {
      session.coveredIds.add(item.match.semanticFieldId)
    }
    session.itemsBySig.set(item.match.field.signature, item)
  }

  // T053（SC-006）：首屏反馈即时呈现——scan/fill 全本地毫秒级完成即出结果清单，
  // 补扫窗口（≤8s）结束后用 finalize 结果覆盖刷新（createPanel 复用同一宿主）
  renderResultPanel(finalize(session))
  // T078(P4)：未填字段立即在页面标红（幂等，补扫后会再标一次新条目）
  markUnfilledItems(session.executed)

  // T071(观察者先启动)：展开期间的 DOM 变更走补扫；展开失败不阻塞会话
  const waitForObserver = observeRescan(session, startedAt)
  try {
    await expandEntryRows({
      doc: document,
      profile: session.profile,
      entries: session.entries,
      memoryBySig: session.memoryBySig,
      isPaused: () => session.paused
    })
  } catch {
    // 展开属增强能力：按钮找不到/点击无增长/异常都静默降级，不影响填写会话
  }
  await waitForObserver()

  const report = finalize(session)
  session.reportItems = report.items
  session.report = report

  await sendToBackground("report:save", report)
  emit(sessionId, "done", report)
  renderResultPanel(report)
  // T078(P4)：补扫产生的新未填条目一并标红（已标元素幂等跳过）
  markUnfilledItems(session.executed)
  // T034: 有低置信/冲突/歧义条目 → 弹确认面板（FR-013）
  showConfirmPanel(session)
}

// ---------- 消息监听 ----------

chrome.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
  const req = request as Request
  if (!req || typeof req.type !== "string") return false

  if (req.type === "autofill:run") {
    const payload = req.payload as { startedAt: number }
    // 立即应答 sessionId（契约：progress 由 autofill:event 携带），会话在后台继续
    const sessionId = newSessionId()
    sendResponse(ok({ sessionId }) as Response<{ sessionId: string }>)

    runSession(sessionId, payload?.startedAt ?? Date.now()).catch((err: unknown) => {
      // 会话失败也要有结果面板提示
      renderResultPanel({
        id: "error",
        hostname: location.hostname,
        url: location.href,
        createdAt: Date.now(),
        usedLlm: false,
        items: [
          {
            semanticFieldId: null,
            label: "填写失败",
            status: "not_found",
            reason: err instanceof Error ? err.message : String(err)
          }
        ]
      })
    })
    return false
  }

  // 未知消息类型一律忽略（站点页可能注入其他消息）
  return false
})
