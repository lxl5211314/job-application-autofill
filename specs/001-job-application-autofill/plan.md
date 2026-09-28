# Implementation Plan: 网申表格自动填写插件（校招海投助手）

**Branch**: `001-job-application-autofill` | **Date**: 2026-09-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-job-application-autofill/spec.md`

## Summary

为应届生海投场景构建一个 **Manifest V3 浏览器扩展**：用户通过手动填写或本地简历解析（文本型 PDF + 纯文本 .txt/.md）建立"个人资料库"（数据仅存本机 `chrome.storage.local`），在任意网申页面点击插件一键填写常见字段；高置信字段直接填入，低置信字段弹出页面内确认面板由用户点选，用户确认/显式修正过的字段形成"字段记忆"以便后续自动复用。技术栈按用户裁定执行：TypeScript + Plasmo（MV3）+ 原生 HTML/CSS（无 React/Vue）+ `chrome.storage.local`（无数据库，明文存储）+ 本地 pdf.js 解析（无后端）。

**Spec Alignment Note（已解决）**: clarify 已完成修订（见 spec.md `## Clarifications` Session 2026-09-27）——**第一版不含 AI/LLM 能力**（spec FR-028：模糊字段识别、内容改写全部由本地规则实现，绝对零传输、无任何对外网络请求）；AI/LLM（直连 API，无后端）为 **v1.1 预留**，未来启用仍须默认关闭、用户显式开启、仅外发最小数据（FR-028 后半段）。本文件与 research.md / contracts/llm-contract.md 中的 LLM 内容均按此口径标注，第一版不实现、不排期（对应 tasks.md T049）。

## Technical Context

**Language/Version**: TypeScript 5.x（strict 模式）

**Primary Dependencies**: Plasmo（浏览器扩展框架，MV3）、pdfjs-dist（本地 PDF 解析）；**不引入 React/Vue/任何 UI 框架**（Plasmo 以 vanilla 模式运行，见 research.md R1）、不引入数据库、不引入后端；**第一版无任何对外网络请求**（LLM 客户端为 v1.1 预留，届时仅用浏览器原生 `fetch`）

**Storage**: `chrome.storage.local`（单存储区，带 `schemaVersion` 的结构化键；无数据库）

**Testing**: Vitest（单元测试：字段匹配、字段记忆、简历解析、存储迁移）+ 手动/Playwright 冒烟（扩展加载后的端到端填写流程，见 quickstart.md）

**Target Platform**: 桌面 Chromium 系浏览器（Chrome / Edge），Manifest V3

**Project Type**: 浏览器扩展（单一项目，无前后端分离）

**Performance Goals**: 一键填写反馈 ≤ 3 秒（SC-006）；常见字段正确率 ≥ 85%、低置信误填 0%（SC-002）；导入建档 ≤ 3 分钟（SC-005）

**Constraints**: 无后端服务；UI 仅原生 HTML/CSS；个人数据仅存本机（明文，无主口令）；第一版零对外传输、不含 AI/LLM 调用（spec FR-028，AI 为 v1.1 预留）；不自动提交表单、不处理验证码/扫码/附件上传；字段记忆本机持久化（约 2000 条上限，LRU 淘汰）；页面修正仅显式「记住本次修改」才入记忆（FR-020）

**Scale/Scope**: 单用户本机使用；资料库为单例档案 + 每类经历各数十条目以内；v1 覆盖中文网申页面为主、英文常见字段尽力识别；5 个用户故事（P1 一键填写为核心）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 当前为**未填写的模板**（全部为占位符，无已批准的项目原则、无强制约束条款），因此不存在可执行的宪法 gate。按模板示例中倡导的默认准则（简单性 / YAGNI / 单项目优先）自查：

| 默认准则 | 评估 | 结果 |
|----------|------|------|
| 简单性：避免过度抽象 | 单项目、分层目录（model/storage/matching/filling/resume/ui），无仓库模式、无多余服务层 | PASS |
| 无未论证的复杂度 | 无多项目拆分、无后端、无消息队列/数据库、无 AI 集成（v1.1 预留） | PASS |
| 本地优先 / 隐私 | 数据仅存 `chrome.storage.local`（明文）；第一版无任何对外网络请求（AI 移出 v1，spec FR-028） | PASS（spec 已于 clarify 修订，见 Summary） |

