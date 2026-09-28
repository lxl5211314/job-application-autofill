// T015: options 资料管理页入口（vanilla TS，无 JSX）
// 六分区导航（基本信息/求职意向/教育/实习/项目/获奖）+ 设置
// T030 保存流程：profile:save → VALIDATION_ERROR 逐字段高亮 + 完整度指示
// T031 持久化往返：挂载时 profile:get 载入 → 保存 → 重开页面数据完整（FR-004）
// T046/T047/T048（US5）：简历导入分区（文件类型校验/解析进度/草稿核对/覆盖或合并）

import "./styles/options.css"

import { sendToBackground, ErrorCode, type Response } from "./core/messaging"
import {
  ALL_SCALAR_FIELD_IDS,
  getScalarField,
  setScalarField,
  isProfileEmpty,
  type EntryKind,
  type ExperienceEntry,
  type Profile,
  type ResumeDraft,
  type ScalarFieldId,
  emptyProfile
} from "./core/model/types"
import { clear, el } from "./core/ui/dom"
import {
  renderEntryList,
  resetEntryEditState,
  type EntryListContext
} from "./core/ui/entry-lists"
import { renderScalarForm, type ScalarFormContext, type ScalarSectionId } from "./core/ui/profile-forms"
import { renderDraftReview, type DraftReviewHandle } from "./core/ui/draft-review"
import { parseTextResume } from "./core/resume/text"
import { parsePdfResume } from "./core/resume/pdf"
import { setResumeDraft } from "./core/storage/store"
import { NoTextError, type ExtractResult } from "./core/resume/extract"

export type SectionId =
  | "basics"
  | "intent"
  | "education"
  | "internship"
  | "project"
  | "award"
  | "import"
  | "settings"

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "basics", label: "基本信息" },
  { id: "intent", label: "求职意向" },
  { id: "education", label: "教育经历" },
  { id: "internship", label: "实习经历" },
  { id: "project", label: "项目经历" },
  { id: "award", label: "获奖情况" },
  { id: "import", label: "从简历导入" },
  { id: "settings", label: "设置" }
]

let currentSection: SectionId = "basics"

// ---------- 草稿状态（T030/T031） ----------

let draftProfile: Profile = emptyProfile()
let draftEntries: ExperienceEntry[] = []
let saveErrors: Record<string, string> = {}
let loadPromise: Promise<void> | null = null

// ---------- 简历导入状态（T046/T047/T048） ----------

let activeDraft: ResumeDraft | null = null
let draftHandle: DraftReviewHandle | null = null
let flash: { text: string; isError: boolean } | null = null

const ALLOWED_EXT = [".pdf", ".txt", ".md"]

function importStatus(text: string, isError = false): void {
  const node = document.getElementById("import-status")
  if (!node) return
  node.textContent = text
  node.className = `save-status${isError ? " error" : ""}`
}

async function parseResumeFile(file: File): Promise<ExtractResult> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith(".pdf")) return parsePdfResume(await file.arrayBuffer())
  return parseTextResume(await file.text())
}

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = sendToBackground("profile:get", {}).then((res) => {
      if (res.ok) {
        const { entries, ...profile } = res.data
        draftProfile = { ...emptyProfile(), ...profile }
        draftEntries = entries ?? []
      }
    })
  }
  return loadPromise
}

function setField(id: ScalarFieldId, value: string): void {
  const existing = getScalarField(draftProfile, id)
  setScalarField(draftProfile, id, {
    value,
    state: existing?.state ?? "confirmed",
    source: existing?.source ?? "manual",
    updatedAt: Date.now()
  })
  // 输入即消除该字段的保存错误
  delete saveErrors[id]
}

function completeness(): string {
  const filled = ALL_SCALAR_FIELD_IDS.filter((id) => {
    const f = getScalarField(draftProfile, id)
    return f && f.value.trim() !== ""
  }).length
  return `资料完整度 ${filled}/${ALL_SCALAR_FIELD_IDS.length} 项`
}

// ---------- 保存流程（T030） ----------

function setStatus(text: string, isError = false): void {
  const node = document.getElementById("options-status")
  if (!node) return
  node.textContent = text
  node.className = `save-status${isError ? " error" : ""}`
}

