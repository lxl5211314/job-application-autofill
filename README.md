# 校招海投助手（job-application-autofill）

面向校招/社招网申的 Chrome 扩展：**本地个人资料库 + 一键填写 + 页内确认面板 + 字段记忆 + 简历导入**。

- **零外发**：无任何远程请求，资料仅存本机 `chrome.storage.local`（spec FR-024 / SC-008）
- **零 LLM**（v1.0）：全部基于确定性词表与正则规则，AI 能力为 v1.1 预留（FR-028）
- **安全兜底**：提交按钮、密码框、文件上传、协议勾选、验证码永不自动触碰（S8 / FR-018）
- Spec 驱动开发：[`specs/001-job-application-autofill/`](./specs/001-job-application-autofill/)
- **上手操作手册：[docs/usage.md（如何使用插件）](./docs/usage.md)**

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [使用指南 → docs/usage.md](./docs/usage.md)（安装/建档/一键填写/确认面板/记忆/控件对照/故障排查）
- [架构设计](#架构设计)
- [简历导入与坏字形修复](#简历导入与坏字形修复)
- [隐私与安全](#隐私与安全)
- [测试与验收](#测试与验收)
- [常见问题（FAQ）](#常见问题faq)
- [目录结构](#目录结构)
- [规格文档](#规格文档)
- [路线图](#路线图)

---

## 功能特性

### 1. 资料管理（options 页）

六个分区维护个人资料，保存时逐字段校验、实时错误提示、完整度指示：

| 分区 | 内容 |
|------|------|
| 基本信息 | `basic.name` 姓名、`basic.gender` 性别、`basic.birthday` 出生日期、`basic.phone` 手机号、`basic.email` 邮箱、`basic.school` 学校、`basic.major` 专业、`basic.degree` 学历、`basic.political_status` 政治面貌 |
| 求职意向 | `intent.position` 意向岗位、`intent.city` 意向城市、`intent.salary` 期望薪资 |
| 教育经历 | 学校/专业/起止时间/描述（`entry.education.*`） |
| 实习经历 | 公司/职位/起止时间/描述（`entry.internship.*`） |
| 项目经历 | 项目名/角色/起止时间/描述（`entry.project.*`） |
| 获奖经历 | 奖项/等级/时间/描述（`entry.award.*`） |

校验规则（FR-003）：手机号 `^1[3-9]\d{9}$`、邮箱格式、单字段 ≤500 字符、描述 ≤2000 字符、经历 `start ≤ end`；错误按字段就地展示。

### 2. 简历导入（options 页）

- 支持 **文本型 PDF / .txt / .md**，pdf.js 本地 worker 解析，全程不出本机
- 解析结果进**草稿核对页**：逐字段检查/修改/补空缺，低置信字段醒目标记（FR-008）
- 写入支持两种模式（FR-010，重复导入强制二选一）：
  - **覆盖**：清空旧资料，全部以草稿为准
  - **合并**：已确认的手动值优先保留（FR-010）
- 扫描件（无可抽取文本层）明确报错，不建草稿（FR-009）

### 3. 一键填写（popup）

```
扫描页面 → 字段记忆查询 → 确定性匹配 → 执行填写 → 结果清单
              ↓（300ms 防抖，主窗口 3s + 补扫 ≤5s / ≤8s 总预算，FR-016）
         动态追加字段自动补扫
```

- 首屏反馈 ≤3 秒（SC-006）；结果按 `filled / needs_confirm / missing_in_profile / not_found / manual_required` 分类（FR-014）
- 手机号/邮箱等敏感值**掩码显示**（data-model §4）
- 页面已预填且与资料库不一致 → **不覆盖**，转确认（FR-017）

### 4. 页内确认面板（Shadow DOM）

- 低置信 / 冲突 / 歧义字段弹出面板询问，点选后才写入页面（FR-013）
- 歧义标签列表见 `contracts/semantic-fields.md` §4；无候选时可跳过或自定义输入
- 点选成功 → 自动写入字段记忆（`source=user_confirm`，FR-021）

### 5. 字段记忆

- 按**字段签名**（标签归一 + 控件类型 + name/id/placeholder + 选项指纹）存取
- 记忆命中 → 高置信直填不再询问（FR-021）；歧义签名即使有记忆仍询问（FR-022）
- 只有显式动作才写入：面板点选，或结果面板上的「记住本次修改」按钮（FR-020，`source=user_edit`）；`skip` 不写入（FR-023）
- LRU 上限 **2000 条**，填写报告保留 **20 条**（data-model §3）

### 6. 安全边界（S8）

| 永不自动填写 | 说明 |
|---|---|
| 提交/下一步类按钮 | 仅标记 `manual_required` |
| `type=password` / `type=file` | 扫描阶段直接过滤 |
| 协议勾选（《隐私政策》等） | 标记需人工 |
| 验证码区域 | 标记需人工 |
| readonly / disabled / 不可见控件 | 不自动填写（FR-019）；只读且能识别出资料字段名的归「需人工」并标注（T057） |

---

## 快速开始

### 环境要求

- Node.js ≥ 18、npm
- Chrome / Edge（Chromium ≥ 110）
- （可选，跑 E2E）Python 3 + Playwright：`pip install playwright && playwright install chromium`

### 安装与命令

```bash
npm install          # postinstall 自动复制 pdf.js worker → resources/pdf.worker.mjs
npm run dev          # 开发构建（热更新）→ build/chrome-mv3-dev
npm run build        # 生产构建 → build/chrome-mv3-prod
npm run package      # 打包 zip → build/chrome-mv3-prod.zip
npm test             # Vitest 单元测试（jsdom，140 项）
npm run test:watch   # 监听模式
npm run lint         # ESLint（含 scripts/*.mjs）
npx tsc --noEmit     # TypeScript 严格类型检查
npm run format       # Prettier 格式化
```

### 发布前检查顺序

```bash
npx tsc --noEmit  &&  npm run lint  &&  npm test  &&  npm run build
```

- `npm run build` 出现 `DONE` 即成功
- build 会自动执行 `postbuild`，修复 Parcel 产出的 `_` 前缀文件名——**Chrome 拒绝加载此类文件**，请勿用 `npx plasmo build` 代替 `npm run build`

### 加载已解压扩展

1. `npm run build`（或 `npm run dev`）
2. 打开 `chrome://extensions` → 打开右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择：
   - 开发验证：`build/chrome-mv3-dev`
   - 分发/验收：`build/chrome-mv3-prod`
4. 打开任意 `http(s)` 网申页 → 点扩展图标 →「一键填写」
5. 资料管理 / 简历导入：popup 内「资料管理」→ 独立标签页打开 options

> ⚠️ **改代码后必须在 `chrome://extensions` 点「重新加载」**，已加载的解压扩展不会自动热更新（见 [FAQ](#常见问题faq)）。

---

## 使用指南（速览）

> 完整操作手册（安装/建档/填写/确认面板/记忆机制/控件对照/故障排查）见 **[docs/usage.md](./docs/usage.md)**。

### 首次使用

1. popup →「资料管理」打开 options 页
2. 手动填写六个分区，或「从简历导入」上传 PDF → 草稿核对 → 选择**覆盖/合并**确认
3. 回到任意网申页 → popup →「一键填写」
4. 关注结果清单：
   - `已填`：直接写入成功
   - `待确认`：页内面板点选后写入
   - `未找到`：资料库有值但页面没有对应字段
   - `缺资料`：页面有字段但资料库没值
   - `需人工`：黑名单控件（提交按钮/协议/验证码等）

### 多步表单 / 动态表单

第二步、第三步动态追加的字段会被 MutationObserver **与滚动**（T064，懒加载表单滚动到才渲染）自动补扫（FR-016，防抖 300ms，主窗口 3s + 补扫 ≤5s）。若超过预算仍未出现，滚动页面后重新点「一键填写」即可。

---

## 架构设计

### 技术栈

| 层 | 选型 |
|---|---|
| 扩展框架 | Plasmo 0.90.5（MV3 + Parcel），manifest 权限仅 `storage` + `activeTab` |
| 语言 | TypeScript（strict），**不依赖 React/Vue/Svelte**（R1，UI 为原生 TS + DOM） |
| 样式 | 原生 CSS；页内面板挂 **Shadow DOM** 隔离页面样式 |
| PDF 解析 | pdfjs-dist 4.8.69，worker 从扩展内 `resources/pdf.worker.mjs` 加载（禁 CDN） |
| 存储 | `chrome.storage.local`（明文、`schemaVersion=1` 迁移、LRU 限额） |
| 测试 | Vitest（jsdom）+ Playwright E2E |

### 数据流

```
┌─────────────┐  消息信封   ┌──────────────────────┐
│ popup /     │ ──────────▶ │ background.ts        │  MV3 service worker
│ options 页  │ ◀────────── │ 消息路由（13 类）     │  路由 + 存储读写
└─────────────┘             └──────┬───────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
 storage/store.ts           resume/*                   contents/autofill.ts
 profile / entries          pdf.ts + extract.ts        scan → match → fill
 fieldMemory / reports      （文本层抽取 + T056 修复）   → 补扫 → FillReport
```

### 消息契约（`src/core/messaging.ts`，13 类 + `llm:*` v1.1 预留）

| 消息 | 用途 |
|---|---|
| `profile:get` / `profile:save` | 读取/保存资料库 |
| `settings:get` / `settings:save` | 设置（`llm*` 字段 v1.1 预留，落库强制回写默认值） |
| `memory:lookup` / `memory:write` | 字段记忆批量查询 / 写入（仅 `user_confirm`、`user_edit`） |
| `report:save` / `report:list` | 填写报告（掩码后）落库 / 列表 |
| `resume:confirm` / `resume:discard` | 草稿确认导入（覆盖/合并）/ 丢弃 |
| `autofill:run` / `autofill:event` | 触发填写会话 / 进度事件 |
| `confirm:resolve` | 确认面板点选结果回填 |

错误码：`VALIDATION_ERROR`（含字段级 details）、`NOT_CONFIGURED`、`NO_PROFILE`、`TAB_UNAVAILABLE`；10s 超时。

### 匹配管线（`src/core/matching/`）

1. **scan.ts** —— 枚举可填写控件；抽取 label（`label[for]` → `aria-label` → `placeholder` → 表格列头）、区块标题、选项集；黑名单判定；过滤 readonly/disabled/隐藏。另由 `scanReadonlyFields` 单独收集只读控件（T057：匹配到资料字段则归「需人工」，不静默丢弃）
2. **signature.ts** —— `norm(label) + controlKind + norm(name/id/placeholder) + 选项指纹` 生成稳定签名
3. **vocabulary.ts** —— 中英别名词表（12 个标量字段，含 T063 性别/出生日期）、`autocomplete` 属性白名单（T058）、经历区块信号、非填写区黑名单、歧义标签
4. **match.ts** —— 打分定档（T058 降噪后）：
   - `high`（110 `autocomplete` 属性 / ≥100 别名精确命中 + 控件吻合，或记忆命中）→ 直接填
   - `gray` 且为 label 包含/选项形态命中（控件类型吻合）→ 确认面板
   - `gray` 但**仅 name/id 弱信号**（词边界匹配，如 `userPhone`）→ 跳过不问，报告归「未找到」+原因
   - `low`（歧义 / 无候选）→ 歧义进确认面板，无候选静默跳过
   - 勾选框（是/否问卷题）不作标量填写目标；radio 冲突按选中项**可见文案**比较（value `on`/`1` 不误报）
   - 姓名两输入框（姓/名、Last/First Name）按页面标签把资料库整名**拆分**填写（T061，复姓表+英文名按空格）
5. **fill.ts** —— 原生 value setter + `input/change/blur` 事件（受控组件兼容）、select 等价映射（本科/学士↔Bachelor）、radio/checkbox `click()`

---

## 简历导入与坏字形修复

### 抽取规则（`src/core/resume/extract.ts`，正则 + 词表，零 LLM）

- 标量锚点：`姓名：` / `性别：` / `出生年月：` / `手机` / `邮箱` / `学校` / `专业` / `学历` 等中英标签（T063）
- 经历时间段：`20xx.xx - 20xx.xx`（行首 / 行尾 / 单日期三种形态）
- 低置信回退：解析不到日期的经历 → `state=needs_review`（草稿页标「待核对」）
- T055 加固：控制字符剔除、康熙部首/兼容字形归一、无「姓名：」标签的首行姓名回退、日期残骸降级为无日期条目

### T056：坏 ToUnicode 日期数字修复（`src/core/resume/pdf.ts`）

部分工具导出的 PDF 会把**日期数字的 ToUnicode 映射写坏**（字形反查得到 NUL，日期只剩 ` . - . ` 残骸）。修复链路：

1. `getTextContent` 探测到 NUL → 关归一化重取 + `getOperatorList()` 取字形流（`unicode` / `originalCharCode`）
2. **锁步对齐**：`getTextContent` 文本流与 `showText` 字形流逐项对齐，**合成空格不消费字形**，desync 必须为 0
3. 数字字形按 `digit = cid - base` 还原；`base` 由全体坏字形 cid 跨度推导（跨度 >10 → 无候选），多个候选按**合法日期数**打分
4. 任一对齐失败 / cid 越界 / 无合法日期 → **整页回退原文本**（宁缺勿错，绝不错替换）
5. 下游 `normalizeResumeText` 兜底剔除残留控制字符

回归夹具：`tests/fixtures/resume-broken.pdf`（数字 ToUnicode 全坏，本地生成）。

---

## 隐私与安全

**零外发保证（SC-008）**：

- 代码中无 `fetch(` / `XMLHttpRequest` / `new Image()` / `sendBeacon` 等任何对外请求（T050 审计）
- manifest 仅 `storage` + `activeTab` 权限，**不申请 `host_permissions`**、不注入远程脚本
- pdf.js worker、字体、词表全部打包本地；E2E 断言产物中无 `<script src="http` / `importScripts("http`
- 资料只存 `chrome.storage.local`（明文，本机隔离；不加密上云，因为根本不出本机）
- 结果面板手机号/邮箱掩码显示；填写报告落库前已掩码

**本仓库隐私**：`tests/fixtures/*` 全部为本地生成的合成数据；真实简历 PDF 不入库。

---

## 测试与验收

### 单元测试（Vitest，140 项 / 9 文件）

| 文件 | 覆盖 |
|---|---|
| `matching.test.ts` | 词表命中、置信分档、区块/列、黑名单 |
| `filling.test.ts` | 原生 setter、select/radio/checkbox、FR-017/018 |
| `validation.test.ts` | 手机号/邮箱/长度/日期区间边界 |
| `memory.test.ts` | FR-020~023、LRU 2000、歧义降级 |
| `confirm-routing.test.ts` | low/gray/conflict/歧义 → `needs_confirm` |
| `store-roundtrip.test.ts` | schemaVersion 迁移、限额、报告掩码 |
| `resume.test.ts` | 抽取规则、扫描件判定、**T056 坏字形修复** |
| `resume-exotic.test.ts` | T055：康熙部首、NUL 日期、无标签姓名 |
| `resume-import.test.ts` | 覆盖/合并导入、FR-006/007/010 |

### 端到端（`npm run build && python scripts/e2e-quickstart.py`）

Playwright 加载 `build/chrome-mv3-prod`，**54 项断言**，覆盖：

- **S0** 权限最小化 / worker 在包内 / 无框架产物 / 无远程脚本
- **S1** 一键填写 10 个标量字段、学 select、radio、黑名单跳过
- **S2** 确认面板点选、跳过、**FR-017 不覆盖预填**
- **S3** 动态追加字段补扫（FR-016）、刷新后重跑
- **S4** 文本 PDF 解析、草稿核对、覆盖/合并、扫描件报错
- **S5** 无文本层 PDF → 明确报错（FR-009）
- **S8** 提交按钮/密码/上传/验证码零触碰（SC-007）
- **S10** 数据仅存本机、掩码显示（SC-008）

### 量化指标

| 指标 | 目标 |
|---|---|
| SC-001/002 | 匹配正确率（样例语料） |
| SC-003 | 记忆命中率 |
| SC-006 | 一键填写首屏反馈 ≤3s |
| SC-007 | 黑名单控件零触碰 |
| SC-008 | 零外发 + 掩码 |

---

## 常见问题（FAQ）

**Q：改了代码 / 重新 `npm run build` 后，扩展行为没变化？**
解压扩展不会热更新。打开 `chrome://extensions` → 点本扩展的**刷新图标**→ 重新测试。

**Q：重新导入简历后，开始/结束时间还是空的？**
大概率是历史遗留：坏字体修复（T056）之前导入的条目没有日期，且导入时选了「合并」——合并会保留旧的无日期条目。请**重载扩展**后重新导入并选**「覆盖」**。

**Q：结果面板全是「未找到」？**
1. 确认资料库已有值（缺资料的字段显示为 `缺资料` 而非 `未找到`）
2. 检查页面字段是否为 `readonly` 自定义控件（点开弹层选择的那种）——按设计不自动填，归 `需人工`
3. 控件若在 iframe 内，v1 内容脚本只扫顶层框架（`all_frames: false`）

**Q：确认面板弹出一堆「陌生字段」（如 `hasAppliedOtherJob`）根本没法选？**
旧版本把仅靠 name/id 猜出的低置信匹配也塞进确认面板（T058 已修复）。现在：name/id 弱信号直接跳过归「未找到」（悬停看原因）、是/否勾选题不进确认、`autocomplete` 标准属性优先直填；确认面板只留**真歧义 / 页面值冲突 / 选项措辞不一致**三类，并按组展示可读中文字段名。仍看到大量确认项 → **重载扩展**后重试。

**Q：导入 PDF 提示"无法提取文本"？**
扫描件/图片型 PDF 没有文本层（FR-009 明确报错）。请换文本型 PDF，或用 `.txt/.md` 导出后导入。

**Q：某招聘站点链接打开 404？**
那是站点自身的短链过期/一次性链接，与扩展无关。

**Q：会自动点「提交/确定」吗？**
永远不会。提交类按钮、协议勾选、验证码只标记 `需人工`（S8/SC-007）。

---

## 目录结构

```
src/
  background.ts            # MV3 service worker：13 类消息路由 + 存储读写
  options.tsx              # 资料管理页（六分区 + 简历导入 + 设置）
  popup.tsx                # 一键填写入口与进度
  contents/autofill.ts     # 填写会话编排（scan→match→fill→补扫→报告）
  core/
    model/                 # 实体类型（10 标量 + 4 类经历）、校验、掩码
    matching/              # scan / signature / vocabulary / match
    filling/               # fill（控件填写）、session-state
    resume/                # pdf（T056 修复）/ text / extract（T055 加固）
    storage/store.ts       # chrome.storage.local（迁移、LRU 限额）
    messaging.ts           # 消息信封与错误码
    ui/                    # result-panel / confirm-panel / draft-review /
                           # profile-forms / entry-lists / panel-host（Shadow DOM）
  styles/                  # 原生 CSS（popup / options / panel）
scripts/
  make-resume-fixtures.mjs # 本地生成简历夹具（含 resume-broken.pdf）
  e2e-quickstart.py        # Playwright E2E（54 项断言）
  postbuild-fix.mjs        # 修复 Parcel `_` 前缀文件名
  copy-pdf-worker.mjs      # postinstall 复制 pdf.js worker
specs/                     # spec-kit 规格（spec/data-model/contracts/tasks/quickstart）
docs/usage.md              # 使用指南（安装/建档/填写/确认/记忆/排查）
tests/unit/                # Vitest 单测（140 项）
tests/fixtures/            # 合成夹具（HTML 表单页、PDF/txt 简历）
```

---

## 规格文档

| 文档 | 内容 |
|---|---|
| [`spec.md`](./specs/001-job-application-autofill/spec.md) | 功能需求 FR-001~028、场景 S1~S10、SC 量化指标 |
| [`data-model.md`](./specs/001-job-application-autofill/data-model.md) | Profile / 经历 / 记忆 / 报告 / 草稿 / 设置 |
| [`contracts/`](./specs/001-job-application-autofill/contracts/) | 消息契约、语义字段词表、LLM 契约（v1.1） |
| [`tasks.md`](./specs/001-job-application-autofill/tasks.md) | 任务清单 T001~T064（全部完成） |
| [`quickstart.md`](./specs/001-job-application-autofill/quickstart.md) | 手工验收场景 S0~S10 |

---

## 路线图

**v1.0（当前）**：确定性匹配 + 字段记忆 + 简历导入，零外发零 LLM。

**v1.1（预留，未实现）**：
- `llm:*` 消息与设置项（`llmEnabled` / `llmProvider` / `llmApiKey` / `llmRewriteEnabled` 已在数据模型占位，FR-028）
- 简历语义抽取增强、OCR 扫描件支持
- iframe 内表单扫描（`all_frames: true`）
- 可选 `host_permissions` 站点适配
