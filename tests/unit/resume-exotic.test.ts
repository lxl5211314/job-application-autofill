// T055: 真实简历兼容性回归——康熙部首字形、坏字体 NUL 日期、无标签姓名
// 夹具 resume-exotic.txt 为合成样例（不含真实隐私），复刻真实 PDF 的三类毛病：
// 1) 汉字被映射到康熙部首区块（⽤⼈⼤⽬⼩⼯⼿⼩⻰…）
// 2) 日期数字映射成 NUL，只剩 " .  -   . " 残骸
// 3) 首行即姓名（无“姓名：”标签）

import { describe, expect, it } from "vitest"

import {
  extractFromText,
  normalizeResumeText
} from "../../src/core/resume/extract"
import { parseTextResume } from "../../src/core/resume/text"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures")

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
}

describe("归一化 normalizeResumeText", () => {
  it("NFKD 还原康熙部首字形（⽤⼈⼤⽬⼩⼯⼿）", () => {
    expect(normalizeResumeText("⽤⼈⼤⼩⼯⼿⽬⾯⽹⼼⽣⼀⼊⼒⽰⽂⽴⾄⾏")).toBe(
      "用人大小工手目面网心生一入力示文立至行"
    )
  })

  it("手工表还原无兼容分解的部首（⻰⻓⻔⻚）", () => {
    expect(normalizeResumeText("刘⼩⻰ 周期⻓ 测试⻔禁 ⻚⾯⽣成")).toBe(
      "刘小龙 周期长 测试门禁 页面生成"
    )
  })

  it("剔除坏字体 NUL 控制字符（保留换行/制表）", () => {
    expect(normalizeResumeText("2021\u0000\u0000.09\nA\u0000B\tC")).toBe("2021.09\nAB\tC")
  })

  it("全角标点 NFKD 半角化后锚点仍命中", () => {
    const { fields } = extractFromText("姓名：张三\n政治面貌：中共党员")
    expect(fields["basic.name"]?.value).toBe("张三")
    expect(fields["basic.political_status"]?.value).toBe("中共党员")
  })
})

describe("真实简历兼容（resume-exotic.txt）", () => {
  const result = parseTextResume(fixtureText("resume-exotic.txt"))

  it("无标签首行姓名回退 → low 待核对（FR-008）", () => {
    expect(result.fields["basic.name"]).toEqual({
      value: "张小龙",
      confidence: "low",
      extracted: true
    })
  })

  it("手机/邮箱 → high", () => {
    expect(result.fields["basic.phone"]).toMatchObject({
      value: "13900139000",
      confidence: "high"
    })
    expect(result.fields["basic.email"]).toMatchObject({
      value: "demo@example.com",
      confidence: "high"
    })
  })

  it("教育行（日期残骸）→ 学校/专业/学历回填 low", () => {
    expect(result.fields["basic.school"]).toMatchObject({
      value: "江西农业大学",
      confidence: "low",
      extracted: true
    })
    expect(result.fields["basic.major"]).toMatchObject({
      value: "计算机科学与技术",
      extracted: true
    })
    expect(result.fields["basic.degree"]).toMatchObject({
      value: "本科",
      extracted: true
    })
  })

  it("五类条目全部识别（教育1+实习2+项目1+获奖1），简介/技能段不产生条目", () => {
    expect(result.entries).toHaveLength(5)
    expect(result.entries.filter((e) => e.kind === "education")).toHaveLength(1)
    expect(result.entries.filter((e) => e.kind === "internship")).toHaveLength(2)
    expect(result.entries.filter((e) => e.kind === "project")).toHaveLength(1)
    expect(result.entries.filter((e) => e.kind === "award")).toHaveLength(1)
  })

  it("部首字形归一化后的公司/项目名", () => {
    const intern = result.entries.filter((e) => e.kind === "internship")
    expect(intern[0]).toMatchObject({
      title: "用友网络科技股份有限公司",
      subtitle: "AI全栈开发工程师"
    })
    expect(intern[1]).toMatchObject({ title: "北京毫末科技有限公司" })
    const project = result.entries.find((e) => e.kind === "project")
    expect(project?.title).toBe("NexusAgent企业级多智能体知识平台")
    const award = result.entries.find((e) => e.kind === "award")
    expect(award).toMatchObject({
      title: "蓝桥杯全国软件和信息技术专业人才大赛",
      subtitle: "省一等奖(2025)"
    })
  })

  it("无日期条目 → needs_review 待核对（FR-007/FR-008）", () => {
    for (const e of result.entries) {
      expect(e.start).toBeUndefined()
      expect(e.state).toBe("needs_review")
      expect(e.source).toBe("resume")
    }
  })

  it("短行描述（无标点）并入条目描述而不是误判为新条目", () => {
    const intern = result.entries.filter((e) => e.kind === "internship")
    expect(intern[0]?.description).toContain("负责Agent链路编排")
  })
})
