// T014: popup 入口（vanilla TS，无 JSX/React：一键填写、打开资料管理、状态区）
// T025 接线：autofill:run 路由、NO_PROFILE/TAB_UNAVAILABLE 引导
// T071: 步骤清单——connect("autofill-progress") 端口实时收进度，不自动关窗

import "./styles/popup.css"

import { ErrorCode, sendToBackground, type Response } from "./core/messaging"
import type { FillReport } from "./core/model/types"

interface ProgressPayload {
  sessionId: string
  phase: "scanning" | "filling" | "done"
  report?: FillReport
  progress?: { done: number; total: number; current?: string; matched?: number; paused?: boolean }
}

const STEP_LABELS = ["扫描页面", "匹配资料", "逐项填写", "完成"]
const MARK = { idle: "○", active: "›", done: "✓" } as const

let port: chrome.runtime.Port | null = null
let sessionId: string | null = null
let buffered: ProgressPayload[] = []
let finished = false

function setStatus(text: string, isError = false): void {
  const status = document.getElementById("popup-status")
  if (!status) return
  status.textContent = text
  status.className = `status${isError ? " error" : ""}`
}

function setSteps(states: Array<{ state: keyof typeof MARK; detail?: string }>): void {
  for (let i = 0; i < STEP_LABELS.length; i++) {
    const li = document.getElementById(`step-${i}`)
    const s = states[i] ?? { state: "idle" as const }
    if (!li) continue
    li.dataset.state = s.state
    li.textContent = `${MARK[s.state]} ${STEP_LABELS[i]}${s.detail ? ` · ${s.detail}` : ""}`
  }
}

function summarize(report: FillReport): string {
  const c = { filled: 0, needs_confirm: 0, not_found: 0, missing_in_profile: 0, manual_required: 0 }
  for (const it of report.items) c[it.status]++
  return (
    `已填 ${c.filled} · 需确认 ${c.needs_confirm} · ` +
    `未找到 ${c.not_found + c.missing_in_profile} · 需人工 ${c.manual_required}`
  )
}

function handleEvent(e: ProgressPayload): void {
  if (finished) return
  if (e.phase === "scanning") {
    setSteps([{ state: "active" }])
    setStatus("正在扫描页面…")
    return
  }
  if (e.phase === "filling") {
    const p = e.progress
    let detail: string | undefined
    if (p) {
      const head = p.paused ? "已暂停" : "已填"
      const cur = p.current && !p.paused ? `（${p.current}）` : ""
      detail = `${head} ${p.done}/${p.total}${cur}`
    }
    setSteps([
      { state: "done" },
      { state: "done", detail: p && p.matched !== undefined ? `匹配 ${p.matched} 项` : undefined },
      { state: "active", detail },
      { state: "idle" }
    ])
    setStatus(p?.paused ? "已暂停：剩余字段归入需人工" : "填写进行中，可关闭本窗口")
    return
  }
  // done
  finished = true
  setSteps([{ state: "done" }, { state: "done" }, { state: "done" }, { state: "done" }])
  setStatus(e.report ? `完成：${summarize(e.report)}（详情见页面面板）` : "完成")
}

function openOptions(): void {
  void chrome.runtime.openOptionsPage()
}

async function runAutofill(): Promise<void> {
  const btn = document.getElementById("btn-run") as HTMLButtonElement | null
  if (btn) btn.disabled = true
  setStatus("正在启动…")
  setSteps([{ state: "active" }])

  // T071: 先连端口再触发，避免丢首个 scanning 事件
  port?.disconnect()
  port = chrome.runtime.connect({ name: "autofill-progress" })
  sessionId = null
  buffered = []
  finished = false
  port.onMessage.addListener((raw) => {
    const e = raw as ProgressPayload
    if (!e || typeof e.sessionId !== "string") return
    if (!sessionId) {
      buffered.push(e)
      return
    }
    if (e.sessionId === sessionId) handleEvent(e)
  })

  const hint = window.setTimeout(() => {
    if (!finished) setStatus("仍在进行…可查看页面右下角面板")
  }, 25000)

  try {
    const res: Response<{ sessionId: string }> = await sendToBackground("autofill:run", {
      startedAt: Date.now()
    })
    if (res.ok) {
      sessionId = res.data.sessionId
      for (const e of buffered) if (e.sessionId === sessionId) handleEvent(e)
      buffered = []
      setStatus("填写进行中，可关闭本窗口")
      return
    }
    port.disconnect()
    port = null
    setSteps([])
    if (res.error.code === ErrorCode.NO_PROFILE) {
      setStatus("资料库为空：请先打开资料管理建档", true)
      openOptions()
    } else if (res.error.code === ErrorCode.TAB_UNAVAILABLE) {
      setStatus(res.error.message, true)
    } else {
      setStatus(`填写失败：${res.error.message}`, true)
    }
  } catch (err) {
    port?.disconnect()
    port = null
    setSteps([])
    setStatus(`填写失败：${err instanceof Error ? err.message : String(err)}`, true)
  } finally {
    window.clearTimeout(hint)
    if (btn) btn.disabled = false
  }
}

function mount(): void {
  const body = document.body
  body.innerHTML = ""

  const wrap = document.createElement("div")
  wrap.className = "popup"

  const title = document.createElement("h1")
  title.textContent = "校招海投助手"

  const status = document.createElement("div")
  status.id = "popup-status"
  status.className = "status"

  const steps = document.createElement("ol")
  steps.className = "steps"
  steps.id = "popup-steps"
  for (let i = 0; i < STEP_LABELS.length; i++) {
    const li = document.createElement("li")
    li.id = `step-${i}`
    li.dataset.state = "idle"
    li.textContent = `${MARK.idle} ${STEP_LABELS[i]}`
    steps.appendChild(li)
  }

  const actions = document.createElement("div")
  actions.className = "actions"

  const runBtn = document.createElement("button")
  runBtn.id = "btn-run"
  runBtn.className = "primary"
  runBtn.textContent = "一键填写"
  runBtn.addEventListener("click", () => void runAutofill())

  const optionsBtn = document.createElement("button")
  optionsBtn.id = "btn-options"
  optionsBtn.textContent = "打开资料管理"
  optionsBtn.addEventListener("click", openOptions)

  actions.append(runBtn, optionsBtn)
  wrap.append(title, status, steps, actions)
  body.append(wrap)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount)
} else {
  mount()
}
