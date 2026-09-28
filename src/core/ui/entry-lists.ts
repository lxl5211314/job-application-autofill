// T029: 经历条目列表（education/internship/project/award 四类：
// 新增/编辑/删除/排序、title 必填校验 — data-model §2, FR-002）

import type { EntryKind, ExperienceEntry, FieldState } from "../model/types"
import { validateEntry } from "../model/validation"
import { clear, el } from "./dom"

export const ENTRY_SECTION_LABELS: Record<EntryKind, string> = {
  education: "教育经历",
  internship: "实习经历",
  project: "项目经历",
  award: "获奖情况"
}

export interface EntryListContext {
  getEntries: () => ExperienceEntry[]
  setEntries: (entries: ExperienceEntry[]) => void
  /** 保存失败时的字段级错误（键形如 `education.title`） */
  errors: Record<string, string>
}

function newId(): string {
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface EditState {
  id: string
  isNew: boolean
  kind: EntryKind
}

let editState: EditState | null = null

/** 供 options 在分区切换/保存后清理编辑态 */
export function resetEntryEditState(): void {
  editState = null
}

function rerender(container: HTMLElement, kind: EntryKind, ctx: EntryListContext): void {
  clear(container)
  renderEntryList(container, kind, ctx)
}

/** 渲染某一类经历的列表 + 新增按钮；编辑态内嵌表单 */
export function renderEntryList(
  container: HTMLElement,
  kind: EntryKind,
  ctx: EntryListContext
): void {
  const card = el("div", { className: "section-card" })
  const all = ctx.getEntries()
  const list = all.filter((e) => e.kind === kind).sort((a, b) => a.order - b.order)

  const toolbar = el("div", { className: "toolbar" })
  toolbar.append(
    el(
      "button",
      {
        className: "primary",
        onClick: () => {
          const entry: ExperienceEntry = {
            id: newId(),
            kind,
            order: list.length,
            title: "",
            state: "confirmed",
            source: "manual",
            updatedAt: Date.now()
          }
          ctx.setEntries([...all, entry])
          editState = { id: entry.id, isNew: true, kind }
          rerender(container, kind, ctx)
        }
      },
      [`新增${ENTRY_SECTION_LABELS[kind]}`]
    )
  )
  card.append(toolbar)

  if (list.length === 0) {
    card.append(el("p", { className: "progress" }, ["暂无记录"]))
    container.append(card)
    return
  }

  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as ExperienceEntry
    const editing = editState !== null && editState.id === entry.id
    card.append(
      editing
        ? renderEditForm(entry, i, list.length, kind, ctx, container)
        : renderRow(entry, i, list.length, kind, ctx, container)
    )
  }

  container.append(card)
}

function moveEntry(
  entry: ExperienceEntry,
  delta: -1 | 1,
  ctx: EntryListContext,
  kind: EntryKind,
  container: HTMLElement
): void {
  const all = ctx.getEntries()
  const list = all.filter((e) => e.kind === kind).sort((a, b) => a.order - b.order)
  const idx = list.findIndex((e) => e.id === entry.id)
  const target = idx + delta
  if (idx < 0 || target < 0 || target >= list.length) return
  const a = list[idx] as ExperienceEntry
  const b = list[target] as ExperienceEntry
  const tmp = a.order
  a.order = b.order
  b.order = tmp
  ctx.setEntries(all)
  rerender(container, kind, ctx)
}

function renumber(entries: ExperienceEntry[], kind: EntryKind): void {
  let i = 0
  for (const e of entries.filter((x) => x.kind === kind).sort((x, y) => x.order - y.order)) {
    e.order = i++
  }
}

function renderRow(
  entry: ExperienceEntry,
  index: number,
  total: number,
  kind: EntryKind,
  ctx: EntryListContext,
  container: HTMLElement
): HTMLElement {
  const row = el("div", { className: "entry-row" })

  const main = el("div", { style: "flex:1;min-width:0" })
  const titleLine = el("div", {}, [entry.title || "（未命名）"])
  if (entry.state === "needs_review") {
    titleLine.append(el("span", { className: "badge needs_review" }, ["待核对"]))
  }
  const meta: string[] = []
  if (entry.subtitle) meta.push(entry.subtitle)
  if (entry.start || entry.end) meta.push(`${entry.start ?? ""} - ${entry.end ?? ""}`)
  main.append(titleLine)
  if (meta.length > 0) main.append(el("div", { className: "progress" }, [meta.join(" · ")]))

  const actions = el("div", { className: "toolbar", style: "margin:0" })
  actions.append(
    el(
      "button",
      {
        disabled: index === 0,
        onClick: () => moveEntry(entry, -1, ctx, kind, container)
      },
      ["上移"]
    ),
    el(
      "button",
      {
        disabled: index === total - 1,
        onClick: () => moveEntry(entry, 1, ctx, kind, container)
      },
      ["下移"]
    ),
    el(
      "button",
      {
        onClick: () => {
          editState = { id: entry.id, isNew: false, kind }
          rerender(container, kind, ctx)
        }
      },
      ["编辑"]
    ),
    el(
      "button",
      {
        className: "danger",
        onClick: () => {
          const next = ctx.getEntries().filter((e) => e.id !== entry.id)
          renumber(next, kind)
          ctx.setEntries(next)
          if (editState?.id === entry.id) editState = null
          rerender(container, kind, ctx)
        }
      },
      ["删除"]
    )
  )

  row.append(main, actions)
  return row
}

