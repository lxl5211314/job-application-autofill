// T047: 简历导入写入流（FR-006/007/010）单测
// 首次导入写入规则（high→confirmed / 低置信未编辑→needs_review / 未填不写入）
// 重复导入强制选择覆盖或合并；merge 保留已确认手动值；草稿清除

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import * as store from "../../src/core/storage/store"
import {
  emptyProfile,
  getScalarField,
  isProfileEmpty,
  setScalarField,
  type DraftField,
  type ExperienceEntry,
  type Profile,
  type ResumeDraft,
  type ScalarFieldId
} from "../../src/core/model/types"
import { installFakeChrome, type FakeChromeHandle } from "./helpers/fake-chrome"

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

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: Record<string, string> } }

async function confirm(payload: Record<string, unknown>): Promise<Envelope> {
  return (await dispatch({ type: "resume:confirm", payload })) as Envelope
}

async function discard(payload: Record<string, unknown>): Promise<Envelope> {
  return (await dispatch({ type: "resume:discard", payload })) as Envelope
}

function draftFields(overrides: Partial<Record<ScalarFieldId, DraftField>>): ResumeDraft["fields"] {
  const fields: ResumeDraft["fields"] = {}
  const base = (value: string, confidence: "high" | "low", extracted = true): DraftField => ({
    value,
    confidence,
    extracted
  })
  fields["basic.name"] = base("张三", "high")
  fields["basic.phone"] = base("13812345678", "high")
  fields["basic.email"] = base("zhangsan@example.com", "high")
  fields["basic.school"] = base("清华大学", "low") // 未编辑低置信 → needs_review
  fields["basic.major"] = base("计算机科学与技术", "high")
  fields["basic.degree"] = base("本科", "high")
  fields["intent.position"] = base("", "low", false) // 未填不写入
  fields["intent.salary"] = base("", "low", false)
  return { ...fields, ...overrides }
}

function eduEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id: "resume-e0",
    kind: "education",
    order: 0,
    title: "清华大学",
    subtitle: "计算机科学与技术",
    start: "2020.09",
    end: "2024.06",
    state: "confirmed",
    source: "resume",
    updatedAt: 1,
    ...overrides
  }
}

function seedManualProfile(): Profile {
  const p = emptyProfile()
  setScalarField(p, "basic.name", {
    value: "手动名字",
    state: "confirmed",
    source: "manual",
    updatedAt: 1
  })
  setScalarField(p, "basic.degree", {
    value: "硕士研究生",
    state: "confirmed",
    source: "manual",
    updatedAt: 1
  })
  return p
}

beforeAll(() => {
  fake = installFakeChrome()
  return import("../../src/background")
})

afterAll(() => {
  fake.uninstall()
})

beforeEach(() => {
  for (const key of Object.keys(fake.data)) delete fake.data[key]
})

// ---------- 首次导入：FR-006/007 写入规则 ----------

describe("首次导入（资料库为空）", () => {
  it("省略 importMode → 成功写入 profile/entries 并清除草稿", async () => {
    await store.setResumeDraft({ id: "d1", fileName: "r.pdf", createdAt: 1, status: "pending", fields: {}, entries: [] })
    const res = await confirm({
      draftId: "d1",
      fields: draftFields({}),
      entries: [eduEntry()]
    })
    expect(res.ok).toBe(true)

    const profile = await store.getProfile()
    expect(isProfileEmpty(profile)).toBe(false)
    expect(getScalarField(profile, "basic.phone")).toMatchObject({
      value: "13812345678",
      state: "confirmed",
      source: "resume"
    })
    expect(getScalarField(profile, "basic.school")).toMatchObject({
      state: "needs_review",
      source: "resume"
    })
    expect(getScalarField(profile, "intent.position")).toBeUndefined() // FR-006 未填不写入

    const entries = await store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ title: "清华大学", source: "resume" })

    expect(await store.getResumeDraft()).toBeNull()
  })

  it("编辑过（edited）的低置信字段 → confirmed（FR-007）", async () => {
    const res = await confirm({
      draftId: "d2",
      fields: draftFields({
        "basic.school": { value: "北京大学", confidence: "low", extracted: true, edited: true }
      }),
      entries: []
    })
    expect(res.ok).toBe(true)
    const profile = await store.getProfile()
    expect(getScalarField(profile, "basic.school")).toMatchObject({
      value: "北京大学",
      state: "confirmed"
    })
  })

  it("导入值非法 → VALIDATION_ERROR 且资料库未被改动", async () => {
    const before = await store.getProfile()
    const res = await confirm({
      draftId: "d3",
      fields: draftFields({ "basic.phone": { value: "123", confidence: "high", extracted: true } }),
      entries: []
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("VALIDATION_ERROR")
    expect(res.error?.details?.["basic.phone"]).toContain("手机")
    expect(await store.getProfile()).toEqual(before)
    // 草稿不被清除（用户可修正后重试）
    await store.setResumeDraft({ id: "d3", fileName: "r.pdf", createdAt: 1, status: "pending", fields: {}, entries: [] })
    const retry = await confirm({
      draftId: "d3",
      fields: draftFields({ "basic.phone": { value: "123", confidence: "high", extracted: true } }),
      entries: []
    })
    expect(retry.ok).toBe(false)
    expect(await store.getResumeDraft()).not.toBeNull()
  })
})

