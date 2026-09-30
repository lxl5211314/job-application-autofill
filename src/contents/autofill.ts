// T013/T023: 内容脚本 — 填写会话编排（FR-011/016/017/018/019）
// scan → memory:lookup → match → fill → MutationObserver 补扫（300ms 防抖，
// 主窗口 3s + 补扫 ≤5s，research R5/R8）→ FillReport（掩码）→ report:save → 结果面板

import { fillField } from "../core/filling/fill"
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
import { sendToBackground, ok, type Request, type Response } from "../core/messaging"
import { showConfirmPanel } from "../core/ui/confirm-panel"
import { renderResultPanel } from "../core/ui/result-panel"

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
  report?: FillReport
): void {
  void sendToBackground("autofill:event", { sessionId, phase, report }).catch(() => {
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
    case "manual":
      return {
        semanticFieldId: id,
        label,
        status: "manual_required",
        reason: item.reason
      }
  }
}

/** 执行计划中的 fill 项；fillField 意外失败（如扫描后页面被改）转 needs_confirm */
function executeFills(items: FillPlanItem[]): void {
  for (const item of items) {
    if (item.action !== "fill" || item.value === undefined) continue
    const result = fillField(item.match.field, item.value)
    if (result.filled) continue
    item.action =
      result.reason === "blacklist"
        ? "manual"
        : result.reason === "conflict" || result.reason === "no_match"
          ? "confirm"
          : "missing"
    item.reason =
      result.reason === "conflict"
        ? "页面已有内容与资料库不一致，不覆盖（FR-017）"
        : result.reason === "no_match"
          ? "选项措辞与资料库不一致，不自动填"
          : result.reason === "blacklist"
            ? "非填写区控件，需人工处理"
            : `无法填写（${result.reason ?? "unknown"}）`
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
    items.push({ semanticFieldId: id, label: id, status: "not_found" })
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
  const fresh = newFieldsOnly([...scanDocument(document), ...scanReadonlyFields(document)])
  if (fresh.length === 0) return
  markProcessed(fresh)

  const signatures = fresh.filter((f) => !f.manual).map((f) => f.signature)
  const memoryBySig = await lookupMemory(signatures, session)

  const plan = buildFillPlan(fresh, session.profile, session.entries, { memoryBySig })
  executeFills(plan.items)

  for (const item of plan.items) {
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

/** 观察 DOM：主窗口 3s；期间有变更则最多再补扫 5s；300ms 防抖（FR-016 / R5） */
function observeRescan(session: ActiveSession, startedAt: number): () => Promise<void> {
  const mainDeadline = startedAt + MAIN_WINDOW_MS
  const hardDeadline = startedAt + MAIN_WINDOW_MS + RESCAN_BUDGET_MS
  let sawMutation = false
  let lastMutationAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = Promise.resolve()

  const observer = new MutationObserver((mutations) => {
    if (mutations.length === 0) return
    sawMutation = true
    lastMutationAt = Date.now()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      running = running.then(() => rescanRound(session))
    }, RESCAN_DEBOUNCE_MS)
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["value", "checked", "disabled", "hidden", "style"]
  })

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
    coveredIds: new Set()
  }
  setActiveSession(session)

  const signatures = scanned.filter((f) => !f.manual).map((f) => f.signature)
  const memoryBySig = await lookupMemory(signatures, session)

  emit(sessionId, "filling")
  const plan = buildFillPlan(scanned, profile, entries, { memoryBySig })
  executeFills(plan.items)

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

  const waitForObserver = observeRescan(session, startedAt)
  await waitForObserver()

  const report = finalize(session)
  session.reportItems = report.items
  session.report = report

  await sendToBackground("report:save", report)
  emit(sessionId, "done", report)
  renderResultPanel(report)
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