**Gate 结论：PASS**（Phase 0 前）。Phase 1 设计后复检：结构仍为单项目、无新增基础设施，**PASS**。无违规项需写入 Complexity Tracking。

## Project Structure

### Documentation (this feature)

```text
specs/001-job-application-autofill/
├── plan.md              # 本文件（/speckit.plan 输出）
├── research.md          # Phase 0 输出：技术决策与依据
├── data-model.md        # Phase 1 输出：数据模型与状态流转
├── quickstart.md        # Phase 1 输出：运行与验证指南
├── contracts/           # Phase 1 输出：内部接口契约
│   ├── messages.md          # 扩展内部消息协议（popup/options/内容脚本/后台）
│   ├── semantic-fields.md   # 字段语义目录（匹配与记忆的统一词表）
│   └── llm-contract.md      # LLM 调用契约（v1.1 预留，第一版不实现，spec FR-028）
├── checklists/
│   └── requirements.md  # 规约质量检查清单（/speckit.specify 已生成）
└── tasks.md             # Phase 2 输出（/speckit.tasks 生成，本命令不创建）
```

### Source Code (repository root)

```text
src/
├── popup.tsx                 # 工具栏弹窗入口（vanilla TS，无 JSX/React：一键填写、打开资料管理）
├── options.tsx               # 资料管理页入口（vanilla TS：六类资料编辑 + 简历导入确认 + 设置）
├── background.ts             # MV3 service worker：消息路由、标签页定位（LLM 调用为 v1.1 预留）
├── contents/
│   └── autofill.ts           # 内容脚本（vanilla TS）：字段扫描、填写、注入确认面板/结果面板
├── core/
│   ├── model/                # 实体类型、字段校验（FR-003）、状态定义
│   ├── storage/              # chrome.storage.local 读写封装 + schemaVersion 迁移
│   ├── matching/             # 字段匹配：词表/启发式 + 记忆命中（LLM 辅助为 v1.1 预留，第一版纯规则）
│   ├── filling/              # DOM 填写（原生 setter + 事件派发；text/textarea/select/radio/checkbox）
│   ├── resume/               # pdf.js 文本抽取、字段/经历抽取规则、置信度、扫描件判定（PDF + .txt/.md）
│   ├── llm/                  # 【v1.1 预留，第一版不创建】LLM 客户端（字段识别/内容改写）
│   └── ui/                   # 原生 DOM 构建工具与共享交互逻辑（面板、清单、表单渲染）
├── styles/                   # 原生 CSS（popup / options / 页内面板三套样式）
assets/
└── icon.png                  # 扩展图标（Plasmo 自动生成各尺寸）
resources/
└── pdf.worker.mjs            # pdf.js worker 本地副本（postinstall 从 pdfjs-dist 复制，禁止 CDN）

tests/
├── unit/                     # Vitest：matching / memory / resume / storage 迁移
└── smoke/                    # 扩展加载冒烟脚本与用例（可选，Playwright）

package.json                  # Plasmo 入口配置 + manifest 覆盖（权限、WAR 资源复制）
```

**Structure Decision**: 采用 Plasmo 的 `src/` 单项目结构。UI 三入口（`popup.tsx`、`options.tsx`、`contents/autofill.ts`）均为 **vanilla TypeScript**：package.json 不含 react/vue/svelte 依赖时 Plasmo 自动进入 vanilla 模式，扩展页面挂载模板仅为副作用 import（见 research.md R1，已核对 Plasmo 源码）。业务逻辑集中在 `core/` 下按领域分层，便于 Vitest 单测复用；`resources/pdf.worker.mjs` 通过 postinstall 本地化，配合 manifest 覆盖触发 Plasmo 复制进包（见 research.md R6）。

## Complexity Tracking

无违例：Constitution 未定义强制条款，且设计未引入超出单项目范围的复杂度，故本表为空。
