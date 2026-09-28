# Quickstart & 验证指南：网申表格自动填写插件

**Feature**: 001-job-application-autofill | **Date**: 2026-09-27

本文件是"跑起来并验证功能"的运行指南，不含实现细节（实现归 `/speckit.tasks` 与实现阶段）。契约与模型细节见 [contracts/](./contracts/) 与 [data-model.md](./data-model.md)。

## 1. 前置条件

- Node.js ≥ 18、npm（或 pnpm）
- Chrome 或 Edge（Chromium ≥ 110）
- ~~（可选）LLM API Key~~ —— **第一版不含 AI 功能（spec FR-028），S9 整体为 v1.1 预留，无需配置**（research R7）

## 2. 安装与运行

```bash
npm install          # postinstall 会复制 pdf.js worker 到 resources/（research R6）
npm run dev          # 开发构建 → build/chrome-mv3-dev（热更新）
npm run build        # 生产构建 → build/chrome-mv3-prod
npm test             # Vitest 单元测试
npx tsc --noEmit     # 严格类型检查
```

**加载扩展**：浏览器 → 扩展管理 → 开发者模式 →「加载已解压的扩展程序」→ 选择 `build/chrome-mv3-dev`（验证/分发用 `build/chrome-mv3-prod`）。

## 3. 端到端验证场景

| # | 场景 | 步骤 | 预期结果 | 覆盖 |
|---|------|------|----------|------|
| S0 | 产物体检 | 构建后检查 `manifest.json` 与 bundle | 无 React/Vue 依赖产物；权限仅 `storage`/`activeTab` + optional 端点；`pdf.worker.mjs` 在包内；无远程脚本引用 | R1/R10, FR-024 |
| S1 | 手动建档 → 一键填写 | options 页填全六类资料保存 → 打开本地样例网申页 `tests/fixtures/sample-form.html` → 点 popup「一键填写」 | 3 秒内常见字段（姓名/手机/邮箱/学校/专业/学历/政治面貌/意向三项）全部正确填入；结果清单展示 filled/not_found/missing 分类 | FR-001~004, FR-011/012/014, SC-001/006 |
| S2 | 低置信不乱填 | 在样例页放置选项措辞不一致的"学历"下拉 | 该字段不被自动填充，出现在页内确认面板；点选后填入并生效 | FR-013, SC-002 |
| S3 | 记忆复用 | 完成 S2 的确认 → 刷新页面再执行一键填写 → 换另一个样例页再执行 | 已确认字段直接自动填写，不再弹确认；"跳过"过的字段仍会询问 | FR-020/021/023, SC-003 |
| S4 | 文本型 PDF 导入 | options 页导入 `tests/fixtures/resume-text.pdf` | 姓名/手机/邮箱/学校/专业/学历及经历条目被预填；缺失字段留空标"需补充"；低置信项标"待核对"；确认后写入资料库 | FR-005~008, SC-004 |
| S5 | 扫描件 PDF | 导入 `tests/fixtures/resume-scan.pdf`（无文本层） | 明确提示"无法读取文字，请手动填写"，不产生草稿/半截数据 | FR-009, spec 边界场景 |
| S6 | 单元测试语料 | `npm test` | matching（词表/签名/歧义降级/记忆命中）、resume（抽取/扫描判定）、storage（迁移/LRU）、filling（事件+黑名单）全部通过 | R9, FR-012/020 |
| S7 | 存储迁移与限额 | 单测写入 >2000 条记忆、>20 条报告后读取 | LRU 淘汰生效、schemaVersion 迁移函数可执行 | R3 |
| S8 | 安全边界 | 在样例页放置提交按钮、密码框、文件上传、"我已阅读并同意"、验证码占位 | 一键填写不触碰上述控件；结果清单中列为"需手动完成"；页面预填且与资料库不一致的字段不被覆盖而进确认 | FR-017/018/019, SC-007 |
| S9 | LLM 开/关对照 **【v1.1 预留，第一版跳过（spec FR-028）】** | ① 不配置 LLM 跑 S1/S2；② 配置 Key 开启后再跑灰区字段 | ① 全程零外发（可抓 background 网络请求为空），流程可用；② 灰区字段由 LLM 建议、仍过确认面板；断网时自动回退规则并提示 | R4/R7, llm-contract §5 |
| S10 | 隐私核查 | 全流程后检查 | 个人数据仅存在于本机 `chrome.storage.local`；FillReport 中手机号/邮箱为掩码；Key 不出现在任何日志/报告 | FR-024/025, SC-008 |

## 4. 样例夹具

`tests/fixtures/` 需包含：`sample-form.html`（覆盖 S1/S2/S8 所需控件类型的静态网申页）、`sample-form-step2.html`（动态追加字段，验证 FR-016）、`resume-text.pdf`、`resume-scan.pdf`。夹具为本地静态文件，不依赖外部站点。

## 5. 验收判定

- S0–S8、S10 全部通过 → 核心流程（spec P1–P4）可进入 `/speckit.tasks` 排期实现。
- S9 为 **v1.1 预留**（spec FR-028，第一版不含 AI）：第一版验证以 S0–S8 + S10 为准；S9 留待未来版本启用 AI 时使用，届时 LLM 关闭态必须通过（隐私底线），开启态失败时只降级不阻塞。
- 量化指标对照：SC-001/002（S1/S2）、SC-003（S3）、SC-004（S4）、SC-005（S1/S4 计时）、SC-006（S1 计时）、SC-007（S8）、SC-008（S10）、SC-009（发布后试用调研，非本阶段）。
