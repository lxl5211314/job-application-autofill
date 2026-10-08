# Tasks: 网申表格自动填写插件（校招海投助手）

**Input**: Design documents from `/specs/001-job-application-autofill/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/, quickstart.md

**Tests**: 包含单元测试任务——依据 plan.md R9 的测试策略与 quickstart.md 的验证场景（matching/resume/memory/storage/filling 为正确性核心）。端到端用 quickstart 的手动/冒烟场景在 Polish 阶段验收。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

**Scope note（来自 clarify）**: 第一版不含 AI/LLM 调用（spec FR-028），**不生成任何 LLM 相关实现任务**；`contracts/llm-contract.md` 与 plan/research 中的 LLM 内容为 v1.1 预留，需在 Polish 阶段标注。第一版导入格式=文本型 PDF + 纯文本（.txt/.md）；页面修正记忆须显式「记住本次修改」（FR-020）；本地明文存储、绝对零传输。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root（Plasmo `src/` 结构，见 plan.md Project Structure）

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 项目初始化与构建骨架（Plasmo vanilla 模式，无 React/Vue）

- [X] T001 Scaffold Plasmo vanilla project in repository root: `package.json`（依赖 plasmo、typescript、pdfjs-dist、vitest、eslint；**不含 react/vue/svelte**，research R1）、`tsconfig.json`（strict）、`assets/icon.png`、`.gitignore`
- [X] T002 [P] Configure ESLint + Prettier + Vitest in `eslint.config.js`, `.prettierrc.cjs`, `vitest.config.ts`（environment: jsdom, include `tests/unit/**`）
- [X] T003 [P] Add postinstall worker-copy script `scripts/copy-pdf-worker.mjs`（从 `node_modules/pdfjs-dist/build/pdf.worker.mjs` 复制到 `resources/pdf.worker.mjs`，research R6）
- [X] T004 [P] Base manifest overrides in `package.json`: `permissions: ["storage","activeTab"]`、`optional_host_permissions`（暂不启用，v1.1 预留）、`web_accessible_resources: ["resources/pdf.worker.mjs"]`、content script `matches: ["http://*/*","https://*/*"]`（research R10）——实现注记：content script 声明落在 T013 的 `PlasmoCSConfig`（package.json 无法引用未构建 bundle，效果等价）；`optional_host_permissions` 按 research R10「第一版不声明」省略
- [X] T005 [P] Create style skeletons `src/styles/popup.css`, `src/styles/options.css`, `src/styles/panel.css`（原生 CSS，无框架）

**Checkpoint**: `npm run dev` 产出 `build/chrome-mv3-dev` 可被浏览器加载（空扩展）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有用户故事共用的模型、存储、协议与骨架——**必须先于任何 US 完成**

- [X] T006 Create entity types per data-model.md §1-§6 in `src/core/model/types.ts`: `Profile`, `ProfileField`, `ExperienceEntry`, `FieldMemory`, `FillReport`, `ResumeDraft`, `Settings`（含 `FieldState = "confirmed" | "needs_review"`、`FieldSource = "manual" | "resume" | "llm_rewrite"`）
- [X] T007 [P] Implement field validation per data-model §1 in `src/core/model/validation.ts`——逐条引用约束：手机号 `^1[3-9]\d{9}$`（归一化后校验）、邮箱 `^[^\s@]+@[^\s@]+\.[^\s@]+$`、name 非空且 ≤60 字符、单文本字段 ≤500 字符、`description ≤ 2000 字符`、`start ≤ end`（均有值时）、返回 `Record<fieldId, string>` 字段级错误（FR-003）
- [X] T008 Create storage layer in `src/core/storage/store.ts`: `chrome.storage.local` 统一读写、`schemaVersion`（当前 1）迁移函数、`fieldMemory` 上限 2000 条 LRU、`fillReports` 上限 20 条、`resumeDrafts` 单例（data-model §0, research R3）
- [X] T009 [P] Create semantic vocabulary with Chinese/English aliases in `src/core/matching/vocabulary.ts` per contracts/semantic-fields.md §1-§4（含 §2 经历区块信号、§3 非填写区黑名单、§4 歧义标签列表）
- [X] T010 [P] Implement field signature generator in `src/core/matching/signature.ts` per contracts/semantic-fields.md §5 公式（norm(label) + controlKind + norm(nameIdPlaceholder) + optionSetFingerprint）
- [X] T011 Create messaging layer in `src/core/messaging.ts` per contracts/messages.md：`Request/Response` 信封、14 类消息类型、错误码 `VALIDATION_ERROR`（含 details）/`NOT_CONFIGURED`/`NO_PROFILE`/`TAB_UNAVAILABLE`、10s 超时
- [X] T012 Create background service worker router in `src/background.ts` registering `profile:*`/`settings:*`/`memory:*`/`report:*`/`confirm:resolve`/`autofill:run` handlers（`llm:*` 不注册，FR-028）
- [X] T013 Create content script skeleton in `src/contents/autofill.ts`（PlasmoCSConfig matches http/https、`run_at: document_idle`）+ 消息监听占位
- [X] T014 Create popup shell in `src/popup.tsx`（vanilla TS，无 JSX）：「一键填写」「打开资料管理」按钮 + 状态区，引用 `src/styles/popup.css`
- [X] T015 Create options page shell in `src/options.tsx`（vanilla TS）：六分区导航（基本信息/求职意向/教育/实习/项目/获奖/设置），引用 `src/styles/options.css`
- [X] T016 [P] Create vanilla DOM utilities in `src/core/ui/dom.ts` + Shadow-DOM panel host `src/core/ui/panel-host.ts`（挂载/卸载页内面板，research R2）