function renderEditForm(
  entry: ExperienceEntry,
  index: number,
  total: number,
  kind: EntryKind,
  ctx: EntryListContext,
  container: HTMLElement
): HTMLElement {
  const wrap = el("div", {
    className: "field",
    style: "border:1px solid var(--color-border);border-radius:6px;padding:10px;margin:8px 0"
  })

  // 保存失败的全局错误按本条目 kind 过滤
  const globalErrors: Record<string, string> = {}
  for (const [k, v] of Object.entries(ctx.errors)) {
    if (k.startsWith(`${kind}.`)) globalErrors[k] = v
  }

  const field = (
    key: "title" | "subtitle" | "start" | "end" | "description",
    label: string,
    isTextarea = false
  ): HTMLElement => {
    const f = el("div", { className: "field" })
    f.dataset.fieldId = `${kind}.${key}`
    f.append(el("label", {}, [label]))

    let input: HTMLInputElement | HTMLTextAreaElement
    if (isTextarea) {
      const ta = el("textarea") as HTMLTextAreaElement
      ta.value = entry[key] ?? ""
      input = ta
    } else {
      const inp = el("input", { type: "text" }) as HTMLInputElement
      inp.value = entry[key] ?? ""
      input = inp
    }

    const errDiv = el("div", { className: "error" })
    const showErr = (msg: string | undefined): void => {
      errDiv.textContent = msg ?? ""
      f.classList.toggle("invalid", Boolean(msg))
    }
    showErr(globalErrors[`${kind}.${key}`])

    input.addEventListener("input", () => {
      entry[key] = input.value
      entry.updatedAt = Date.now()
      ctx.setEntries(ctx.getEntries().map((e) => (e.id === entry.id ? entry : e)))
      showErr(validateEntry(entry)[`${kind}.${key}`])
    })

    f.append(input, errDiv)
    return f
  }

  wrap.append(
    el("div", { className: "panel-group-title" }, [
      `${ENTRY_SECTION_LABELS[kind]} · 编辑 ${index + 1}/${total}`
    ]),
    field("title", "标题/名称（必填）"),
    field("subtitle", "副标题（学校/公司/角色/颁发方）"),
    field("start", "开始时间（如 2022.09）"),
    field("end", "结束时间（如 2024.06 或 至今）"),
    field("description", "描述", true)
  )

  const stateRow = el("div", { className: "field" })
  stateRow.append(el("label", {}, ["状态"]))
  const select = el("select") as HTMLSelectElement
  for (const s of ["confirmed", "needs_review"] as FieldState[]) {
    const opt = el("option", { value: s }, [s === "confirmed" ? "已确认" : "待核对"])
    if (entry.state === s) opt.selected = true
    select.append(opt)
  }
  select.addEventListener("change", () => {
    entry.state = select.value as FieldState
    ctx.setEntries(ctx.getEntries().map((e) => (e.id === entry.id ? entry : e)))
  })
  stateRow.append(select)
  wrap.append(stateRow)

  const actions = el("div", { className: "confirm-actions" })
  const doneBtn = el("button", { className: "primary" }, ["完成编辑"])
  doneBtn.addEventListener("click", () => {
    const local = validateEntry(entry)
    if (Object.keys(local).length > 0) {
      rerender(container, kind, ctx)
      return
    }
    editState = null
    rerender(container, kind, ctx)
  })
  const cancelBtn = el("button", {}, ["取消"])
  cancelBtn.addEventListener("click", () => {
    if (editState?.isNew) {
      const next = ctx.getEntries().filter((e) => e.id !== entry.id)
      renumber(next, kind)
      ctx.setEntries(next)
    }
    editState = null
    rerender(container, kind, ctx)
  })
  actions.append(doneBtn, cancelBtn)
  wrap.append(actions)

  return wrap
}
