// T009: 语义字段词表（contracts/semantic-fields.md §1-§4）
// 中文/英文别名、经历区块信号、非填写区黑名单、歧义标签、选项等价表

import type { ScalarFieldId } from "../model/types"
import type { EntryKind } from "../model/types"

export type ControlKind =
  | "text"
  | "tel"
  | "email"
  | "select"
  | "radio"
  | "checkbox"
  | "textarea"

export interface ScalarVocab {
  id: ScalarFieldId
  zh: string[]
  en: string[]
  controls: ControlKind[]
}

// ---------- §1 标量字段 ----------

export const SCALAR_VOCABULARY: ScalarVocab[] = [
  {
    id: "basic.name",
    zh: ["姓名", "名字", "真实姓名", "申请人姓名", "姓 名", "本人姓名"],
    en: ["name", "full name", "applicant name", "your name"],
    controls: ["text"]
  },
  {
    id: "basic.phone",
    zh: ["手机号", "手机号码", "联系电话", "移动电话", "手机", "电话号码", "手机号码(必填)"],
    en: ["mobile", "phone", "cell", "telephone", "mobile number", "phone number"],
    controls: ["tel", "text"]
  },
  {
    id: "basic.email",
    zh: ["邮箱", "电子邮箱", "电子邮件", "邮箱地址", "email 地址", "电子信箱"],
    en: ["email", "e-mail", "email address", "mail"],
    controls: ["email", "text"]
  },
  {
    id: "basic.school",
    zh: ["学校", "毕业院校", "就读学校", "最高学历毕业学校", "学校名称", "毕业学校", "院校名称"],
    en: ["school", "university", "college", "institution", "school name"],
    controls: ["text"]
  },
  {
    id: "basic.major",
    zh: ["专业", "所学专业", "专业名称", "主修专业", "就读专业"],
    en: ["major", "specialty", "field of study", "major subject"],
    controls: ["text"]
  },
  {
    id: "basic.degree",
    zh: ["学历", "最高学历", "学历层次", "学历学位", "教育程度"],
    en: ["degree", "education level", "highest degree"],
    controls: ["select", "radio", "text"]
  },
  {
    id: "basic.political_status",
    zh: ["政治面貌", "党团面貌", "政治面目"],
    en: ["political status", "political affiliation"],
    controls: ["select", "text", "radio"]
  },
  {
    id: "intent.position",
    zh: ["应聘岗位", "求职岗位", "意向岗位", "投递岗位", "应聘职位", "职位", "岗位", "申请岗位"],
    en: ["position", "job title", "role", "applied role", "job"],
    controls: ["text", "select"]
  },
  {
    id: "intent.city",
    zh: ["意向城市", "工作地点", "期望城市", "工作城市", "求职城市", "期望工作城市", "工作所在地"],
    en: ["city", "location", "work location", "preferred location"],
    controls: ["text", "select"]
  },
  {
    id: "intent.salary",
    zh: ["期望薪资", "薪资要求", "期望月薪", "意向薪资", "期望年薪", "薪资"],
    en: ["expected salary", "salary expectation", "salary"],
    controls: ["text", "select"]
  }
]

// ---------- §2 经历区块 ----------

export const ENTRY_BLOCK_TITLES: Record<EntryKind, string[]> = {
  education: ["教育经历", "教育背景", "教育情况", "学习经历", "受教育经历"],
  internship: ["实习经历", "实习经验", "实践经历", "工作经历", "工作经验", "社会实践"],
  project: ["项目经历", "项目经验", "科研经历", "项目介绍"],
  award: ["获奖情况", "获奖经历", "奖励情况", "荣誉情况", "证书", "资格证书", "所获奖励"]
}

/** 经历区块内"列"（条目属性）别名：命中 → entry.<kind>.<suffix> */
export const ENTRY_COLUMN_ALIASES: Record<
  string,
  { zh: string[]; en: string[]; controls: ControlKind[] }
> = {
  title: {
    zh: ["学校名称", "学校", "院校", "公司名称", "公司", "单位名称", "项目名称", "项目名", "奖项名称", "奖项名", "获奖项目"],
    en: ["school", "company", "organization", "project name", "award name"],
    controls: ["text"]
  },
  subtitle: {
    zh: ["专业", "院系", "部门", "担任角色", "角色", "职务", "岗位", "颁发方", "颁发单位"],
    en: ["major", "department", "role", "position", "issuer"],
    controls: ["text", "select"]
  },
  start: {
    zh: ["开始时间", "起始时间", "入学时间", "开始日期", "起止时间(起)", "from"],
    en: ["start", "start date", "from", "period from"],
    controls: ["text", "select"]
  },
  end: {
    zh: ["结束时间", "毕业时间", "离职时间", "结束日期", "至今", "to"],
    en: ["end", "end date", "to", "period to"],
    controls: ["text", "select"]
  },
  description: {
    zh: ["工作内容", "工作职责", "职责", "项目描述", "项目内容", "主要成果", "描述", "内容描述", "贡献", "业绩"],
    en: ["description", "responsibilities", "details", "content"],
    controls: ["textarea", "text"]
  }
}