**Checkpoint**: Foundation ready —— 各用户故事可独立开工

---

## Phase 3: User Story 1 - 打开网申页，一键填写常见字段 (Priority: P1) — MVP

**Goal**: 已建档用户在任意网申页点击插件按钮，常见字段（姓名/手机/邮箱/学校/专业/学历/政治面貌/意向三项）一次操作内自动填入，并展示结果清单

**Independent Test**: 用 `tests/fixtures/profile.fixture.json` 注入最小资料库 → 打开 `tests/fixtures/sample-form.html` → 点击 popup「一键填写」→ 3 秒内常见字段正确填入、结果清单分类显示（quickstart S1）

### Tests for User Story 1

- [X] T017 [P] [US1] Unit tests for deterministic matcher in `tests/unit/matching.test.ts`（别名命中、控件类型吻合、灰/低置信分档、`unknown` 归类；语料来自 `tests/fixtures/sample-form.html` 字段快照）
- [X] T018 [P] [US1] Unit tests for filler in `tests/unit/filling.test.ts`（原生 setter+`input/change/blur` 事件派发、select/radio/checkbox、黑名单：`type=password|file`、readonly、submit 类按钮、验证码区——FR-018）
- [X] T019 [P] [US1] Create fixture pages `tests/fixtures/sample-form.html`（覆盖 text/tel/email/select/radio/textarea + 预填字段 + 提交按钮/密码框/上传/验证码占位）与 `tests/fixtures/sample-form-step2.html`（脚本动态追加字段，FR-016）

### Implementation for User Story 1

- [X] T020 [P] [US1] Create DOM field scanner in `src/core/matching/scan.ts`: 枚举可填写控件，抽取 label（`<label for>`/包裹文本/`aria-label`/`placeholder`/`name`/`id`）与所属区块标题，过滤 disabled/readonly（FR-019 可见可交互判定）
- [X] T021 [US1] Implement deterministic matcher in `src/core/matching/match.ts`: 词表+信号→`semanticFieldId`+置信分档（high/gray/low），覆盖 FR-012 十个标量字段与经历区块；产出 `not_found`/`missing_in_profile` 判定（FR-014/015）
- [X] T022 [US1] Implement filler in `src/core/filling/fill.ts`: 原生 value setter + 事件派发（受控组件兼容）、select 选项等价映射（本科/学士↔Bachelor 等）、radio/checkbox `click()`、黑名单跳过并标 `manual_required`（FR-018）、页面预填不一致时**不覆盖**并标 `needs_confirm`（FR-017，面板交互在 US3 实现）
- [X] T023 [US1] Implement fill session orchestrator in `src/contents/autofill.ts`: scan→match→fill→MutationObserver 补扫（300ms 防抖，主窗口 3s+补扫 5s，research R5/R8）→ 生成 FillReport
- [X] T024 [US1] Render result panel in `src/core/ui/result-panel.ts`: 按 `filled / not_found / missing_in_profile / manual_required / needs_confirm` 分类展示（FR-014），手机号/邮箱掩码显示（data-model §4）
- [X] T025 [US1] Wire popup trigger in `src/popup.tsx` + `src/background.ts`: 「一键填写」→ `autofill:run` 路由到当前标签页；`NO_PROFILE` 引导去资料页（FR-015）；`TAB_UNAVAILABLE`（chrome:// 页）提示
- [X] T026 [US1] Create profile test fixture `tests/fixtures/profile.fixture.json` + loader helper `tests/unit/helpers/seed-profile.ts`（US1 独立验收用，不依赖 US2 的 UI）

