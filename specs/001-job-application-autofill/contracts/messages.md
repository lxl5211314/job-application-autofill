# Contract: 扩展内部消息协议

**Feature**: 001-job-application-autofill | **Date**: 2026-09-27

四个运行上下文之间的通信契约（对应 research.md R2）：`popup`、`options`、`contents/autofill`（内容脚本）、`background`（service worker）。传输层为 `chrome.runtime` / `chrome.tabs` 消息传递，统一信封：

```ts
interface Request<T = unknown> {
  type: MessageType
  payload: T
}

type Response<T = unknown> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: string; message: string } }
```

约定：
- 所有请求必须有响应（超时 10s 视为失败，调用方给出降级 UI）。
- 消息只传 JSON 可序列化数据；文件字节不走消息（options 页本地读取）。
- 内容脚本侧未知消息类型一律忽略（站点页可能注入其他消息）。

## 消息目录

| type | 方向 | payload → data | 用途 |
|------|------|----------------|------|
| `profile:get` | popup/options → background | `{}` → `Profile & { entries: ExperienceEntry[] }` | 读取资料库 |
| `profile:save` | options → background | `{ profile?, entries? }` → `{}` | 保存资料库（含 FR-003 校验，失败返回 `VALIDATION_ERROR` 与字段级错误） |
| `settings:get` / `settings:save` | options/background → | `{}` / `Settings` → `Settings` | 设置读写（Key 掩码返回） |
| `memory:lookup` | content → background | `{ signatures: string[] }` → `Array<{ signature, memory \| null }>` | 批量查字段记忆（FR-020/021） |
| `memory:write` | content → background | `Array<Pick<FieldMemory, "signature"\|"semanticFieldId"\|"ambiguous"\|"value"\|"valueKind"\|"source">>` → `{}` | 写入/更新记忆（`source` 仅允许 `user_confirm`\|`user_edit`，FR-023 由内容脚本保证跳过不写） |
| `report:save` | content → background | `FillReport` → `{}` | 保存填写结果清单（FR-014） |
| `report:list` | options → background | `{}` → `FillReport[]` | 查看最近报告 |
| `resume:confirm` | options → background | `{ draftId, importMode, fields, entries }` → `{}` | 确认导入（FR-007/010），后台执行合并写入 |
| `resume:discard` | options → background | `{ draftId }` → `{}` | 丢弃草稿 |
| `autofill:run` | popup → content（经 background 路由到当前标签页） | `{ startedAt }` → `{ sessionId }` | 触发一键填写会话（FR-011） |
| `autofill:event` | content → background → **popup 端口 `autofill-progress` 转发**（消息通道本身只应答，T071） | `{ sessionId, phase: "scanning"\|"filling"\|"done", report?: FillReport, progress?: { done, total, current?, matched?, paused? } }` → `{}` | 会话进度通知（fire-and-forget）；`progress` 为填写实时进度（done/total 跨补扫轮累计，paused=用户已在页面面板暂停） |
| `confirm:resolve` | content → background | `{ sessionId, signature, choice: { kind: "pick", value } \| { kind: "skip" }, semanticFieldId? }` → `{}` | 确认面板结果落地：`pick` → 填入 + 写记忆；`skip` → 仅填入本次、不写记忆（FR-023） |
| `llm:match` | content → background | `{ fields: LlmMatchField[] }` → `LlmMatchResult[]` | 灰区字段批量语义判定；未开启 LLM 时返回 `{ available: false }`，调用方走规则回退（research R4/R7）**【v1.1 预留，第一版不注册此消息，spec FR-028】** |
| `llm:rewrite` | options/content → background | `{ text, targetHint }` → `{ text }` | 内容改写（需 `llmRewriteEnabled`，用户主动触发）**【v1.1 预留，第一版不注册此消息，spec FR-028】** |

## 错误码

`VALIDATION_ERROR`（含 `details: Record<fieldId, string>`）、`NOT_CONFIGURED`（LLM 未开启/未配 Key）、`LLM_UNAVAILABLE`（超时/网络/配额，调用方降级）、`NO_PROFILE`（资料库为空，FR-015）、`TAB_UNAVAILABLE`（当前标签页不可注入，如 chrome:// 页面）。

## 时序（核心闭环）

```text
popup                background              content(autofill)         chrome.storage.local
  │ autofill:run        │                          │                          │
  ├────────────────────►│ (路由到当前标签页)        │                          │
  │                     ├─────────────────────────►│ scan → match             │
  │                     │                          ├─ memory:lookup ─────────►│
  │                     │◄─────────────────────────┤ (灰区字段, 可选)          │
  │                     │◄─ llm:match (未开启则跳过)│                          │
  │                     │                          │ fill (置信)              │
  │                     │                          │ 渲染结果清单+确认面板      │
  │◄─ autofill:event ───┼──────────────────────────┤                          │
  │ (popup 可能已关闭)   │                          │ 用户点选/跳过             │
  │                     │◄─ confirm:resolve ───────┼─ memory:write ──────────►│
  │                     ├─ report:save ───────────────────────────────────────►│
```