// ---------- FR-010：重复导入必须选择覆盖或合并 ----------

describe("FR-010 重复导入", () => {
  beforeEach(async () => {
    await store.saveProfile(seedManualProfile())
    await store.saveEntries([eduEntry({ id: "existing-e0", title: "手动教育", source: "manual" })])
  })

  it("已有资料时省略 importMode → 拒绝", async () => {
    const res = await confirm({ draftId: "d10", fields: draftFields({}), entries: [] })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("VALIDATION_ERROR")
    expect(res.error?.message).toContain("覆盖")
    const profile = await store.getProfile()
    expect(getScalarField(profile, "basic.name")?.value).toBe("手动名字")
  })

  it("merge：保留已确认手动值，补空缺字段", async () => {
    const res = await confirm({
      draftId: "d11",
      importMode: "merge",
      fields: draftFields({}),
      entries: [eduEntry({ id: "imported-e1" })]
    })
    expect(res.ok).toBe(true)
    const profile = await store.getProfile()
    // 手动确认值不被覆盖
    expect(getScalarField(profile, "basic.name")?.value).toBe("手动名字")
    expect(getScalarField(profile, "basic.degree")?.value).toBe("硕士研究生")
    // 空缺字段被补上
    expect(getScalarField(profile, "basic.phone")?.value).toBe("13812345678")
    expect(getScalarField(profile, "basic.school")).toMatchObject({
      value: "清华大学",
      state: "needs_review"
    })
    // 条目去重保留 + 追加
    const entries = await store.getEntries()
    expect(entries.map((e) => e.title)).toEqual(["手动教育", "清华大学"])
  })

  it("merge 重复执行不产生重复条目", async () => {
    const payload = { draftId: "d12", importMode: "merge", fields: draftFields({}), entries: [eduEntry({ id: "imported-e1" })] }
    expect((await confirm(payload)).ok).toBe(true)
    expect((await confirm(payload)).ok).toBe(true)
    const entries = await store.getEntries()
    expect(entries).toHaveLength(2)
  })

  it("overwrite：整体替换为导入值", async () => {
    const res = await confirm({
      draftId: "d13",
      importMode: "overwrite",
      fields: draftFields({}),
      entries: [eduEntry({ id: "imported-e2" })]
    })
    expect(res.ok).toBe(true)
    const profile = await store.getProfile()
    expect(getScalarField(profile, "basic.name")?.value).toBe("张三")
    expect(getScalarField(profile, "basic.degree")?.value).toBe("本科")
    const entries = await store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.title).toBe("清华大学")
  })

  it("resume:discard：清空草稿且不改动资料库", async () => {
    const draft: ResumeDraft = { id: "dx", fileName: "r.txt", createdAt: 1, status: "pending", fields: draftFields({}), entries: [eduEntry()] }
    await store.setResumeDraft(draft)
    const res = await discard({ draftId: "dx" })
    expect(res.ok).toBe(true)
    expect(await store.getResumeDraft()).toBeNull()
    const profile = await store.getProfile()
    expect(getScalarField(profile, "basic.name")?.value).toBe("手动名字")
  })
})