**Checkpoint**: User Story 1 fully functional and testable independently（MVP）

---

## Phase 4: User Story 2 - 手动录入与维护个人资料库 (Priority: P2)

**Goal**: 用户在资料管理页按六类录入/编辑/删除资料，保存即生效、重开不丢、格式错误有字段级提示

**Independent Test**: 仅用资料页手动录入六类信息 → 保存 → 重开页面数据完整 → 修改手机号后一键填写取新值（quickstart S1 前半）

### Tests for User Story 2

- [X] T027 [P] [US2] Unit tests for validation rules in `tests/unit/validation.test.ts`（手机号/邮箱/长度/`start ≤ end` 各边界，断言字段级错误信息）

### Implementation for User Story 2

- [X] T028 [P] [US2] Build basic-info & job-intent forms in `src/core/ui/profile-forms.ts`（7+3 字段、FR-003 实时校验提示、`state` 展示：`needs_review` 标"待核对"）
- [X] T029 [P] [US2] Build experience entry lists in `src/core/ui/entry-lists.ts`：四类条目（education/internship/project/award）的新增/编辑/删除/排序，`title` 必填校验（data-model §2, FR-002）
- [X] T030 [US2] Wire save flow in `src/options.tsx`: `profile:save` 消息 → 校验失败返回 `VALIDATION_ERROR` 逐字段高亮（FR-003）；成功后资料完整度指示更新
- [X] T031 [US2] Implement persistence round-trip in `src/core/storage/store.ts` + 验证：关闭/重开 options 页数据完整显示（FR-004）

**Checkpoint**: US1 + US2 both work independently

---

## Phase 5: User Story 3 - 拿不准的字段弹窗让用户自己选 (Priority: P3)

**Goal**: 低置信/冲突/歧义字段绝不自动填写，转入页内确认面板由用户点选或跳过，选择即时生效

**Independent Test**: 在样例页放置选项措辞不一致的"学历"下拉 → 一键填写 → 该字段未被填充且出现在确认面板 → 点选后立即填入（quickstart S2）

### Tests for User Story 3

- [x] T032 [P] [US3] Unit tests for confirm routing in `tests/unit/confirm-routing.test.ts`：low/gray/conflict/歧义 → 一律 `needs_confirm` 且**不**自动填；候选值逐字来自页面选项（FR-013）

### Implementation for User Story 3

- [x] T033 [US3] Build confirm panel component in `src/core/ui/confirm-panel.ts`: 候选值列表、点选、跳过、歧义说明（contracts/semantic-fields.md §4 歧义标签），Shadow DOM 挂载于 `src/core/ui/panel-host.ts`
- [x] T034 [US3] Route gray/conflict cases to panel in `src/contents/autofill.ts`: matcher low 档、页面预填与资料库不一致（FR-017）、选项措辞不一致的 select；仅在用户点选后写入页面
- [x] T035 [US3] Implement `confirm:resolve` handling in `src/background.ts` + `src/core/messaging.ts`：`pick` → 回填页面并返回成功、`skip` → 保持页面原状；同步更新 FillReport 条目状态（FR-014）
- [x] T036 [US3] Handle no-candidate ambiguity: 面板提供"跳过"并可编辑自定义值后确认（FR-013 第 3 条）

**Checkpoint**: US1-US3 independently functional

---

## Phase 6: User Story 4 - 记住用户手动补过/纠正过的字段 (Priority: P4)

**Goal**: 确认面板的选择与显式点击「记住本次修改」的修正被永久记忆，后续同类字段直接自动填、不再询问；跳过与临时改动不产生记忆

**Independent Test**: 先在某页确认"期望薪资=15-20K"→ 打开另一个含同语义字段的页面一键填写 → 直接填入且不弹确认；未点「记住本次修改」的临时改动在下一页不生效（quickstart S3）

### Tests for User Story 4

- [x] T037 [P] [US4] Unit tests for memory behavior in `tests/unit/memory.test.ts`：记忆命中跳过询问（FR-021）、歧义标签即使有记忆仍询问（FR-022）、`skip` 不写入（FR-023）、无「记住本次修改」的页面改动不写入（FR-020）、LRU 2000 上限淘汰（data-model §3）

### Implementation for User Story 4

