// T046: 简历导入草稿核对页（data-model §5、FR-006/007/008/010）
// 逐字段检查/修改/补空缺、低置信醒目标记（待核对）、确认与丢弃按钮

import { semanticFieldLabel } from "../matching/vocabulary"
import {
  ALL_SCALAR_FIELD_IDS,
  ENTRY_KINDS,
  type EntryKind,
  type ExperienceEntry,
  type ResumeDraft,
  type ScalarFieldId
} from "../model/types"
import { clear, el } from "./dom"

const KIND_LABEL: Record<EntryKind, string> = {
  education: "教育经历",
  internship: "实习经历",
  project: "项目经历",
  award: "获奖情况"
}

export interface DraftReviewContext {
  getDraft: () => ResumeDraft
  /** 更新草稿（字段修改/条目修改/importMode 选择） */
  setDraft: (mutate: (draft: ResumeDraft) => void) => void
  /** 资料库已有数据 → 强制选择覆盖或合并（FR-010） */
  hasExistingProfile: boolean
  onConfirm: () => Promise<void>
  onDiscard: () => Promise<void>
}

export interface DraftReviewHandle {
  /** background 返回的校验错误（字段 id → 消息） */
  showErrors: (errors: Record<string, string>, message: string) => void
  showStatus: (text: string, isError?: boolean) => void
}

function scalarRow(id: ScalarFieldId, draft: ResumeDraft, ctx: DraftReviewContext): HTMLElement {
  const wrap = el("div", { className: "field" })
  wrap.dataset.fieldId = id

  const f = draft.fields[id]
  const missing = !f || !f.extracted
  const low = !missing && f?.confidence === "low" && !f?.edited

  const label = el("label", { htmlFor: `draft-${id}` }, [semanticFieldLabel(id)])
  if (low) {
    const badge = el("span", { className: "badge needs_review" }, ["待核对"])
    badge.style.marginLeft = "6px"
    label.append(badge)
  }
  if (missing) {
    const badge = el("span", { className: "badge" }, ["未读取到"])
    badge.style.marginLeft = "6px"
    label.append(badge)
  }

  const input = el("input", { id: `draft-${id}`, type: "text" }) as HTMLInputElement
  input.value = f?.value ?? ""
  if (missing) input.placeholder = "未读取到，请补填（FR-006）"

  const errorDiv = el("div", { className: "error" })

  input.addEventListener("input", () => {
    ctx.setDraft((d) => {
      d.fields[id] = { value: input.value, confidence: "high", extracted: true, edited: true }
    })
    wrap.classList.remove("invalid")
    errorDiv.textContent = ""
  })

  wrap.append(label, input, errorDiv)
  return wrap
}

function entryBlock(
  entry: ExperienceEntry,
  index: number,
  ctx: DraftReviewContext
): HTMLElement {
  const card = el("div", { className: "section-card draft-entry" })
  card.append(el("h3", {}, [`${KIND_LABEL[entry.kind]} #${index + 1}`]))

  const fields: Array<{ key: keyof ExperienceEntry; label: string; ph?: string }> = [
    { key: "title", label: "名称（学校/公司/项目/奖项）" },
    { key: "subtitle", label: "方向/专业/职位" },
    { key: "start", label: "开始（2020.09）", ph: "20xx.xx" },
    { key: "end", label: "结束（2024.06）", ph: "20xx.xx" },
    { key: "description", label: "描述" }
  ]
  for (const def of fields) {
    const wrap = el("div", { className: "field" })
    wrap.append(el("label", {}, [def.label]))
    const input = el("input", { type: "text" }) as HTMLInputElement
    input.value = String(entry[def.key] ?? "")
    if (def.ph) input.placeholder = def.ph
    input.addEventListener("input", () => {
      ctx.setDraft((d) => {
        const target = d.entries.find((e) => e.id === entry.id)
        if (!target) return
        ;(target[def.key] as string | undefined) = input.value === "" ? undefined : input.value
        // 用户编辑过 → confirmed（FR-007）
        target.state = "confirmed"
        target.updatedAt = Date.now()
      })
    })
    wrap.append(input)
    card.append(wrap)
  }

  if (entry.state === "needs_review") {
    const badge = el("span", { className: "badge needs_review" }, ["待核对（缺结束时间或未编辑的低置信）"])
    card.append(badge)
  }
  return card
}

