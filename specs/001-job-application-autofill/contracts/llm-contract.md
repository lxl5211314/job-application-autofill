# Contract: 可选 LLM 调用（字段识别 / 内容改写）

**Feature**: 001-job-application-autofill | **Date**: 2026-09-27

> **【v1.1 预留，第一版不实现（spec FR-028）】** 经 clarify（2026-09-27）裁定：第一版不含任何 AI/LLM 调用、零对外网络请求；字段识别与文本处理全部由本地规则实现。本契约仅作为未来版本的设计预留，第一版不实现、不排期、不注册 `llm:*` 消息（见 tasks.md T049、plan.md Summary）。启用时仍须满足 spec FR-028 的条件：默认关闭、用户显式开启、仅外发最小数据、界面明示外发、核心流程永不依赖 AI。

对应 research.md R7。**默认关闭**；仅用户在 options 页配置服务商与 API Key 并开启后，由 `background.ts` 直连调用（无后端）。落点：`src/core/llm/`（第一版不创建）。

## 1. 隐私边界（硬约束）

1. 未开启（`settings.llmEnabled=false`）：**零外发**，`llm:match`/`llm:rewrite` 直接返回 `NOT_CONFIGURED`，核心流程走规则回退。
2. 开启后外发内容**仅限本文件定义的载荷**：字段标签/控件上下文/页面选项、待改写的单段短文本。
   - **不发送**：整份简历、完整资料库、字段记忆全量、页面 URL query、Cookie/登录态。
   - 发送给 LLM 的候选值只包含命中该字段语义的**单个字段值**（如判定"学历"选项时发送 `basic.degree` 的值）。
3. API Key 仅存本机 `chrome.storage.local`，UI 掩码展示，绝不写入 FillReport/日志/内容脚本。
4. 服务商端点通过 `optional_host_permissions` 按需申请（用户保存设置时的用户手势触发）。

## 2. 通用请求形态

各服务商适配层（openai / deepseek / anthropic / moonshot / zhipu）统一内部接口：

```ts
interface LlmCall {
  task: "match_fields" | "rewrite"
  system: string
  user: string              // 已构造的 prompt 文本
  model: string
  maxTokens: number         // match: 512; rewrite: 600
  timeoutMs: number         // 5000
}
```

- **失败语义**：超时/HTTP 非 200/解析失败 → 抛 `LLM_UNAVAILABLE`，调用方回退规则或转确认面板；**单次填写会话最多调用 LLM 1 次**（批量），rewrite 每次用户点击 1 次。
- **响应解析**：要求模型只输出 JSON（prompt 中以 ```json 围栏约束），解析采用宽松策略（去围栏、取首个平衡 JSON 块）；解析失败= `LLM_UNAVAILABLE`。

## 3. 任务 A：`match_fields`（模糊字段识别）

**Request payload（即外发的全部内容）**：

```json
{
  "task": "match_fields",
  "fields": [
    {
      "ref": "f1",                       // 会话内引用，页面内自增
      "label": "最高学历",                 // 归一化后的字段标签
      "context": "教育经历 / 第1行",        // 所属区块标题（可空）
      "control": "select",                // text|tel|email|select|radio|textarea
      "options": ["博士", "硕士", "本科", "大专"],   // 仅 select/radio 提供
      "current": "硕士"                   // 仅当需要比对资料库值时提供该单字段值；可空
    }
  ],
  "vocabulary": ["basic.name", "basic.phone", "basic.email", "basic.school",
                 "basic.major", "basic.degree", "basic.political_status",
                 "intent.position", "intent.city", "intent.salary",
                 "entry.education", "entry.internship", "entry.project", "entry.award",
                 "unknown"]
}
```

**Response（模型必须严格输出）**：

```json
{
  "results": [
    { "ref": "f1", "semanticFieldId": "basic.degree", "optionValue": "硕士", "confidence": 0.92, "reason": "标签与学历枚举吻合" }
  ]
}
```

- `semanticFieldId ∈ vocabulary`；无法判定时输出 `"unknown"`（低置信）。
- `optionValue`：仅 select/radio 且必须**逐字来自 options 数组**（否则视为无效，回退规则/确认面板）——防止模型编造选项。
- 客户端二次校验：`semanticFieldId` 必须在词表内、`confidence ≥ 0.85` 才采纳为可自动填写；`0.6 ≤ confidence < 0.85` 仍进确认面板（预选模型建议）；`< 0.6` 视为 unknown。**模型结果永远不能绕过确认面板直接写记忆**（记忆只来自 `user_confirm`/`user_edit`，data-model §3）。

## 4. 任务 B：`rewrite`（内容改写）

**触发**：用户在 options 页资料编辑或结果面板中主动点击「AI 改写」（`settings.llmRewriteEnabled=true`）；默认的超长处理是本地截断 + 省略号。

```json
{ "task": "rewrite", "text": "…实习经历原文…", "targetHint": "压缩到 120 字以内，保留量化成果，不新增事实" }
```

Response：`{ "text": "改写结果" }`。约束：prompt 要求"不得虚构事实/数字"；结果先展示给用户，**用户点确认才写回资料库**（符合 spec"以用户最终确认为准"）。

## 5. 降级矩阵

| 情况 | 行为 |
|---|---|
| LLM 未开启/未配 Key | 跳过任务 A/B，规则匹配 → 确定性结果；rewrite 用本地截断 |
| 超时/网络错误/配额超限 | 同上，报告中标注 `usedLlm: false` + UI 提示"LLM 不可用，已用规则结果" |
| 响应 JSON 解析失败 | 同上 |
| 模型返回非法 ID/非法选项 | 丢弃该条结果，回退规则/确认面板 |
| 会话中已调用过一次 | 不再追加调用（单会话上限，research R4） |
