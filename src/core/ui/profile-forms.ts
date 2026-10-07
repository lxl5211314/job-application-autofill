// T028: 基本信息 & 求职意向表单（9+3 标量字段，FR-003 实时校验、needs_review 徽标）

import { semanticFieldLabel } from "../matching/vocabulary"
import { getScalarField, type Profile, type ScalarFieldId } from "../model/types"
import { BASIC_FIELD_IDS, INTENT_FIELD_IDS } from "../model/types"
import { validateScalarValue } from "../model/validation"
import { el } from "./dom"

export type ScalarSectionId = "basics" | "intent"

const INPUT_TYPE: Partial<Record<ScalarFieldId, string>> = {
  "basic.phone": "tel",
  "basic.email": "email"
}

const PLACEHOLDER: Partial<Record<ScalarFieldId, string>> = {
  "basic.gender": "男 或 女",
  "basic.birthday": "1999-09-01",
  "basic.phone": "13800138000",
  "basic.email": "you@example.com",
  "intent.salary": "15-20K 或 15000-20000"
}

export interface ScalarFormContext {
  getProfile: () => Profile
  setField: (id: ScalarFieldId, value: string) => void
  /** 保存失败时的字段级错误（VALIDATION_ERROR.details） */
  errors: Record<string, string>
}

export function fieldLabel(id: ScalarFieldId): string {
  return semanticFieldLabel(id)
}

/** 渲染一个标量分区表单（不触发保存；输入即时写入草稿并实时校验） */
export function renderScalarForm(
  container: HTMLElement,
  section: ScalarSectionId,
  ctx: ScalarFormContext
): void {
  const ids = section === "basics" ? BASIC_FIELD_IDS : INTENT_FIELD_IDS
  const card = el("div", { className: "section-card" })

  for (const id of ids) {
    const field = getScalarField(ctx.getProfile(), id)
    const wrap = el("div", { className: "field" })
    wrap.dataset.fieldId = id

    const label = el("label", { htmlFor: `f-${id}` }, [fieldLabel(id)])
    if (field?.state === "needs_review") {
      const badge = el("span", { className: "badge needs_review" }, ["待核对"])
      badge.style.marginLeft = "6px"
      label.append(badge)
    }

    const input = el("input", {
      id: `f-${id}`,
      type: INPUT_TYPE[id] ?? "text"
    }) as HTMLInputElement
    input.value = field?.value ?? ""
    if (PLACEHOLDER[id]) input.placeholder = PLACEHOLDER[id] as string

    const errorDiv = el("div", { className: "error" })
    let touched = false

    const refresh = (): void => {
      const saved = ctx.errors[id]
      const live = touched ? validateScalarValue(id, input.value) : null
      const message = saved ?? live
      errorDiv.textContent = message ?? ""
      wrap.classList.toggle("invalid", Boolean(message))
    }

    input.addEventListener("input", () => {
      touched = true
      ctx.setField(id, input.value)
      refresh()
    })

    wrap.append(label, input, errorDiv)
    card.append(wrap)
    refresh()
  }

  container.append(card)
}
