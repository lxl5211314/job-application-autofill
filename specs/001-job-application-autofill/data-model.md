# Phase 1 Data Model: 网申表格自动填写插件

**Feature**: 001-job-application-autofill | **Date**: 2026-09-27

全部实体持久化于 `chrome.storage.local`，键名与实体一一对应（见 research.md R3）。校验规则来源于 spec FR-003 / FR-008 / FR-020 等。类型定义落于 `src/core/model/`，存储读写落于 `src/core/storage/`。

## 0. 存储总览

| 存储键 | 实体 | 形态 | 说明 |
|--------|------|------|----------------|
| `schemaVersion` | — | number | 当前为 1；变更时执行迁移函数 |
| `profile` | Profile | 单例对象 | 基本信息 + 求职意向 |
| `entries` | ExperienceEntry[] | 数组 | 四类经历条目混合存放，按 `kind` + `order` 组织 |
| `fieldMemory` | FieldMemory[] | 数组 | 字段记忆，上限 2000 条，LRU 淘汰 |
| `fillReports` | FillReport[] | 数组 | 仅保留最近 20 条 |
| `resumeDrafts` | ResumeDraft | 单例（当前草稿） | 确认或丢弃后清空 |
| `settings` | Settings | 单例对象 | 基础设置（`llm*` 字段为 v1.1 预留，spec FR-028） |

---

## 1. Profile（个人资料库主体，单例）

用户求职档案的"标量"部分。**仅 `state: "confirmed"` 的字段参与自动填写**（spec Key Entities：草稿/已确认）。

```ts
type FieldState = "confirmed" | "needs_review"   // needs_review: 简历导入的低置信/待核对值
type FieldSource = "manual" | "resume" | "llm_rewrite"   // "llm_rewrite" 为 v1.1 预留，第一版不会产生（spec FR-028）

interface ProfileField {
  value: string
  state: FieldState
  source: FieldSource
  updatedAt: number            // epoch ms
}

interface Profile {
  schemaVersion: 1
  basics: Record<BasicFieldId, ProfileField>   // 缺键 = 资料库缺失（FR-015）
  intent: Record<IntentFieldId, ProfileField>
}
```

**字段 ID（与 contracts/semantic-fields.md 对齐）**：

- `BasicFieldId` = `basic.name | basic.phone | basic.email | basic.school | basic.major | basic.degree | basic.political_status`
- `IntentFieldId` = `intent.position | intent.city | intent.salary`

**校验（FR-003，保存时执行，失败拒绝保存并给出字段级错误）**：

| 字段 | 规则 |
|------|------|
| `basic.phone` | 大陆手机号 `^1[3-9]\d{9}$`（允许输入时带空格/连字符，归一化后校验） |
| `basic.email` | 常规邮箱正则 `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `basic.name` | 非空、≤ 60 字符 |
| 其余文本字段 | 非空可选（允许留空=缺失）、单字段 ≤ 500 字符 |

**状态流转**：`needs_review --用户确认/修改保存--> confirmed`；`confirmed --用户修改--> confirmed`（值更新）。不存在自动把 `needs_review` 变 `confirmed` 的路径（FR-008）。

---

## 2. ExperienceEntry（经历条目，多条）

```ts
type EntryKind = "education" | "internship" | "project" | "award"

interface ExperienceEntry {
  id: string                    // 本地生成 uuid
  kind: EntryKind
  order: number                 // 同 kind 内排序（FR-002）
  title: string                 // 学校/公司/项目名/奖项名
  subtitle?: string             // 专业/部门/角色/颁发方
  start?: string                // "YYYY.MM"，award 可无
  end?: string                  // "YYYY.MM" 或 "至今"
  description?: string          // 职责/成果/项目描述（≤ 2000 字符）
  state: FieldState
  source: FieldSource
  updatedAt: number
}
```

- **关系**：与 Profile 平级（数组独立存储），共同构成资料库；自动填写时按 `kind` 语义映射到页面对应区域（FR-012）。
- **校验**：`title` 必填（保存条目时校验）；`start ≤ end`（均有值时）；`kind` 必须是枚举值。
- **状态流转**：同 ProfileField；导入草稿确认后整体并入（每条自带 state）。

---

## 3. FieldMemory（字段记忆，上限 2000 条 LRU）

```ts
interface FieldMemory {
  signature: string             // 规范化字段签名（主键，见下）
  semanticFieldId: string       // 归属语义字段；"unknown" 表示仅签名匹配
  ambiguous: boolean            // 歧义标签（如"备注"）→ 使用前必须再确认（FR-022）
  value: string
  valueKind: "text" | "option"  // option: 记忆的是下拉/单选项的规范值
  source: "user_confirm" | "user_edit"   // 只能来自这两种（FR-020；"跳过"不产生记忆 FR-023）
  useCount: number
  lastUsedAt: number
  createdAt: number
}
```

- **签名（signature）** 由字段上下文归一化生成：`norm(label 文本) + 控件类型 + 归一化 name/id/placeholder + 选项集指纹（若有）`（设计细节在 contracts/messages.md 与 matching 模块文档中给出公式；跨站点稳定性是 SC-003 的关键）。
- **状态流转**：`user_confirm/user_edit 写入 → 每次自动命中 useCount++/lastUsedAt 更新 → 超过 2000 条按 lastUsedAt 淘汰`；`ambiguous=true` 的记忆命中后仍进确认面板（FR-022/023）。

---

## 4. FillReport（填写结果清单，保留最近 20 条）

```ts
type FillItemStatus =
  | "filled"            // 已填写
  | "needs_confirm"     // 待确认（已进确认面板）
  | "not_found"         // 页面未找到匹配字段
  | "missing_in_profile"// 资料库缺失
  | "manual_required"   // 需手动完成（验证码/上传/提交等，FR-018）