// ---------- §3 非填写区（一律标 manual_required，FR-018） ----------
// 按控件角色分组：文本输入只套验证码类、勾选框只套条款类、按钮类只套按钮词（避免"投递日期"误伤）

export const CAPTCHA_PATTERNS: RegExp[] = [/验证码/, /captcha/i, /扫码/, /二维码/, /ocr/i]

export const AGREEMENT_PATTERNS: RegExp[] = [
  /我.{0,8}(已)?.{0,4}(阅读|同意)/,
  /同意.{0,6}(条款|协议|隐私|声明)/,
  /(条款|协议|隐私政策).{0,6}(同意|勾选)/
]

export const BUTTON_PATTERNS: RegExp[] = [
  /提交/,
  /投递/,
  /下一步/,
  /上一步/,
  /确认投递/,
  /立即申请/,
  /申请职位/,
  /确认提交/,
  /注册/,
  /登录/,
  /找回密码/
]

export const NON_FILLABLE_LABEL_PATTERNS: RegExp[] = [
  ...CAPTCHA_PATTERNS,
  ...AGREEMENT_PATTERNS,
  ...BUTTON_PATTERNS,
  /扫码登录/,
  /二维码/
]

/** 直接按控件类型判定不可填（仍需上报 manual_required） */
export const NON_FILLABLE_INPUT_TYPES = new Set([
  "password",
  "file",
  "submit",
  "button",
  "image",
  "reset"
])

/** 完全忽略、不上报的控件类型 */
export const IGNORED_INPUT_TYPES = new Set(["hidden"])

// ---------- §4 歧义字段（FR-022） ----------

export const AMBIGUOUS_LABELS = [
  "备注",
  "其他说明",
  "补充信息",
  "自我评价",
  "其他",
  "说明",
  "备注信息"
]

// ---------- 选项等价表 ----------

export const DEGREE_EQUIVALENCES: Array<{ canonical: string; keys: string[] }> = [
  {
    canonical: "本科",
    keys: ["本科", "学士", "大学本科", "本科及以上(本科)", "bachelor", "undergraduate", "b.a.", "ba"]
  },
  {
    canonical: "硕士",
    keys: ["硕士", "研究生", "硕士研究生", "master", "postgraduate", "m.a.", "ma", "mba"]
  },
  {
    canonical: "博士",
    keys: ["博士", "博士研究生", "phd", "doctor", "doctorate", "ph.d."]
  },
  {
    canonical: "大专",
    keys: ["大专", "专科", "高职", "associate"]
  },
  {
    canonical: "高中",
    keys: ["高中", "中专", "中技", "高中及以下"]
  }
]

export const POLITICAL_STATUS_VALUES = [
  "中共党员",
  "中共预备党员",
  "共青团员",
  "群众",
  "无党派人士",
  "民主党派"
]

// ---------- 值归一化辅助 ----------

/** 语义字段 → 展示名（报告 not_found 条目用） */
export function semanticFieldLabel(id: string): string {
  const scalar = SCALAR_VOCABULARY.find((v) => v.id === id)
  if (scalar) return scalar.zh[0] ?? id
  return id
}

/** 选项等价匹配：返回等价的页面选项原文（未命中返回 null） */
export function findEquivalentOption(profileValue: string, options: string[]): string | null {
  const pv = profileValue.trim()
  if (pv === "") return null

  const hitDirect = options.find((o) => normOption(o) === normOption(pv))
  if (hitDirect) return hitDirect

  const degree = DEGREE_EQUIVALENCES.find((g) =>
    g.keys.some((k) => normOption(k) === normOption(pv))
  )
  if (degree) {
    const equiv = options.find((o) =>
      degree.keys.some((k) => normOption(k) === normOption(o))
    )
    if (equiv) return equiv
  }
  return null
}

export function normOption(s: string): string {
  return s
    .toLowerCase()
    .replace(/[（）()【】[\]{}·、，,。.．\-—_/\\|:：;；'"\s]/g, "")
    .trim()
}

/** 期望薪资归一化为区间：[15000, 20000]；无法解析返回 null */
export function salaryRange(value: string): [number, number] | null {
  const v = value.toLowerCase().replace(/\s/g, "")
  const nums = Array.from(v.matchAll(/(\d+(?:\.\d+)?)\s*(k)?/g)).map((m) => {
    const n = Number(m[1])
    return m[2] || /k/.test(v) ? n * 1000 : n
  })
  if (nums.length === 0) return null
  if (nums.length === 1) return [nums[0] as number, nums[0] as number]
  const a = Math.min(nums[0] as number, nums[1] as number)
  const b = Math.max(nums[0] as number, nums[1] as number)
  return [a, b]
}

/** 两个薪资值是否同类（SC 归一化语义，§1 intent.salary 备注） */
export function salaryEquivalent(a: string, b: string): boolean {
  const ra = salaryRange(a)
  const rb = salaryRange(b)
  if (!ra || !rb) return a.trim() === b.trim()
  return ra[0] === rb[0] && ra[1] === rb[1]
}
