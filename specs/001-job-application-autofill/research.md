# Phase 0 Research: 网申表格自动填写插件

**Feature**: 001-job-application-autofill | **Date**: 2026-09-27

技术选型的顶层约束（TypeScript / Plasmo MV3 / 原生 HTML/CSS / chrome.storage.local / 本地 pdf.js / 无后端）由用户裁定，本文件记录在此约束下的落地决策与依据。所有 Technical Context 中的未知项均已在本文或用户输入中解决，**无遗留 NEEDS CLARIFICATION**。

> **v1 范围标注（clarify 后更新）**: "直连 LLM API"经 clarify 裁定**移出第一版**（spec FR-028：第一版零对外传输、无任何网络请求）。R4 第 3 步与整个 R7 为 **v1.1 预留**，第一版字段匹配走"记忆 → 规则/词表 → 低置信转人工"两段式；简历解析格式为**文本型 PDF + 纯文本（.txt/.md）**（R6 相应扩展）。

---

## R1: Plasmo 以 vanilla 模式运行，UI 全部原生 DOM（解决"Plasmo 与无 React 的冲突"）

**Decision**: `package.json` 不声明 `react` / `vue` / `svelte` 依赖。Plasmo 检测不到框架依赖时自动进入 **vanilla 模式**：扩展页面（popup/options）的挂载模板只是 `import "__plasmo_import_module__"`（副作用导入），不注入 react-dom。因此 `src/popup.tsx`、`src/options.tsx` 是**纯 TypeScript 文件（不含 JSX、不 import React）**，自行用 `document.createElement` / `innerHTML` 构建 DOM；内容脚本 `src/contents/autofill.ts` 本身就是 vanilla（`.ts` 内容脚本不打包任何前端框架）。

**Rationale**: 已核对 Plasmo 源码确认机制存在：
- `cli/plasmo/src/features/manifest-factory/ui-library.ts`：`getUiLibrary()` 在依赖中找不到框架时 `return { name: "vanilla", ... }`；支持列表即 `["react", "svelte", "vue", "vanilla"]`。
- `cli/plasmo/templates/static/vanilla/index.ts` 内容为 `import "__plasmo_import_module__"`（无任何框架渲染代码）。
- `ui-library.ts` 的 `getUiExtMap("vanilla")` 返回 `uiExts: [".tsx", ".jsx"]`，`project-path.ts` 用它生成 `popupIndexList` / `optionsIndexList` —— 因此扩展页面入口文件名**必须是 `popup.tsx` / `options.tsx`**（即使不写 JSX），而内容脚本用 `.ts`。

**Alternatives considered**:
- *用 React 写 popup/options 再移除*: 违反用户"不引入 React/Vue"约束，且 React 会被打包进产物。
- *放弃 Plasmo，改用 CRXJS/手写 vite 配置*: 违反用户"构建：Plasmo"约束。
- *全部 UI 注入页内（只做内容脚本，无扩展页）*: 资料管理/简历导入是表单密集型长流程，放在任意第三方站点页面内体验与隔离性都差，且 pdf.js worker 在页面源下加载扩展资源受 CORS/CSP 限制（见 R6）。

**验证点**: quickstart.md S0——构建产物 `build/chrome-mv3-prod/manifest.json` 中无 `react` 相关内容、bundle 体积无框架级膨胀。

---

## R2: 三类界面分工（popup 快捷入口 / options 资料管理 / 页内面板确认与结果）

**Decision**:
1. **popup**（原生 HTML/CSS）：主按钮「一键填写」、次按钮「打开资料管理」、状态区（资料完整度）。点击「一键填写」后向当前标签页内容脚本发消息，popup 随即关闭，后续过程不依赖 popup 存活。
2. **options 页**（原生 HTML/CSS）：六类资料的完整编辑界面、简历（文本型 PDF / .txt/.md）导入与逐项确认界面、设置分区（第一版仅基础设置；服务商/API Key 等 LLM 设置为 v1.1 预留）。
3. **页内注入面板**（Shadow DOM + 原生 HTML/CSS，由 `contents/autofill.ts` 渲染）：填写结果清单（已填写/未找到/待确认/资料库缺失/需手动完成）、低置信字段确认面板（候选值点选/跳过）。面板在 popup 关闭后仍存活，保证 FR-013/FR-014 的交互闭环。

**Rationale**: spec 的核心闭环（一键填写 → 拿不准的弹出来选 → 展示结果清单）必须在页面上下文中完成；popup 会在失焦后关闭，不能承载确认流程。Shadow DOM 隔离站点 CSS（FR-011 需要在任意站点运行）。