/** 渲染草稿核对页；返回 handle 供 options 显示错误/状态 */
export function renderDraftReview(
  container: HTMLElement,
  ctx: DraftReviewContext
): DraftReviewHandle {
  clear(container)
  const draft = ctx.getDraft()

  const status = el("div", { className: "save-status" })
  const errorBox = el("div", { className: "field invalid", role: "alert" })
  errorBox.style.display = "none"

  const showErrors = (errs: Record<string, string>, message: string): void => {
    clear(errorBox)
    errorBox.style.display = ""
    errorBox.append(el("div", { className: "error" }, [message]))
    for (const [k, v] of Object.entries(errs)) {
      errorBox.append(el("div", { className: "error" }, [`${k}：${v}`]))
    }
    status.textContent = ""
    status.className = "save-status error"
  }
  const showStatus = (text: string, isError = false): void => {
    status.textContent = text
    status.className = `save-status${isError ? " error" : ""}`
    if (isError) return
    errorBox.style.display = "none"
    clear(errorBox)
  }

  container.append(
    el("p", { className: "progress" }, [
      `文件：${draft.fileName} · 抽取字段 ${Object.keys(draft.fields).length} 项 · 经历 ${draft.entries.length} 条。请逐项核对后确认导入。`
    ]),
    errorBox,
    status
  )

  const card = el("div", { className: "section-card" })
  card.append(el("h3", {}, ["资料字段"]))
  for (const id of ALL_SCALAR_FIELD_IDS) {
    card.append(scalarRow(id, draft, ctx))
  }
  container.append(card)

  const sorted = [...draft.entries].sort(
    (a, b) => ENTRY_KINDS.indexOf(a.kind) - ENTRY_KINDS.indexOf(b.kind) || a.order - b.order
  )
  for (const [i, entry] of sorted.entries()) {
    container.append(entryBlock(entry, i, ctx))
  }

  // FR-010：重复导入必须显式选择覆盖或合并
  let modeWrap: HTMLElement | null = null
  let modeError: HTMLElement | null = null
  if (ctx.hasExistingProfile) {
    const modeCard = el("div", { className: "section-card" })
    modeCard.append(
      el("h3", {}, ["导入方式（资料库已有数据，必须选择）"]),
      el("p", { className: "progress" }, [
        "覆盖 = 整体替换；合并 = 保留已确认的手动修改，仅补空缺（FR-010）"
      ])
    )
    modeWrap = el("div", { className: "field" })
    modeWrap.dataset.fieldId = "importMode"
    modeError = el("div", { className: "error" })
    const mw = modeWrap
    const me = modeError
    for (const value of ["merge", "overwrite"] as const) {
      const rid = `import-mode-${value}`
      const radio = el("input", {
        type: "radio",
        id: rid,
        name: "import-mode",
        value
      }) as HTMLInputElement
      radio.addEventListener("change", () => {
        ctx.setDraft((d) => {
          d.importMode = value
        })
        me.textContent = ""
        mw.classList.remove("invalid")
      })
      const lab = el("label", { htmlFor: rid }, [
        value === "merge" ? "合并（保留手动确认的值）" : "覆盖（整体替换）"
      ])
      lab.style.display = "block"
      mw.append(radio, lab)
    }
    modeCard.append(modeWrap, modeError)
    container.append(modeCard)
  }

  const actions = el("div", { className: "toolbar" })
  const confirmBtn = el("button", { className: "primary" }, ["确认导入"]) as HTMLButtonElement
  const discardBtn = el("button", {}, ["丢弃草稿"]) as HTMLButtonElement

  confirmBtn.addEventListener("click", () => {
    if (ctx.hasExistingProfile && !ctx.getDraft().importMode) {
      modeWrap?.classList.add("invalid")
      if (modeError) modeError.textContent = "请选择“合并”或“覆盖”（FR-010）"
      return
    }
    confirmBtn.disabled = true
    discardBtn.disabled = true
    void ctx.onConfirm().finally(() => {
      confirmBtn.disabled = false
      discardBtn.disabled = false
    })
  })
  discardBtn.addEventListener("click", () => {
    confirmBtn.disabled = true
    discardBtn.disabled = true
    void ctx.onDiscard().finally(() => {
      confirmBtn.disabled = false
      discardBtn.disabled = false
    })
  })

  actions.append(confirmBtn, discardBtn)
  container.append(actions)

  return { showErrors, showStatus }
}