async function saveAll(): Promise<boolean> {
  setStatus("保存中…")
  const res: Response<Record<string, never>> = await sendToBackground("profile:save", {
    profile: draftProfile,
    entries: draftEntries
  })
  if (res.ok) {
    saveErrors = {}
    resetEntryEditState()
    setStatus("已保存 ✓")
    updateCompleteness()
    return true
  }
  if (res.error.code === ErrorCode.VALIDATION_ERROR) {
    saveErrors = res.error.details ?? {}
    setStatus(`保存失败：${res.error.message}`, true)
    void renderSection()
    return false
  }
  setStatus(`保存失败：${res.error.message}`, true)
  return false
}

function updateCompleteness(): void {
  for (const node of document.querySelectorAll(".completeness")) {
    node.textContent = completeness()
  }
}

// ---------- 分区渲染 ----------

type SectionRenderer = (container: HTMLElement) => void | Promise<void>
const renderers = new Map<SectionId, SectionRenderer>()

export function registerSection(id: SectionId, renderer: SectionRenderer): void {
  renderers.set(id, renderer)
  if (currentSection === id) void renderSection()
}

/** T048：文件类型校验 + 解析进度 + FR-009 错误文案 */
async function handleResumeFile(file: File): Promise<void> {
  const lower = file.name.toLowerCase()
  if (!ALLOWED_EXT.some((ext) => lower.endsWith(ext))) {
    importStatus(
      `不支持该文件类型：仅 PDF / .txt / .md（Word、图片扫描件不在范围内，FR-009）`,
      true
    )
    return
  }
  importStatus("解析中…（仅本地解析，不上传）")
  try {
    const result = await parseResumeFile(file)
    activeDraft = {
      id: `draft-${Date.now()}`,
      fileName: file.name,
      createdAt: Date.now(),
      status: "pending",
      fields: result.fields,
      entries: result.entries
    }
    await setResumeDraft(activeDraft)
    draftHandle = null
    await renderSection()
  } catch (err) {
    if (err instanceof NoTextError) {
      importStatus(err.message, true) // FR-009：提示手动填写，不建草稿
    } else {
      importStatus(`解析失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  }
}

function renderImportSection(main: HTMLElement): void {
  const card = el("div", { className: "section-card" })
  card.append(
    el("h3", {}, ["导入简历"]),
    el("p", { className: "progress" }, [
      "支持带文本层的 PDF、.txt、.md。文件仅在本机解析（pdf.js 本地 worker，FR-024），不会上传。"
    ])
  )

  const fileInput = el("input", {
    type: "file",
    id: "resume-file",
    accept: ".pdf,.txt,.md,application/pdf,text/plain"
  }) as HTMLInputElement
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0]
    if (file) void handleResumeFile(file)
  })
  card.append(el("label", { htmlFor: "resume-file" }, ["选择简历文件"]), fileInput)
  main.append(card)
}

async function confirmDraft(): Promise<void> {
  const draft = activeDraft
  if (!draft) return
  draftHandle?.showStatus("写入资料库中…")
  const res = await sendToBackground("resume:confirm", {
    draftId: draft.id,
    importMode: draft.importMode,
    fields: draft.fields,
    entries: draft.entries
  })
  if (res.ok) {
    activeDraft = null
    draftHandle = null
    flash = { text: `已导入「${draft.fileName}」到资料库 ✓`, isError: false }
    loadPromise = null // 重新拉取已写入的 profile
    await ensureLoaded()
    currentSection = "basics"
    updateNav()
    await renderSection()
    updateCompleteness()
    return
  }
  draftHandle?.showErrors(res.error.details ?? {}, `导入失败：${res.error.message}`)
}

async function discardDraft(): Promise<void> {
  const draft = activeDraft
  if (!draft) return
  await sendToBackground("resume:discard", { draftId: draft.id })
  activeDraft = null
  draftHandle = null
  flash = { text: "草稿已丢弃，资料库未改动", isError: false }
  await renderSection()
}

function updateNav(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".options-nav button")) {
    btn.classList.toggle("active", btn.dataset.section === currentSection)
  }
}

function scalarContext(): ScalarFormContext {
  return {
    getProfile: () => draftProfile,
    setField,
    errors: saveErrors
  }
}

function entryContext(): EntryListContext {
  return {
    getEntries: () => draftEntries,
    setEntries: (next) => {
      draftEntries = next
    },
    errors: saveErrors
  }
}

function renderSaveBar(main: HTMLElement): void {
  const bar = el("div", { className: "toolbar" })
  const saveBtn = el("button", { className: "primary" }, ["保存全部修改"])
  saveBtn.addEventListener("click", () => void saveAll())
  const status = el("span", { className: "save-status", id: "options-status" })
  const completenessNode = el("span", { className: "progress completeness" }, [completeness()])
  bar.append(saveBtn, status, completenessNode)
  main.append(bar)

  // 保存失败的字段级错误汇总（跨分区也能看到，FR-003）
  const errorKeys = Object.keys(saveErrors)
  if (errorKeys.length > 0) {
    const box = el("div", { className: "field invalid", role: "alert" })
    for (const key of errorKeys) {
      box.append(el("div", { className: "error" }, [`${key}：${saveErrors[key]}`]))
    }
    main.append(box)
  }
}

async function renderSection(): Promise<void> {
  const main = document.getElementById("options-main")
  if (!main) return
  await ensureLoaded()
  clear(main)

  // 草稿核对页优先（T046）：覆盖当前分区显示（renderDraftReview 会先清空容器，标题在其后追加）
  if (activeDraft) {
    draftHandle = renderDraftReview(main, {
      getDraft: () => activeDraft as ResumeDraft,
      setDraft: (mutate) => {
        if (activeDraft) mutate(activeDraft)
      },
      hasExistingProfile: !isProfileEmpty(draftProfile),
      onConfirm: confirmDraft,
      onDiscard: discardDraft
    })
    main.prepend(el("h2", {}, ["简历导入核对"]))
    return
  }

  const heading = el("h2", {}, [SECTIONS.find((s) => s.id === currentSection)?.label ?? ""])
  main.append(heading)

  if (currentSection === "import") {
    renderImportSection(main)
    const status = el("div", { className: "save-status", id: "import-status" })
    main.append(status)
    if (flash) {
      importStatus(flash.text, flash.isError)
      flash = null
    }
    return
  }

  if (currentSection === "basics" || currentSection === "intent") {
    renderSaveBar(main)
    renderScalarForm(main, currentSection as ScalarSectionId, scalarContext())
    if (flash) {
      setStatus(flash.text, flash.isError)
      flash = null
    }
    return
  }
  if (currentSection !== "settings") {
    renderSaveBar(main)
    const container = el("div", { id: `options-entries-${currentSection}` })
    main.append(container)
    renderEntryList(
      container,
      currentSection as EntryKind,
      entryContext()
    )
    if (flash) {
      setStatus(flash.text, flash.isError)
      flash = null
    }
    return
  }

  const renderer = renderers.get(currentSection)
  if (renderer) {
    await renderer(main)
  } else {
    main.append(el("p", { className: "progress" }, ["设置分区开发中…"]))
  }
}

function selectSection(id: SectionId): void {
  if (id !== currentSection) resetEntryEditState()
  currentSection = id
  updateNav()
  void renderSection()
}

function mount(): void {
  const body = document.body
  body.innerHTML = ""

  const layout = el("div", { className: "options-layout" })
  const nav = el("nav", { className: "options-nav" }, [el("h1", {}, ["校招海投助手"])])
  const completenessNode = el("div", { className: "progress completeness" }, ["资料完整度 —"])
  completenessNode.style.padding = "0 16px 8px"
  nav.append(completenessNode)
  for (const section of SECTIONS) {
    const btn = el(
      "button",
      {
        className: section.id === currentSection ? "active" : "",
        onClick: () => selectSection(section.id)
      },
      [section.label]
    )
    ;(btn as HTMLButtonElement).dataset.section = section.id
    nav.append(btn)
  }

  const main = el("main", { className: "options-main", id: "options-main" })
  layout.append(nav, main)
  body.append(layout)
  void renderSection().then(updateCompleteness)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount)
} else {
  mount()
}