- [x] T038 [US4] Implement memory handlers in `src/background.ts`: `memory:lookup`（批量签名查询）与 `memory:write`（仅允许 `source: "user_confirm" | "user_edit"`；更新 `useCount`/`lastUsedAt`）per data-model §3
- [x] T039 [US4] Add memory-first step in `src/core/matching/match.ts`: 签名命中且非歧义 → high 档直填不询问（FR-021）；歧义签名 → 降级确认面板（FR-022）
- [x] T040 [US4] Wire `pick` → 自动写记忆 in `src/contents/autofill.ts`（confirm:resolve 成功回调后 `memory:write`, source=user_confirm）
- [x] T041 [US4] Add 「记住本次修改」 explicit trigger: 在结果面板已填条目上提供按钮（`src/core/ui/result-panel.ts`），点击后读取页面当前值写入记忆（source=user_edit, FR-020）；未点击不监听不写入

**Checkpoint**: US1-US4 independently functional，"越用越快"闭环成立

---

## Phase 7: User Story 5 - 导入现有简历自动生成资料库 (Priority: P5)

**Goal**: 用户选择文本型 PDF 或 .txt/.md 简历 → 本地解析预填草稿 → 逐项检查/补空/确认 → 覆盖或合并写入资料库；扫描件明确报错不产生脏数据

**Independent Test**: 导入 `tests/fixtures/resume-text.pdf` → 核心字段+经历条目预填、缺失留空、低置信标"待核对" → 确认后可直接用于一键填写；导入 `tests/fixtures/resume-scan.pdf` → 提示"无法读取文字"且无草稿写入（quickstart S4/S5）

### Tests for User Story 5

- [x] T042 [P] [US5] Create resume fixtures `tests/fixtures/resume-text.pdf`, `tests/fixtures/resume-scan.pdf`, `tests/fixtures/resume.txt` + unit tests in `tests/unit/resume.test.ts`：抽取规则（手机/邮箱正则、"姓名："锚点、学校/专业/学历锚点、时间段 `20xx.09-20xx.06`）、置信度 high/low、扫描件判定（全页可见文本 < 100 字符 → 报错且不建草稿, FR-009）

### Implementation for User Story 5

- [x] T043 [P] [US5] Implement plain-text parser in `src/core/resume/text.ts`（.txt/.md 全文抽取后走统一抽取规则）
- [x] T044 [US5] Integrate pdf.js in options page `src/core/resume/pdf.ts`: `GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("resources/pdf.worker.mjs")` 本地 worker（FR-024 零外发、research R6）、`getTextContent` 逐页拼接、扫描件判定
- [x] T045 [US5] Implement extraction rules engine in `src/core/resume/extract.ts`: 字段与四类经历抽取 → `ResumeDraft.fields`（`confidence: high|low`，low = 待核对 FR-008）、读不到的字段 `extracted: false` 留空（FR-006）
- [x] T046 [US5] Build draft review UI in `src/core/ui/draft-review.ts`: 逐字段检查/修改/补空缺、低置信醒目标记、确认与丢弃按钮（FR-007, data-model §5）
- [x] T047 [US5] Implement import merge flow in `src/options.tsx` + `src/background.ts`: 已有资料时强制选择 `importMode: "overwrite" | "merge"`（merge 保留已确认手动值, FR-010）→ `resume:confirm` 写入 profile/entries（未编辑 high→confirmed、未编辑 low→needs_review、未填不写入）
- [x] T048 [US5] Wire file input UX in `src/options.tsx`: 文件类型校验（仅 PDF/.txt/.md，Word/图片提示不在范围）、解析进度与错误提示（FR-009 文案）

**Checkpoint**: All 5 user stories independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事收尾、隐私与性能验收、文档同步

