// T037: 记忆行为单测（FR-020/021/022/023 + data-model §3 LRU）
// 记忆命中跳过询问；歧义记忆仍询问；skip 不写入；非显式来源不写入；2000 上限淘汰

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { buildFillPlan, matchField } from "../../src/core/matching/match"
import { scanDocument, type ScannedField } from "../../src/core/matching/scan"
import * as store from "../../src/core/storage/store"
import type { FieldMemory } from "../../src/core/model/types"
import { loadProfileFixture, parseFixture } from "./helpers/seed-profile"
import { installFakeChrome, type FakeChromeHandle } from "./helpers/fake-chrome"

const { profile, entries } = loadProfileFixture()
const fixtureDoc = parseFixture("sample-form.html")

function byLabel(labelText: string): ScannedField {
  const field = scanDocument(fixtureDoc).find((f) => f.labelText === labelText)
  if (!field) throw new Error(`夹具缺少字段：${labelText}`)
  return field
}

function memoryOf(
  field: ScannedField,
  overrides: Partial<FieldMemory> = {}
): FieldMemory {
  return {
    signature: field.signature,
    semanticFieldId: "intent.salary",
    ambiguous: false,
    value: "15-20K",
    valueKind: "text",
    source: "user_confirm",
    useCount: 0,
    lastUsedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

// ---------- 后台路由（confirm:resolve / memory:*） ----------

let fake: FakeChromeHandle

function dispatch(request: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let responded = false
    const sendResponse = (res: unknown): void => {
      responded = true
      resolve(res)
    }
    let keep = false
    for (const listener of fake.listeners) {
      const ret = listener(request, {}, sendResponse)
      if (ret === true) keep = true
    }
    if (!keep && !responded) resolve(undefined)
  })
}

beforeAll(async () => {
  fake = installFakeChrome()
  await import("../../src/background")
})

afterAll(() => {
  fake.uninstall()
})

beforeEach(() => {
  for (const key of Object.keys(fake.data)) delete fake.data[key]
})

// ---------- FR-021：记忆命中 → 直填不询问 ----------

describe("FR-021 记忆命中跳过询问", () => {
  it("签名命中非歧义记忆 → high 档 fill，取记忆值而非资料库值", () => {
    const field = byLabel("期望薪资")
    const memory = memoryOf(field, { value: "20-25K" })
    const match = matchField(field, memory)
    expect(match.confidence).toBe("high")
    expect(match.semanticFieldId).toBe("intent.salary")
    expect(match.reason).toContain("FR-021")

    const plan = buildFillPlan([field], profile, entries, {
      memoryBySig: new Map([[field.signature, memory]])
    })
    expect(plan.items[0]?.action).toBe("fill")
    expect(plan.items[0]?.value).toBe("20-25K") // 覆盖资料库的 15-20K
  })

  it("gray 字段（仅 name/id 信号）有记忆 → 直接 fill 不进确认", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input name="phone" type="text" /></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    const memory = memoryOf(field, {
      semanticFieldId: "basic.phone",
      value: "13900001111"
    })

    const plan = buildFillPlan([field], profile, entries, {
      memoryBySig: new Map([[field.signature, memory]])
    })
    expect(plan.items[0]?.action).toBe("fill")
    expect(plan.items[0]?.value).toBe("13900001111")
    expect(plan.items[0]?.match.reason).toContain("FR-021")
  })
})

// ---------- FR-022：歧义记忆仍询问 ----------

describe("FR-022 歧义签名即使有记忆仍询问", () => {
  it("memory.ambiguous = true → confirm 不自动填", () => {
    const field = byLabel("期望薪资")
    const memory = memoryOf(field, { ambiguous: true })
    const match = matchField(field, memory)
    expect(match.ambiguous).toBe(true)

    const plan = buildFillPlan([field], profile, entries, {
      memoryBySig: new Map([[field.signature, memory]])
    })
    expect(plan.items[0]?.action).toBe("confirm")
    expect(plan.items[0]?.match.ambiguous).toBe(true)
  })

  it("歧义标签字段（自我评价）本身 → 无记忆也 confirm", () => {
    const field = byLabel("自我评价")
    const plan = buildFillPlan([field], profile, entries)
    expect(plan.items[0]?.action).toBe("confirm")
  })
})

// ---------- FR-023：skip 不写入 ----------

