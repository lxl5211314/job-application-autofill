// T014: popup 入口（vanilla TS，无 JSX/React：一键填写、打开资料管理、状态区）
// T025 接线：autofill:run 路由、NO_PROFILE/TAB_UNAVAILABLE 引导

import "./styles/popup.css"

import { ErrorCode, sendToBackground, type Response } from "./core/messaging"

function setStatus(text: string, isError = false): void {
  const status = document.getElementById("popup-status")
  if (!status) return
  status.textContent = text
  status.className = `status${isError ? " error" : ""}`
}

function openOptions(): void {
  void chrome.runtime.openOptionsPage()
}

async function runAutofill(): Promise<void> {
  const btn = document.getElementById("btn-run") as HTMLButtonElement | null
  if (btn) btn.disabled = true
  setStatus("正在填写…")
  try {
    const res: Response<{ sessionId: string }> = await sendToBackground("autofill:run", {
      startedAt: Date.now()
    })
    if (res.ok) {
      setStatus("已开始填写，请查看页面右下角结果面板")
      window.close()
      return
    }
    if (res.error.code === ErrorCode.NO_PROFILE) {
      setStatus("资料库为空：请先打开资料管理建档", true)
      openOptions()
    } else if (res.error.code === ErrorCode.TAB_UNAVAILABLE) {
      setStatus(res.error.message, true)
    } else {
      setStatus(`填写失败：${res.error.message}`, true)
    }
  } catch (err) {
    setStatus(`填写失败：${err instanceof Error ? err.message : String(err)}`, true)
  } finally {
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
  wrap.append(title, status, actions)
  body.append(wrap)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount)
} else {
  mount()
}
