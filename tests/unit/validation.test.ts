// T027: 校验规则单测（FR-003 字段级错误）
// 覆盖：手机号/邮箱/长度边界、start ≤ end、title 必填、条目描述长度

import { describe, expect, it } from "vitest"
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  normalizePhone,
  validateEntry,
  validateProfile,
  validateScalarValue
} from "../../src/core/model/validation"
import { emptyProfile, type ExperienceEntry, type Profile } from "../../src/core/model/types"

function profileWith(basics: Record<string, string>, intent: Record<string, string> = {}): Profile {
  const p = emptyProfile()
  for (const [id, value] of Object.entries(basics)) {
    p.basics[id as keyof Profile["basics"]] = {
      value,
      state: "confirmed",
      source: "manual",
      updatedAt: 0
    }
  }
  for (const [id, value] of Object.entries(intent)) {
    p.intent[id as keyof Profile["intent"]] = {
      value,
      state: "confirmed",
      source: "manual",
      updatedAt: 0
    }
  }
  return p
}

function entry(patch: Partial<ExperienceEntry>): ExperienceEntry {
  return {
    id: "e1",
    kind: "education",
    order: 0,
    title: "某某大学",
    state: "confirmed",
    source: "manual",
    updatedAt: 0,
    ...patch
  }
}

describe("normalizePhone", () => {
  it("去空格/连字符/括号与 +86 前缀", () => {
    expect(normalizePhone(" +86 138-0013-8000 ")).toBe("13800138000")
    expect(normalizePhone("138 0013 8000")).toBe("13800138000")
    expect(normalizePhone("(0)13800138000")).toBe("013800138000")
  })
})

describe("validateScalarValue 手机号", () => {
  it("合法 11 位大陆手机号通过", () => {
    expect(validateScalarValue("basic.phone", "13800138000")).toBeNull()
    expect(validateScalarValue("basic.phone", "19912345678")).toBeNull()
  })

  it("归一化后合法的也通过", () => {
    expect(validateScalarValue("basic.phone", "138-0013-8000")).toBeNull()
    expect(validateScalarValue("basic.phone", "+86 138 0013 8000")).toBeNull()
  })

  it("非法格式给出字段级错误信息", () => {
    expect(validateScalarValue("basic.phone", "12345")).toBe(
      "手机号格式不正确（需 11 位大陆手机号）"
    )
    expect(validateScalarValue("basic.phone", "12300138000")).toBe(
      "手机号格式不正确（需 11 位大陆手机号）"
    )
    expect(validateScalarValue("basic.phone", "138001380001")).toBe(
      "手机号格式不正确（需 11 位大陆手机号）"
    )
  })

  it("留空视为缺失而非错误", () => {
    expect(validateScalarValue("basic.phone", "")).toBeNull()
    expect(validateScalarValue("basic.phone", "   ")).toBeNull()
  })
})

describe("validateScalarValue 邮箱", () => {
  it("合法邮箱通过", () => {
    expect(validateScalarValue("basic.email", "a.b+c@mail.example.com")).toBeNull()
  })

  it("非法邮箱给出错误", () => {
    expect(validateScalarValue("basic.email", "not-an-email")).toBe("邮箱格式不正确")
    expect(validateScalarValue("basic.email", "a@b")).toBe("邮箱格式不正确")
    expect(validateScalarValue("basic.email", "a b@c.com")).toBe("邮箱格式不正确")
  })

  it("留空允许", () => {
    expect(validateScalarValue("basic.email", "")).toBeNull()
  })
})

describe("validateScalarValue 长度边界", () => {
  it("姓名必填且 ≤60", () => {
    expect(validateScalarValue("basic.name", "")).toBe("姓名不能为空")
    expect(validateScalarValue("basic.name", "  ")).toBe("姓名不能为空")
    expect(validateScalarValue("basic.name", "张三")).toBeNull()
    expect(validateScalarValue("basic.name", "张".repeat(MAX_NAME_LENGTH))).toBeNull()
    expect(validateScalarValue("basic.name", "张".repeat(MAX_NAME_LENGTH + 1))).toBe(
      `姓名不能超过 ${MAX_NAME_LENGTH} 字符`
    )
  })

  it("其他文本字段 ≤500", () => {
    expect(validateScalarValue("basic.school", "X".repeat(MAX_TEXT_LENGTH))).toBeNull()
    expect(validateScalarValue("basic.school", "X".repeat(MAX_TEXT_LENGTH + 1))).toBe(
      `内容不能超过 ${MAX_TEXT_LENGTH} 字符`
    )
  })
})