describe("FR-023 confirm:resolve 落地", () => {
  it("choice = skip → 不写入记忆", async () => {
    await dispatch({
      type: "confirm:resolve",
      payload: {
        sessionId: "s1",
        signature: "sig-skip",
        choice: { kind: "skip" },
        semanticFieldId: "intent.salary",
        ambiguous: false,
        reportId: "r1"
      }
    })
    expect(await store.getAllMemory()).toHaveLength(0)
  })

  it("choice = pick → 写入记忆（source = user_confirm）", async () => {
    await dispatch({
      type: "confirm:resolve",
      payload: {
        sessionId: "s1",
        signature: "sig-pick",
        choice: { kind: "pick", value: "15-20K" },
        semanticFieldId: "intent.salary",
        ambiguous: false,
        valueKind: "text",
        reportId: "r1"
      }
    })
    const all = await store.getAllMemory()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      signature: "sig-pick",
      semanticFieldId: "intent.salary",
      value: "15-20K",
      source: "user_confirm"
    })
  })

  it("pick 写入的记忆带 ambiguous 标记 → 下次命中仍询问（FR-022 闭环）", async () => {
    await dispatch({
      type: "confirm:resolve",
      payload: {
        sessionId: "s1",
        signature: "sig-amb",
        choice: { kind: "pick", value: "备注内容" },
        semanticFieldId: null,
        ambiguous: true,
        valueKind: "text",
        reportId: "r1"
      }
    })
    const [hit] = await store.memoryLookup(["sig-amb"])
    expect(hit?.memory?.ambiguous).toBe(true)

    const field = byLabel("期望薪资")
    const match = matchField(field, hit?.memory ?? null)
    expect(match.ambiguous).toBe(true)
  })
})

// ---------- FR-020：非显式来源不写入 ----------

describe("FR-020 只有显式动作才写记忆", () => {
  it("memory:write 拒绝 user_confirm/user_edit 以外的来源", async () => {
    const res = (await dispatch({
      type: "memory:write",
      payload: [
        {
          signature: "sig-x",
          semanticFieldId: "basic.name",
          ambiguous: false,
          value: "李四",
          valueKind: "text",
          source: "page_edit"
        }
      ]
    })) as { ok: boolean; error?: { message: string } }
    expect(res.ok).toBe(false)
    expect(res.error?.message).toContain("不允许的 memory source")
    expect(await store.getAllMemory()).toHaveLength(0)
  })

  it("memory:lookup 命中更新 useCount/lastUsedAt（data-model §3）", async () => {
    await store.memoryWrite([
      {
        signature: "sig-lookup",
        semanticFieldId: "basic.email",
        ambiguous: false,
        value: "a@b.com",
        valueKind: "text",
        source: "user_confirm"
      }
    ])
    const before = (await store.getAllMemory())[0]
    expect(before?.useCount).toBe(0)

    const res = (await dispatch({
      type: "memory:lookup",
      payload: { signatures: ["sig-lookup", "sig-miss"] }
    })) as { ok: true; data: Array<{ signature: string; memory: FieldMemory | null }> }

    expect(res.ok).toBe(true)
    const hit = res.data.find((r) => r.signature === "sig-lookup")
    expect(hit?.memory?.useCount).toBe(1)
    expect(hit?.memory?.lastUsedAt).toBeGreaterThanOrEqual(before?.lastUsedAt ?? 0)
    const miss = res.data.find((r) => r.signature === "sig-miss")
    expect(miss?.memory).toBeNull()
  })
})

// ---------- data-model §3：LRU 2000 上限 ----------

describe("记忆 LRU 上限", () => {
  it("写入 2001 条 → 淘汰至 2000 条上限", async () => {
    const batch = Array.from({ length: 2001 }, (_, i) => ({
      signature: `sig-${i}`,
      semanticFieldId: "basic.name",
      ambiguous: false,
      value: `v${i}`,
      valueKind: "text" as const,
      source: "user_confirm" as const
    }))
    await store.memoryWrite(batch)

    const all = await store.getAllMemory()
    expect(all).toHaveLength(store.MEMORY_LIMIT) // 同一时间戳下稳定排序，挤出最后插入者
    expect(all.find((m) => m.signature === "sig-2000")).toBeUndefined()
    expect(all.find((m) => m.signature === "sig-0")).toBeDefined()
  })

  it("追加新条目时淘汰最旧（2000 → 写入 1 条新的）", async () => {
    const first = Array.from({ length: 2000 }, (_, i) => ({
      signature: `old-${i}`,
      semanticFieldId: "basic.name",
      ambiguous: false,
      value: `v${i}`,
      valueKind: "text" as const,
      source: "user_confirm" as const
    }))
    await store.memoryWrite(first)

    // 时间推进后写入新条目 → lastUsedAt 更新，挤掉最旧
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 10_000
      await store.memoryWrite([
        {
          signature: "newest",
          semanticFieldId: "basic.name",
          ambiguous: false,
          value: "fresh",
          valueKind: "text",
          source: "user_confirm"
        }
      ])
    } finally {
      Date.now = realNow
    }

    const all = await store.getAllMemory()
    expect(all).toHaveLength(store.MEMORY_LIMIT)
    expect(all.find((m) => m.signature === "newest")).toBeDefined()
    expect(all.find((m) => m.signature === "old-1999")).toBeUndefined()
  })
})