- [x] T049 [P] Resolve plan-clarify drift: 在 `contracts/llm-contract.md` 顶部、`plan.md` Summary 与 `research.md` R7 标注"LLM/AI 为 v1.1 预留，第一版不实现（spec FR-028）"，移除 Spec Alignment Note 的"待修订"状态（spec 已修订）
- [x] T050 Privacy & zero-transmission audit across `src/` + `package.json`: 检索 `fetch(`、`XMLHttpRequest`、`new Image(`、`navigator.sendBeacon` 确认无对外网络请求（FR-024/SC-008）；`src/core/ui/result-panel.ts` 掩码复核；无 Key 存储（quickstart S0/S10）
- [x] T051 Run `quickstart.md` validation S1-S8 end-to-end on `build/chrome-mv3-dev`, fix gaps（动态补扫 FR-016、多步可见字段 FR-019、预填不冲突 FR-017）
- [x] T052 [P] Run `npx tsc --noEmit` + `npm run lint` clean; `npm test` all green
- [x] T053 [P] Performance check SC-006 on `src/contents/autofill.ts` fill session: 一键填写在样例页 ≤3 秒完成反馈；超时则调优防抖与批量消息（research R8）
- [x] T054 [P] Developer docs in `README.md`: `npm run dev/build`、加载已解压扩展步骤、夹具与验收指引（指向 `specs/001-job-application-autofill/quickstart.md`）
- [x] T055 Real-resume hardening in `src/core/resume/extract.ts` + `tests/unit/resume-exotic.test.ts`: 归一化剔除控制字符/全角空格/长破折号、康熙部首与兼容字形归一、无「姓名：」标签的首行姓名回退、日期残骸走无日期条目回退
- [x] T056 Broken-ToUnicode digit repair in `src/core/resume/pdf.ts`: `getTextContent` 发现 NUL → 关归一化重取 + `getOperatorList()` 锁步对齐（合成空格不消费字形，desync 必须为 0），数字按 `digit = cid - base` 还原（base 由坏字形 cid 跨度推导，候选按合法日期数打分），对齐失败/cid 越界/无合法日期整页回退原文本（宁缺勿错）；夹具 `tests/fixtures/resume-broken.pdf` + `resume.test.ts` 回归
- [x] T057 Readonly-field reporting in `src/core/matching/scan.ts` + `match.ts`: 新增 `scanReadonlyFields`（FR-019 不变——`scanDocument` 仍排除只读，不参与填写），`buildFillPlan` 对匹配到资料字段的只读控件上报 `manual`（reason=「只读控件（需在页面弹层中选择）」），匹配不上的不上报；签名加 `|ro` 后缀防撞——避免只读弹层控件静默消失被误报成「未找到」（`matching.test.ts` T057 块）
- [x] T058 P1 matching-noise reduction in `src/core/matching/{vocabulary,scan,match}.ts`（借鉴成熟插件调研，确认面板 73 项 → 个位数）: ① name/id 信号改词边界匹配 + 控件类型过滤（`hasAppliedOtherJob` 不再命中岗位、`isDomesticMobile` 不再命中手机号）；② label 部分包含命中同样要求控件吻合；③ checkbox 不作标量填写目标且勾选态永不进 FR-017 冲突确认、radio 冲突按可见文案比较（value=on/1 不误报）；④ 仅 name/id 弱信号 → `action:"skip"`（报告归「未找到」+原因，不进确认面板）；⑤ 接入 HTML `autocomplete` 属性最高优先信号（`AUTOCOMPLETE_MAP`：name/email/tel → 白名单直填 high）；`confirm-routing.test.ts` + `matching.test.ts` T058 块（123 tests）
- [x] T059 P2 confirm-panel redesign in `src/core/ui/confirm-panel.ts`: 卡片标题改可读中文（`planReportLabel` 语义字段名优先 + 「页面字段：」副行降级展示原始标识）、按原因分组（歧义/页面冲突/选项措辞/待核对/其他，各带计数）、头部追加本次统计行（已填/未找到/需人工）
- [x] T060 not-found 中文化 in `src/contents/autofill.ts`: `collectReportItems` 的 `not_found` 条目 `label` 从原始 ID 改 `semanticFieldLabel(id)`（`basic.school` → 学校），结果面板不再暴露英文内部 ID
- [x] T061 split-name fill in `src/core/matching/match.ts` + `vocabulary.ts`: 词表 `basic.name` 增单字别名「姓/名」（仅精确命中，部分包含仍要求 ≥2 字防误伤）与 surname/first name 等英文；`splitNameValue` 按页面标签把资料库整名拆到 姓/名 两个输入框（复姓表：欧阳/司马…2 字；英文名 按空格姓取末词），合并「姓名」单字段不拆，记忆值优先；标签与 name/id **都**参与拆分判断（「Last Name/First Name」仅标签、name 为空也拆，「Full Name」整名不拆）（`matching.test.ts` T061 块，含英文标签用例）
- [x] T062 readonly-weak suppression in `src/core/matching/match.ts`: 只读上报再加 `!roMatch.weak` 条件——仅 name/id 弱信号的只读控件（「我投递错了项目，可以更换吗？」类帮助文本）不再幻影进「需人工」
- [x] T063 new scalar fields `basic.gender` + `basic.birthday`（校招个人信息区标配，原先不在 10 字段里导致整块静默）: `types.ts` BASIC_FIELD_IDS 扩到 9（表单/草稿/校验链路全泛型自动跟随）、词表 + `AUTOCOMPLETE_MAP`(sex/bday) + 性别等价表（男/男性/male）、`validation.ts`（男/女枚举 + 宽松日期）、简历锚点「性别：」「出生年月：」+ 归一化（Male→男，映射不上不抽取）、只读出生日期弹层走 T057 上报；`matching.test.ts`/`validation.test.ts`/`resume.test.ts` 新增 10 用例
- [x] T064 scroll-triggered rescan in `src/contents/autofill.ts`: `observeRescan` 增 capture 阶段 scroll 监听（scroll 不冒泡）与 mutation 同防抖复扫——分步/懒加载表单（学历、求职意向常滚动到才渲染）在补扫窗口内滚动即可补填（预算仍受 3s+5s 硬截止约束）
- [x] T065 widget 扫描与日期归一化 in `src/core/matching/scan.ts` + `src/core/model/date.ts`（参考牛客「一键填写」在北森/蒙牛站点的日历与自定义下拉交互，只借交互不抄代码）: ① `ScannedField.widget?: "combobox"|"date"`——只读输入按日期语义（日期/出生/…/date/birth）或下拉语义（请选择/aria-haspopup/…）判定，无迹象的只读仍走 T057 manual；② `scanDocument` 增扫 `div[role=combobox]`/`[aria-haspopup=listbox]` 自定义触发器（label[for]→包裹 label→aria-labelledby→placeholder 取标签，占位文案不算预填）；③ `date.ts` 叶子模块：`dateParts/toIsoDate`（1999年9月 → 1999-09-01 缺日补 1）与 `dateEquivalent`（格式无关、缺日宽恕），接入 match/fill 的 `textEquivalent`——页面预填 1999/9/1 不再误报冲突；④ `fillText` 对 `input[type=date]` 归一化 ISO 写入
- [x] T066 combobox 驱动 in `src/core/filling/widgets.ts` + `match.ts`/`autofill.ts`: `fillWidgetField`——点击触发器（含箭头兜底）→ 轮询找 listbox（role=listbox/AntD/Element 类名 + 隐藏类名过滤）→ `findEquivalentOption` 等价匹配 + 互含兜底（硕士研究生↔硕士）→ 未命中且可搜索则键入过滤重匹配 → mousedown/click 点选 → 回读触发器/弹层关闭校验；计划侧：readonly+widget 走正常标量流程（`drivable`），widget 字段跳过扫描期选项等价检查（选项在弹层里，点选时才比对）；`executeFills` 异步化并路由 widget，失败（reason="widget"）→ 「需人工」带原因「控件交互失败」；确认面板点选同样走驱动；记忆查询纳入 readonly+widget 签名
- [x] T067 date 驱动（日历面板）in `src/core/filling/widgets.ts`: 等价回显直接成功（不点开面板）→ 点击输入/日历图标打开 → 面板选择器（AntD/Element/layDate/通用 calendar 类名）→ 定位日格：`td[title=ISO]`/`data-date`/`data-time` 时间戳/当前月日号（排除 prev/next 月）→ 未中则面板头部原生年月下拉 → 再未中 prev/next 箭头翻页（有界 400 次、无进展即停）→ 点选后回读 `input.value`（含相邻 hidden input 兜底）校验；失败 reason="widget" 降级「需人工」（T057 的「毕业时间」类只读不再只能人工）
- [x] T068 级联 select 实时选项兜底 in `match.ts`/`fill.ts`: `liveOptionTexts`——plan 的选项等价检查与 `fillSelect` 都改读实时 `select.options`（扫描快照会因父级 change 重建子级而过期），空时才回落快照；`tests/unit/widgets.test.ts` 19 用例（date util/combobox 驱动/日历驱动/级联/冲突兜底），全量 159 tests + e2e 54/54 + build DONE
- [x] T069 滚动跟随 + 黄色高亮 in `src/core/ui/highlight.ts`: `focusField(el)`——`scrollIntoView({block:"center",behavior:"smooth"})`（typeof 守卫 + 抛错回退无参，jsdom 兼容）+ CSSOM 行内 `outline:3px solid #f59e0b !important`（不注入页面样式表，规避 CSP style-src；保存/恢复用户原行内 outline，重复调用刷新 1.5s 计时器）；`executeFills` 每项填写前调用（初始轮与补扫轮都生效）
- [x] T070 实时进度面板 + 暂停 + 执行器抽模块 in `src/core/filling/execute.ts`（自 autofill.ts 抽出，进度/暂停可单测）+ `result-panel.ts` `renderProgressPanel`（与结果面板共用 `PANEL_ID="result"` 宿主，finalize 后自动覆盖）+ `session-state.ts` 增 `paused`/`progress{done,total}`（跨补扫轮累计）：进度条 + 「已填 k/N · 匹配 m 项 · 当前：字段名」+「暂停（剩余转需人工）」按钮（置位 `session.paused` → 执行器逐项检查，剩余 fill 项降级 `manual`/「已暂停（用户操作），未自动填写」，不触碰页面）；失败归类逻辑（conflict/no_match/blacklist/widget）随迁 execute.ts；`runSession`/`rescanRound` 经 `progressCtx(session, matched)` 同时渲染面板与 emit 进度
- [x] T071 popup 步骤清单 in `popup.tsx` + `background.ts` + `messaging.ts`: `autofill:event` req 增 `progress?: {done,total,current?,matched?,paused?}`；background 注册 `chrome.runtime.onConnect`（port name `autofill-progress`，`Set<Port>` 转发 autofill:event payload，断连清理）；popup **先 connect 再发 autofill:run**、按 sessionId 过滤并缓冲回放早期事件，四步清单（扫描页面/匹配资料/逐项填写/完成 ✓ 状态机）+ 完成汇总（已填·需确认·未找到·需人工）、**不再自动 `window.close()`**（25s 无 done 提示看页面面板）；panel.css/popup.css 进度条与步骤样式
- [x] T072 P2 测试与验证: `tests/unit/highlight.test.ts` 6 用例（高亮设置/恢复原值/重复调用刷新计时/jsdom 无 scrollIntoView 守卫/抛错回退/SVG 忽略）+ `tests/unit/execute.test.ts` 7 用例（进度累计跨轮+当前字段名/非 fill 不计 total/开填前暂停全降级/中途暂停已填保留/冲突 confirm FR-017/widget 失败降级 manual/高亮生效后恢复）；fake-chrome mock 补 `onConnect`；全量 **172 tests / 12 files** + lint/tsc 0 + build DONE + e2e 54/54 exit 0
- [x] T073 div 型经历行归组 in `src/core/matching/match.ts`: `divOcc` 计数器——非表格（无 `tr` 可依）的经历行，同一语义字段（如 `entry.education.title`）在文档中的出现次序即行号（每行同名字段恰出现一次、文档顺序=行顺序）；表格行（`rowIndex≥0`）仍走 `tr` 索引不受影响；修复 div 卡片多行全部落到「第 0 行 missing」的问题（北森类 div 表单是主流结构）
- [x] T074 多段经历自动展开 in `src/core/filling/expand.ts` + `autofill.ts`: `findAddButtons`（`+添加/新增/增加/新建/加一行` 严格词表 + `保存/提交/删除/上一步…` 黑名单 + 可见性 + 排除扩展面板）；`expandEntryRows`——先算每类 `资料条目数−页面行数`（经 buildFillPlan 全量计划），按钮按**节容器唯一归属**认领（自 button 父链向上找最近含经历字段的祖先，容器含多类 → 歧义不点），pressLike 点击（mousedown/up/click 三连兼容框架），每次点击轮询等行数增长（≤10 次轮询、按次数封顶不死等），无增长即停；每类 ≤5 次；`isPaused` 已暂停不展开；观察者先启动、展开期变更走 FR-016 补扫；**rescanRound 改为全量扫描出计划、只执行新出现元素的条目**（行号按整页归组，新行拿全局行号，且不重复填写旧字段）
- [x] T075 P3 测试: `tests/unit/expand.test.ts` 11 用例（div 行归组 fill/超出行 missing/添加词表黑名单/主流程点 1 次展开+条目 2 可填/资料不超不点/无增长有界停止≤11 轮询/每类封顶 5 次/歧义容器不点/分节归属只扩教育不碰满员实习节/暂停不点/无按钮静默）；全量 **183 tests / 13 files** + tsc/lint 0 + build DONE + e2e 54/54 exit 0
- [x] T076 P3 文档: semantic-fields.md 行号来源与「自动展开」契约更新（取代历史"绝不点添加"决策，含安全边界与 FR-018 关系）、usage.md「多段经历自动展开」小节、README 计数 183/13
- [x] T077 高置信直填 in `src/core/matching/match.ts`: `FieldMatch.exact` 标记别名精确命中（label 与别名逐一相等）；标量计划填闸从 `confidence === "high"` 扩为 `high || exact === true`——gray 但别名精确命中（仅控件形态不吻合，如 textarea「学校」/radio「工作地点」）属 FR-013 的「高置信度匹配」→ 直填；选项措辞/预填冲突/资料待核对/歧义各分支仍在闸前拦截（exact 也无法越过）；部分包含（非 exact）与仅 name/id 弱信号维持原行为（confirm/skip）
- [x] T078 未填标红 in `src/core/ui/highlight.ts` + `autofill.ts` + `confirm-panel.ts`: `markUnfilled/unmarkUnfilled`（WeakMap 保存原行内 outline/offset、幂等，标红前清掉未决黄色高亮计时防 1.5s 恢复回调抹红）+ `shouldMarkUnfilled`（confirm/missing 必标；manual 仅「只读/控件交互失败/已暂停」标红，非填写区黑名单刻意跳过不标；fill/skip 不标）+ `markUnfilledItems(session.executed)` 在首屏结果与补扫结束各标一次；确认面板点选成功在 `markResolved` 中 `unmarkUnfilled` 撤销（跳过则保留红标）
- [x] T079 P4 测试与验证: `confirm-routing.test.ts` T077 块 4 用例（textarea 精确命中直填/radio 等价直填/exact 但选项无等价仍确认/部分包含仍确认）+ `highlight.test.ts` T078 块 11 用例（标红恢复/保留原值/幂等/黄框计时不清则红被抹回归/红后高亮恢复仍是红/SVG 与未标记无操作/过滤规则 4 项/批量标红）；顺手修 `expand.test.ts` 未用 `vi` 导入；全量 **198 tests / 13 files** + tsc/lint 0 + build DONE + e2e 54/54 exit 0

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **US1 (Phase 3, P1/MVP)**: Depends on Foundational — no dependency on other stories（自备 fixture 资料库）
- **US2 (Phase 4, P2)**: Depends on Foundational — 与 US1 可并行（不同文件）
- **US3 (Phase 5, P3)**: Depends on US1（确认面板接入 US1 的 fill session 与结果面板）
- **US4 (Phase 6, P4)**: Depends on US1 + US3（记忆读写发生在匹配与确认环节）
- **US5 (Phase 7, P5)**: Depends on Foundational only — 与 US1-US4 可完全并行（仅共用 storage/model）
- **Polish (Phase 8)**: Depends on all stories being complete（T049/T052/T054 可提前并行）