describe("validateProfile", () => {
  it("全部合法 → 无错误", () => {
    const p = profileWith(
      { "basic.name": "张三", "basic.phone": "13800138000", "basic.email": "a@b.com" },
      { "intent.position": "前端工程师", "intent.city": "上海" }
    )
    expect(validateProfile(p)).toEqual({})
  })

  it("多个字段错误逐字段返回", () => {
    const p = profileWith({ "basic.name": "", "basic.phone": "123", "basic.email": "x" })
    const errors = validateProfile(p)
    expect(Object.keys(errors).sort()).toEqual(["basic.email", "basic.name", "basic.phone"])
    expect(errors["basic.name"]).toBe("姓名不能为空")
  })

  it("缺键（资料库缺失）不产生错误", () => {
    expect(validateProfile(emptyProfile())).toEqual({})
  })
})

describe("validateEntry", () => {
  it("title 必填", () => {
    expect(validateEntry(entry({ title: "" }))).toEqual({ "education.title": "标题/名称不能为空" })
    expect(validateEntry(entry({ title: "   " }))).toEqual({
      "education.title": "标题/名称不能为空"
    })
  })

  it("start ≤ end 边界（同月/倒序）", () => {
    expect(validateEntry(entry({ start: "2022.09", end: "2024.06" }))).toEqual({})
    expect(validateEntry(entry({ start: "2022.09", end: "2022.09" }))).toEqual({})
    expect(validateEntry(entry({ start: "2024.06", end: "2022.09" }))).toEqual({
      "education.start": "开始时间不能晚于结束时间"
    })
    // 单数字月份归一化：2022.9 > 2022.10 不应误判
    expect(validateEntry(entry({ start: "2022.9", end: "2022.10" }))).toEqual({})
    expect(validateEntry(entry({ start: "2022.10", end: "2022.9" }))).toEqual({
      "education.start": "开始时间不能晚于结束时间"
    })
  })

  it("'至今' 作为 end 合法", () => {
    expect(validateEntry(entry({ start: "2023.07", end: "至今" }))).toEqual({})
  })

  it("缺一端不比较", () => {
    expect(validateEntry(entry({ start: "2024.06" }))).toEqual({})
    expect(validateEntry(entry({ end: "2022.09" }))).toEqual({})
  })

  it("description 长度边界", () => {
    expect(validateEntry(entry({ description: "X".repeat(MAX_DESCRIPTION_LENGTH) }))).toEqual({})
    expect(
      validateEntry(entry({ description: "X".repeat(MAX_DESCRIPTION_LENGTH + 1) }))
    ).toEqual({
      "education.description": `描述不能超过 ${MAX_DESCRIPTION_LENGTH} 字符`
    })
  })

  it("错误键按条目 kind 前缀区分", () => {
    const e = entry({ kind: "internship", title: "" })
    expect(validateEntry(e)).toEqual({ "internship.title": "标题/名称不能为空" })
  })
})

describe("T063 性别/出生日期校验", () => {
  it("性别只认 男/女，留空允许", () => {
    expect(validateScalarValue("basic.gender", "男")).toBeNull()
    expect(validateScalarValue("basic.gender", "女")).toBeNull()
    expect(validateScalarValue("basic.gender", "")).toBeNull()
    expect(validateScalarValue("basic.gender", "保密")).toContain("男")
  })

  it("出生日期宽松格式通过，乱码报错", () => {
    expect(validateScalarValue("basic.birthday", "1999-09-01")).toBeNull()
    expect(validateScalarValue("basic.birthday", "1999年9月")).toBeNull()
    expect(validateScalarValue("basic.birthday", "1999.09")).toBeNull()
    expect(validateScalarValue("basic.birthday", "1999")).toBeNull()
    expect(validateScalarValue("basic.birthday", "")).toBeNull()
    expect(validateScalarValue("basic.birthday", "abc")).not.toBeNull()
  })
})