**Alternatives considered**: *侧边栏(Side Panel)承载确认流程* —— 多一次打开动作、Plasmo sidepanel 亦属扩展页，与页内上下文（需要看到对应输入框）割裂，v1 不采用。

---

## R3: 存储方案 —— `chrome.storage.local` 单区结构化键 + 版本迁移

**Decision**: 全部数据存 `chrome.storage.local`，键空间固定为：`schemaVersion`、`profile`、`entries`、`fieldMemory`、`fillReports`（仅保留最近 20 条）、`resumeDrafts`（仅保留当前草稿）、`settings`。读写统一经 `core/storage/` 封装，写入前做结构校验；`schemaVersion` 变化时执行显式迁移函数（v1 只需 v0→v1 即框架就绪）。不存原始 PDF 文件，只存解析出的文本草稿（控制体积，quota ≈10MB 足够；如需长文本再申请 `unlimitedStorage`，v1 不申请）。

**Rationale**: 用户约束"数据存储：chrome.storage.local，不引入数据库"。以少键大对象（aggregate）而非每字段一键，减少读写往返与竞态；`fillReports` 限长防止无限增长。

**Alternatives considered**: *每条目一键（细粒度）* —— 读放大、原子性差；*IndexedDB* —— 违反约束。

**验证点**: 单元测试 `storage/migration.test.ts`（quickstart S7）。

---

## R4: 字段匹配策略 —— v1 两段式：记忆命中 → 规则/词表匹配 → 低置信转人工（LLM 辅助为 v1.1 预留）

**Decision**: 对页面上每个可填写控件依次执行：
1. **字段记忆优先**（FR-020/021）：用"规范化字段签名"（label/name/id/placeholder/选项集的归一化摘要）查 `fieldMemory`；命中且非歧义标签 → 直接取记忆值填写，不询问。歧义标签（如"备注"，FR-022）→ 即使有记忆也降级为询问。
2. **确定性匹配**（FR-012）：基于 `core/matching/` 的**中文/英文别名词表**（见 contracts/semantic-fields.md），信号包括：`<label for>`、包裹文本、`name`/`id`/`placeholder`/`aria-label`/`autocomplete`、下拉选项集合、控件类型（tel/email/url/number）。产出 `semanticFieldId + confidence`。
3. ~~**可选 LLM 辅助**~~（**v1.1 预留，第一版不实现**，spec FR-028）：第一版跳过本步，灰区字段直接进入第 4 步。
4. **转人工**（FR-013，"拿不准不乱填"）：最终置信度低于阈值、或语义冲突（同一资料源命中多个字段/预填值不一致 FR-017）→ 进入页内确认面板，附候选值。

**Rationale**: 记忆优先保证"确认过一次永久免问"（SC-003）；词表+启发式覆盖常见网申页的 80% 目标（SC-001/002）且可单测；第一版纯规则、零网络依赖（spec FR-028），覆盖率缺口由确认面板兜底（宁可问不可错填），后续再评估 LLM 辅助的增益。

**Alternatives considered**:
- *全量 LLM 判定* —— 每次填写都外发、延迟与配额不可控，违反"打开网申页一键填对"的轻量目标，且与第一版零传输裁定冲突（v1.1 亦只做灰区辅助）。
- *仅靠规则且不设确认面板* —— 同义标签/英文页变体的覆盖率不足以保证 85% 正确率，因此规则之外必须有低置信转人工（FR-013）兜底。

**验证点**: 单测 `matching/*.test.ts` 用真实网申页字段快照语料（quickstart S6）。

---

## R5: DOM 填写技术 —— 原生 setter + 事件派发；绝不触碰提交类控件

**Decision**: `core/filling/` 对不同控件采用：
- `input[type=text/tel/email/...]/textarea`: 通过 `HTMLInputElement.prototype.value` 的原生 setter 赋值，再派发 `input`、`change`、`blur`（bubbles）事件，使 React/Vue 等受控组件感知变化（本扩展自身不用框架，但**被填的站点**大量用框架）。
- `select`: 设置 `value`/选中 `option` 后派发 `change`；选项文本与目标值不完全一致时仅在高置信等价（如"硕士"/"硕士研究生"映射表）下选择，否则转确认面板。
- `radio`/`checkbox`: 值匹配时 `click()`（保持站点自身的状态同步）。
- **黑名单**：`type=password|file`、`readonly`、`disabled`、验证码/OCR 区域特征、`button[type=submit]/input[type=submit]`、含"提交/下一步/投递"文本的按钮 → 一律不操作（FR-018、SC-007），记入结果清单"需手动完成"。
- 页面预填且与资料库不一致 → 不覆盖，转确认（FR-017）。
- 多步向导：只处理"可见且可交互"的控件（FR-019）；动态字段用 `MutationObserver` + 300ms 防抖在同一次填写会话内补扫（FR-016），会话上限 3 秒（SC-006）内未出现的新字段提示用户再次点击。