### User Story Dependencies

- **US1 (P1)**: Foundational 完成后即可开始；独立可测
- **US2 (P2)**: Foundational 完成后即可开始；独立可测；与 US1 并行安全（无共享文件）
- **US3 (P3)**: 依赖 US1 的 `src/contents/autofill.ts` 与结果面板；独立可测（在 US1 之上增量）
- **US4 (P4)**: 依赖 US1（匹配器）与 US3（确认来源）；独立可测
- **US5 (P5)**: 仅依赖 Foundational；独立可测

### Within Each User Story

- Tests first（若执行 TDD）→ 模型/工具 → 核心服务 → 内容脚本/页面接线 → 独立验收（quickstart 对应场景）

### Parallel Opportunities

- Phase 1: T002/T003/T004/T005 全部并行
- Phase 2: T007/T009/T010/T016 并行（不同文件）
- US1: T017/T018/T019 并行；T020 与 T017-T019 并行
- US2: T027/T028/T029 并行
- US3/US5: 两阶段可整体并行（US5 不触碰 contents/autofill.ts）
- Polish: T049/T052/T054 并行

---

## Parallel Example: User Story 1

```text
# Launch together (different files, no shared dependencies):
Task: "Unit tests for deterministic matcher in tests/unit/matching.test.ts"
Task: "Unit tests for filler in tests/unit/filling.test.ts"
Task: "Create fixture pages tests/fixtures/sample-form.html (+step2)"

# Then implementation wave:
Task: "Create DOM field scanner in src/core/matching/scan.ts"
Task: "Implement filler in src/core/filling/fill.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL)
3. Complete Phase 3: User Story 1（含 fixture 资料库）
4. **STOP and VALIDATE**: quickstart S1 通过（3 秒内填对常见字段 + 结果清单）
5. 此时即达成 spec 核心价值"打开网申页、一键填对大部分常见字段"

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 → quickstart S1 验收（**MVP**）
3. US2 → 手动建档闭环（S1 前半）
4. US3 → 确认面板闭环（S2：拿不准不乱填）
5. US4 → 记忆闭环（S3：确认一次永久免问）
6. US5 → 简历导入闭环（S4/S5）
7. Polish → S0/S8/S10 隐私与边界验收 + 文档

### Parallel Team Strategy

- Foundational 全员一起完成；之后：Dev A = US1→US3→US4 主线（填写链），Dev B = US2 + US5（资料与导入链）；二者仅在 storage/model 上汇合，无文件冲突。**不要为第一版实现任何 LLM 任务**（FR-028）。

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- 每个 story 完成后停在各自 Checkpoint，用 quickstart 对应场景独立验收
- 隐私底线（任何阶段都不得破坏）：零对外网络请求、不自动提交、不触碰验证码/上传/密码框、明文本机存储
- Commit after each task or logical group
