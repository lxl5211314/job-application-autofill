// T012: MV3 service worker 消息路由
// 注册 profile:*/settings:*/memory:*/report:*/confirm:resolve/autofill:run（+ autofill:event 应答）
// llm:* 不注册（spec FR-028，v1.1 预留）；resume:*（T047/US5）已注册

import {
  ErrorCode,
  fail,
  forwardToTab,
  ok,
  type Request,
  type Response
} from "./core/messaging"
import { maskValue } from "./core/model/mask"
import { validateEntry, validateProfile } from "./core/model/validation"
import {
  ALL_SCALAR_FIELD_IDS,
  defaultSettings,
  emptyProfile,
  getScalarField,
  isProfileEmpty,
  setScalarField,
  type ExperienceEntry,
  type FieldState,
  type Profile,
  type ResumeDraft
} from "./core/model/types"
import * as store from "./core/storage/store"

const KNOWN_TYPES = new Set([
  "profile:get",
  "profile:save",
  "settings:get",
  "settings:save",
  "memory:lookup",
  "memory:write",
  "report:save",
  "report:list",
  "resume:confirm",
  "resume:discard",
  "autofill:run",
  "autofill:event",
  "confirm:resolve"
])

function isHttpUrl(url: string | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url)
}

async function handleMessage(request: Request): Promise<Response | undefined> {
  switch (request.type) {
    case "profile:get": {
      const profile = await store.getProfile()
      const entries = await store.getEntries()
      return ok({ ...profile, entries })
    }

    case "profile:save": {
      const payload = request.payload as {
        profile?: Profile
        entries?: Parameters<typeof store.saveEntries>[0]
      }
      if (payload.profile) await store.saveProfile(payload.profile)
      if (payload.entries) await store.saveEntries(payload.entries)
      return ok({})
    }

    case "settings:get": {
      return ok(await store.getSettings())
    }

    case "settings:save": {
      const payload = request.payload as Parameters<typeof store.saveSettings>[0]
      // FR-028：第一版不读写 llm*（v1.1 预留）——落库时强制回写默认值，杜绝 Key 入库（T050）
      const settings = { ...payload, ...defaultSettings() }
      await store.saveSettings(settings)
      return ok(settings)
    }

    case "memory:lookup": {
      const payload = request.payload as { signatures: string[] }
      return ok(await store.memoryLookup(payload.signatures))
    }

    case "memory:write": {
      const items = request.payload as Parameters<typeof store.memoryWrite>[0]
      await store.memoryWrite(items)
      return ok({})
    }

    case "report:save": {
      const report = request.payload as Parameters<typeof store.pushFillReport>[0]
      // 防御性掩码：入库前对敏感字段值再次掩码（S10）
      const masked = {
        ...report,
        items: report.items.map((item) => ({
          ...item,
          value: item.value !== undefined ? maskValue(item.semanticFieldId, item.value) : item.value
        }))
      }
      await store.pushFillReport(masked)
      return ok({})
    }

    case "report:list": {
      return ok(await store.listFillReports())
    }

    case "resume:confirm": {
      // T047: 确认导入（FR-007 写入规则 / FR-010 重复导入强制选择覆盖或合并）
      const p = request.payload as {
        draftId: string
        importMode?: "overwrite" | "merge"
        fields: ResumeDraft["fields"]
        entries: ExperienceEntry[]
      }
      const existing = await store.getProfile()
      const existingEntries = await store.getEntries()
      const hasExisting = !isProfileEmpty(existing)

      if (hasExisting && (p.importMode !== "overwrite" && p.importMode !== "merge")) {
        return fail(ErrorCode.VALIDATION_ERROR, "重复导入必须选择“覆盖”或“合并”（FR-010）")
      }
      const mode: "overwrite" | "merge" = p.importMode ?? "overwrite"

      const nextProfile = mode === "overwrite" ? emptyProfile() : existing
      for (const id of ALL_SCALAR_FIELD_IDS) {
        const f = p.fields[id]
        // 未填不写入（FR-006/007）
        if (!f || f.value.trim() === "") continue
        if (mode === "merge") {
          const keep = getScalarField(existing, id)
          // merge：已确认手动值优先保留（FR-010）
          if (keep && keep.state === "confirmed" && keep.source === "manual" && keep.value.trim() !== "") {
            continue
          }
        }
        // 未编辑 high → confirmed；未编辑 low → needs_review；编辑过 → confirmed（FR-007/008）
        const state: FieldState = f.edited || f.confidence === "high" ? "confirmed" : "needs_review"
        setScalarField(nextProfile, id, { value: f.value.trim(), state, source: "resume", updatedAt: Date.now() })
      }

      let nextEntries: ExperienceEntry[]
      if (mode === "overwrite") {
        nextEntries = p.entries.map((e, i) => ({ ...e, order: i }))
      } else {
        nextEntries = [...existingEntries]
        const keyOf = (e: ExperienceEntry): string => `${e.kind}|${e.title}|${e.start ?? ""}`
        const seen = new Set(nextEntries.map(keyOf))
        let seq = nextEntries.length
        for (const e of p.entries) {
          if (seen.has(keyOf(e))) continue
          nextEntries.push({ ...e, order: seq++ })
          seen.add(keyOf(e))
        }
      }

      // 先整体校验再落库，避免 profile 写入而 entries 失败的半提交
      const errors: Record<string, string> = { ...validateProfile(nextProfile) }
      for (const e of nextEntries) Object.assign(errors, validateEntry(e))
      if (Object.keys(errors).length > 0) {
        return fail(ErrorCode.VALIDATION_ERROR, "导入数据校验失败", errors)
      }
      await store.saveProfile(nextProfile)
      await store.saveEntries(nextEntries)
      if ((await store.getResumeDraft())?.id === p.draftId) {
        await store.setResumeDraft(null)
      }
      return ok({})
    }

    case "resume:discard": {
      // 用户放弃 → 清空草稿，不产生任何写入（data-model §5）
      const p = request.payload as { draftId: string }
      const draft = await store.getResumeDraft()
      if (draft && draft.id === p.draftId) await store.setResumeDraft(null)
      return ok({})
    }

    case "autofill:run": {
      const profile = await store.getProfile()
      if (isProfileEmpty(profile)) {
        return fail(ErrorCode.NO_PROFILE, "资料库为空，请先在资料管理页建档")
      }
      const tabs = (globalThis as { chrome?: typeof chrome }).chrome?.tabs
      if (!tabs) return fail(ErrorCode.TAB_UNAVAILABLE, "chrome.tabs 不可用")
      const [tab] = await tabs.query({ active: true, lastFocusedWindow: true })
      if (!tab?.id) return fail(ErrorCode.TAB_UNAVAILABLE, "找不到当前标签页")
      if (tab.url !== undefined && !isHttpUrl(tab.url)) {
        return fail(ErrorCode.TAB_UNAVAILABLE, "当前页面不支持自动填写（仅 http/https）")
      }
      try {
        return await forwardToTab(tab.id, {
          type: "autofill:run",
          payload: request.payload as { startedAt: number }
        })
      } catch {
        return fail(ErrorCode.TAB_UNAVAILABLE, "无法向当前页面注入（可能是 chrome:// 页面）")
      }
    }

    case "autofill:event": {
      // fire-and-forget 进度通知，应答即可
      return ok({})
    }

    case "confirm:resolve": {
      const p = request.payload as {
        sessionId: string
        signature: string
        choice: { kind: "pick"; value: string } | { kind: "skip" }
        semanticFieldId?: string
        ambiguous?: boolean
        valueKind?: "text" | "option"
        reportId?: string
      }
      if (p.choice.kind === "pick") {
        await store.memoryWrite([
          {
            signature: p.signature,
            semanticFieldId: p.semanticFieldId ?? "unknown",
            ambiguous: p.ambiguous ?? false,
            value: p.choice.value,
            valueKind: p.valueKind ?? "text",
            source: "user_confirm"
          }
        ])
        if (p.reportId && p.semanticFieldId) {
          await store.updateFillReportItem(
            p.reportId,
            p.semanticFieldId,
            "filled",
            maskValue(p.semanticFieldId, p.choice.value)
          )
        }
      }
      // skip：不写记忆（FR-023），报告状态保持 needs_confirm
      return ok({})
    }

    default:
      return undefined
  }
}

chrome.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
  const req = request as Request
  if (!req || typeof req.type !== "string" || !KNOWN_TYPES.has(req.type)) return false
  handleMessage(req).then(
    (res) => {
      if (res !== undefined) sendResponse(res)
    },
    (err: unknown) => {
      const details =
        err instanceof store.ValidationError ? err.details : undefined
      sendResponse(
        fail(
          err instanceof store.ValidationError ? ErrorCode.VALIDATION_ERROR : ErrorCode.INTERNAL,
          err instanceof Error ? err.message : String(err),
          details
        )
      )
    }
  )
  return true
})

export default function init(): void {
  // service worker 顶层已完成监听注册
}