**Rationale**: 原生 setter 绕过框架受控组件的"value 被框架回写"问题，是自动填充类扩展的成熟做法；黑名单从机制上保证零自动提交。

**Alternatives considered**: *`document.execCommand('insertText')`* —— 对受控输入框有效但对部分站点产生多余 undo 记录，作为 setter 失败时的回退手段保留；*模拟真实键盘逐字输入* —— 慢且易触发风控，v1 不做。

---

## R6: 简历解析 —— 文本型 PDF 与纯文本均在 options 扩展页本地解析，pdf worker 打包进扩展包

**Decision**: 解析入口在 **options 资料管理页**（扩展源、非页面上下文），第一版支持**文本型 PDF 与纯文本（.txt/.md）**（clarify 裁定）：
1. `<input type="file">` 读取用户本地文件：PDF → `pdfjs-dist` `getDocument()` 抽取逐页文本（`getTextContent`）；.txt/.md → 直接读取文本内容（不经过 pdf.js），随后走同一套抽取规则。
2. **worker 本地化**：`resources/pdf.worker.mjs` 由 postinstall 从 `node_modules/pdfjs-dist/build/pdf.worker.mjs` 复制而来，经 `package.json → manifest.web_accessible_resources` 声明触发 Plasmo 复制进产物（Plasmo 文档明确支持声明式复制资源，含 node_modules 资产）；运行时 `GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(...)` 指向本地文件。**禁止任何 CDN 引用**（MV3 扩展页 CSP `script-src 'self'` 会拦截外源 worker，且本项目要求零外部依赖加载）。
3. **扫描件判定**（spec 边界场景，仅对 PDF）：全部页抽取文本累计 < 100 个可见字符（近似无文本层）→ 判定为扫描/图片型 PDF，按 FR-009 提示"无法读取文字，请手动填写"，不写入任何草稿数据；.txt/.md 内容为空或无可识别文本时同样按 FR-009 处理。
4. **字段/经历抽取**：规则 + 词表（手机号/邮箱正则、"姓名："标签、学校/专业/学历锚点、时间段模式 `20xx.09-20xx.06`、条目标题行）→ 产出 `ResumeDraft`（含每字段 `confidence: high|low`）；low → 标记"待核对"（FR-008）。**简历解析全程不用 LLM**（第一版零外发，spec FR-028；PDF 与纯文本共用同一套抽取规则）。
5. 用户在确认界面逐项检查/修改/补空缺（FR-006/007）→ 确认后合并入 `profile`/`entries`，重复导入时弹出"覆盖/合并"选择（FR-010）。

**Rationale**: options 页是扩展源，worker 同源加载不受站点 CSP/CORS 干扰；内容脚本上下文（页面源）加载扩展 worker 会被 CORS 拒绝（已知 Chromium 行为），故解析不放内容脚本。规则抽取可单测、可解释，且满足"读不到就留空手动补"的产品语义。

**Alternatives considered**: *后台 service worker 解析* —— SW 生命周期短、`new Worker` 支持不可靠，且无 UI 可展示解析进度；*内容脚本里解析* —— worker 源限制（见上）；*OCR 扫描件* —— 超出 v1 范围，spec 已明确不做；*Word(.docx) 解析* —— clarify 裁定第一版不含（spec Assumptions）。

**验证点**: quickstart S4/S5（文本型 PDF / .txt 导入、扫描件提示）。

---

## R7: LLM 集成 —— 【v1.1 预留，第一版不实现（spec FR-028）】后台直连、默认关闭、最小外发、可降级

> **状态**: clarify 已裁定第一版不含 AI/LLM 能力，本节全部内容为 **v1.1 设计预留**，第一版不实现、不排期（见 tasks.md T049）。第一版对应行为：字段匹配走 R4 两段式（无 LLM），超长文本本地截断，零对外网络请求。