interface FillReportItem {
  semanticFieldId: string | null   // 页面字段未能归类时为 null
  label: string                    // 页面上的原始字段标签（展示用）
  status: FillItemStatus
  value?: string                   // filled 时记录所填值（脱敏：手机号/邮箱仅展示掩码）
  reason?: string                  // needs_confirm 的原因/候选说明
}

interface FillReport {
  id: string
  hostname: string
  url: string                      // 去除 query 的规范化 URL
  createdAt: number
  usedLlm: boolean                 // 本次是否调用了 LLM（第一版恒为 false，v1.1 预留字段）
  items: FillReportItem[]
}
```

- **状态流转**：每次会话追加 → >20 条时淘汰最旧（research R8）。报告本身是只读快照，不回写资料库。

---

## 5. ResumeDraft（简历导入草稿，单例）

```ts
interface DraftField {
  value: string
  confidence: "high" | "low"      // low = "待核对"（FR-008）
  extracted: boolean              // false = 简历中读不到（FR-006），留空待补
}

interface ResumeDraft {
  id: string
  fileName: string
  createdAt: number
  status: "pending" | "confirmed" | "discarded"
  fields: Record<string /* BasicFieldId | IntentFieldId */, DraftField>
  entries: ExperienceEntry[]      // 预填的经历条目（state 按 confidence 映射）
  importMode?: "overwrite" | "merge"   // 用户选择（FR-010），确认时生效
}
```

**状态流转**：

```text
(解析成功) → pending → 用户逐项检查/修改/补空 → confirmed（写入 profile/entries 后清空草稿）
                │
                ├─ 扫描件/无文本 → 不创建草稿，直接报错提示手动填写（FR-009）
                └─ 用户放弃 → discarded（清空，不产生任何写入）
```

- **写入规则（FR-007）**：`confirmed` 时以用户确认后的值覆盖 `profile`/`entries`；用户未编辑的 `high` → `confirmed`，未编辑的 `low` → `needs_review`；`extracted:false` 且用户未填 → 不写入该键（保持"资料库缺失"）。
- **重复导入（FR-010）**：若已存在 `profile`，导入前必须选择 `overwrite`（整体覆盖）或 `merge`（已确认的手动值优先保留），无默认静默行为。

---

## 6. Settings（设置，单例）

```ts
interface Settings {
  // 以下 llm* 字段为 v1.1 预留（spec FR-028：第一版不含 AI/LLM），第一版不建 UI、不读写，仅保留类型定义
  llmEnabled: boolean             // 默认 false（research R7）
  llmProvider: "openai" | "deepseek" | "anthropic" | "moonshot" | "zhipu" | null
  llmModel: string
  llmApiKey: string               // 仅存本机 storage；UI 中掩码展示，不出扩展
  llmRewriteEnabled: boolean      // 内容改写单独开关（外发文本，用户主动触发）
}
```

- **校验**（v1.1 预留）：`llmEnabled=true` 时 provider/model/key 必填；保存时按 provider 校验 Key 形态（前缀规则），并在用户手势下申请对应 `optional_host_permissions`。第一版不做 LLM 校验、不申请任何 host 权限。

---

## 7. 实体关系图（文本）

```text
Profile (单例)
  ├─ basics[7 个 ProfileField]  ─┐
  └─ intent[3 个 ProfileField]  ─┤ 全部 confirmed 才进入自动填写数据源
ExperienceEntry[] (education/internship/project/award，各多条)
        ▲
        │ confirmed 后写入
ResumeDraft (单例, pending→confirmed/discarded)
        │ 解析自
   [本地 PDF 文件（不落盘存储）]

FieldMemory[] ── signature ── 页面字段签名（跨站点复用，LRU≤2000）
FillReport[]  ── 每次填写会话的只读快照（≤20）
Settings      ── 基础设置（llm* 开关与凭据为 v1.1 预留）
```