**Decision（v1.1 预留）**:
- **调用位置**：`background.ts`（service worker）用 `fetch` 直连 LLM API。内容脚本/popup 不直接持 Key，Key 只存 `chrome.storage.local` 的 `settings`（本机）。
- **触发条件**：`settings.llmEnabled === true` 且已配置 Key/服务商。**默认关闭** —— 关闭时零外发；开启后仅外发 contracts/llm-contract.md 定义的最小载荷（字段标签/上下文/选项、待改写短文本），**不发送整份简历、不发送完整资料库**（须与届时的 spec 隐私条款一致）。
- **服务商与权限**：服务商枚举（OpenAI / DeepSeek / Anthropic / Moonshot / 智谱等，v1 固定列表），端点通过 `optional_host_permissions` 声明，在用户保存设置时（用户手势）调用 `chrome.permissions.request` 按需申请，避免安装时索要全网 host 权限（安装警告最小化）。
- **任务**（仅两类，对应用户裁定）：① `match_fields` —— 灰区字段批量语义判定；② `rewrite` —— 内容改写（经历文本按目标框长度裁剪/改写，超长时默认本地截断、用户主动点"AI 改写"才外发）。
- **降级**：请求超时（5s）/失败/配额错误 → 回退规则结果或转确认面板，UI 明确标注"LLM 不可用，已用规则结果"，核心流程永不因 LLM 阻塞。

**Rationale**: 后台是唯一能安全持有密钥并统一出口的位置；默认关闭 + 最小载荷把隐私影响限制在用户主动选择的范围内。

**Alternatives considered**: *用户自建代理后端* —— 用户明确"第一版不包含任何后端"；*内容脚本直调* —— 需暴露 Key 到页面上下文（隔离世界虽安全，但页面 CORS 不允许跨域）。

**规约对齐（已解决）**: clarify 已修订 spec —— FR-024（第一版绝对零传输）、FR-028（第一版不含 AI，未来启用须默认关闭+最小外发+界面明示）、SC-008 同步更新，见 spec.md `## Clarifications` Session 2026-09-27 与 plan.md Summary。

---

## R8: 动态页面与多步表单的填写会话模型

**Decision**: 一次「一键填写」= 一个**填写会话**：`scan → match → fill → (MutationObserver 补扫) → 出报告`。会话有时限（3s 主窗口 + 最多 5s 补扫），期间出现的新字段补填；超出时限仍未出现的字段不追。多步向导只处理当前 DOM 可见控件，报告中建议"进入下一步后再次点击"。`fillReports` 记录每次会话结果（最近 20 条），既用于结果展示（FR-014）也用于用户回溯修正。

**Rationale**: 把"动态加载/分步"收敛为会话语义，避免无限监听；报告落盘让 FR-014 可测试。

---

## R9: 测试与质量策略

**Decision**:
- **单元测试（Vitest + jsdom）**：`matching`（词表/签名/记忆命中/歧义降级）、`memory`（确认写入/跳过不写/歧义仍询问/LRU 上限）、`resume`（抽取规则、置信度、扫描件判定、纯文本路径）、`storage`（迁移/校验/LRU）、`filling`（事件派发与黑名单，jsdom 内可测）。
- **契约测试**：消息协议（contracts/messages.md）。LLM 响应 JSON 解析的契约测试为 **v1.1 预留**（第一版无 LLM 调用）。
- **端到端冒烟**：`tests/smoke/` 用 Playwright 以 `--load-extension` 加载产物，对本地静态样例网申页跑"一键填写→确认→记忆复用"闭环（quickstart S1-S3）；CI 可选。
- **静态检查**: `tsc --noEmit`（strict）+ ESLint。

**Rationale**: 匹配/抽取是本项目正确性的核心，必须有可重复的语料化单测；扩展端到端成本高，仅保留覆盖核心闭环的一条冒烟链。

---

## R10: 构建、开发与产物

**Decision**: `plasmo dev` → `build/chrome-mv3-dev`（Chrome 加载已解压扩展，热更新）；`plasmo build` → `build/chrome-mv3-prod`（验收/分发，`--zip` 打包）。`package.json` 的 `manifest` 覆盖字段承载：`permissions`（`storage`、`activeTab`）、`web_accessible_resources`（pdf worker 复制）；`optional_host_permissions`（LLM 端点）为 **v1.1 预留，第一版不声明**（零外发 → 无需任何 host 权限）。不申请 `tabs`/`scripting`/`<all_urls>` host 权限（内容脚本以 `http://*/*`、`https://*/*` 静态声明，符合此类扩展的常规做法）。

**Rationale**: 与用户给定的技术约束逐条一致；权限面越小，安装警告与审核阻力越小。

**验证点**: quickstart S0。
