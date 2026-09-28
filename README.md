# 校招海投助手（job-application-autofill）

网申表格自动填写浏览器扩展：**本地个人资料库 + 一键填写 + 页内确认面板 + 字段记忆**。
所有数据仅存本机 `chrome.storage.local`，全程零外发（spec FR-024/SC-008）。

- Spec 文档：[`specs/001-job-application-autofill/`](./specs/001-job-application-autofill/)（spec / data-model / contracts / tasks / quickstart）
- 第一版不含 AI/LLM（FR-028）：`llm:*` 消息与设置字段为 v1.1 预留，落库时强制回写默认值

## 环境要求

- Node.js ≥ 18、npm
- Chrome / Edge（Chromium ≥ 110）
- 端到端验收（可选）：Python 3 + `playwright`（`pip install playwright && playwright install chromium`）

## 常用命令

```bash
npm install          # postinstall 自动复制 pdf.js worker 到 resources/pdf.worker.mjs
npm run dev          # 开发构建（热更新）→ build/chrome-mv3-dev
npm run build        # 生产构建 → build/chrome-mv3-prod
npm run package      # 打包 zip（build/chrome-mv3-prod.zip）
npm test             # Vitest 单元测试（jsdom）
npm run test:watch   # 监听模式
npm run lint         # ESLint（含 scripts/*.mjs）
npx tsc --noEmit     # TypeScript 严格类型检查
npm run format       # Prettier 格式化
```

发布前检查顺序：`npx tsc --noEmit` → `npm run lint` → `npm test` → `npm run build`（出现 `DONE` 即成功；`npm run build` 会自动执行 `postbuild` 修复 Parcel 产出的 `_` 前缀文件名——Chrome 拒绝此类文件导致加载失败，请勿直接用 `npx plasmo build` 代替）。

## 加载已解压扩展

1. `npm run dev`（或 `npm run build`）
2. 浏览器打开 `chrome://extensions` → 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」→ 选择构建产物目录：
   - 开发验证：`build/chrome-mv3-dev`
   - 分发/验收：`build/chrome-mv3-prod`
4. 打开任意 `http(s)` 网申页 → 点扩展图标（popup）→「一键填写」
5. 资料管理 / 简历导入：popup 内「资料管理」进入 options 页（独立标签页打开）

## 功能速览

| 入口 | 说明 |
|------|------|
| options 资料管理 | 六分区（基本信息/求职意向/教育/实习/项目/获奖）+ 保存校验 + 完整度指示 |
| options 从简历导入 | 文本型 PDF / .txt / .md 本地解析（pdf.js 本地 worker）→ 草稿逐项核对 → 合并或覆盖写入；扫描件明确报错（FR-009） |
| popup 一键填写 | 扫描 → 记忆查询 → 匹配 → 填写 → 结果清单（掩码显示）；3s 内出首屏反馈，补扫窗口 ≤8s（FR-016/SC-006） |
| 页内确认面板 | 低置信/冲突/歧义字段询问；点选后写入字段记忆（FR-013/021/022） |
| 「记住本次修改」 | 结果面板已填条目上的显式按钮，点击才写入记忆（FR-020，source=`user_edit`） |

安全边界（S8）：提交按钮、密码框、文件上传、协议勾选、验证码永不自动填写；页面已有且不一致的值不覆盖（FR-017）。

## 技术栈与架构

- **Plasmo 0.90.5**（MV3 + Parcel）+ TypeScript（严格模式）+ 原生 HTML/CSS（UI 无框架，Shadow DOM 隔离）
- **pdf.js 4.8.69** 本地 worker 解析 PDF 文本层（worker 从打包资源加载，禁 CDN）
- **零外发**：无任何远程请求；`host_permissions` 仅覆盖网申页面本身；简历/资料只进 `chrome.storage.local`（明文，schemaVersion 迁移 + LRU 限额），不加密、不上云
- 抽取规则引擎：正则 + 词表（零 LLM）——锚点字段、时间段经历行、低置信回退（`src/core/resume/extract.ts`）

```
popup / options ──消息──▶ background.ts（service worker 路由）
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        storage/store    resume/*          contents/autofill.ts
        （资料/记忆）   （PDF/txt 抽取）    （scan→match→fill→报告）
```

### 简历 PDF 解析与坏字形修复（T056）

部分工具导出的 PDF 会把**日期数字的 ToUnicode 映射写坏**（字形反查得到 NUL，日期只剩 ` . - . ` 残骸）。
修复链路（`src/core/resume/pdf.ts`）：

1. `getTextContent` 发现 NUL → 关归一化重取 + `getOperatorList()` 取字形流（`unicode`/`originalCharCode`）
2. 锁步对齐（合成空格不消费字形，desync 必须为 0），数字字形按 `digit = cid - base` 还原
3. `base` 由全体坏字形 cid 跨度推导（跨度 > 10 无候选），多个候选按**合法日期数**打分
4. 任一对齐失败 / cid 越界 / 无合法日期 → **整页回退原文本**（宁缺勿错，绝不错替换）
5. 下游 `normalizeResumeText` 仍会剔除残留控制字符，日期残骸走「无日期条目」回退（`state=needs_review` 待核对）

## 夹具与验收

- 单测夹具：`tests/fixtures/`
  - `sample-form.html` / `sample-form-step2.html` —— 覆盖 S1/S2/S8/S-FR-016 的静态网申页
  - `resume-text.pdf`（可抽取文本层）、`resume-scan.pdf`（无文本层）、`resume-broken.pdf`（数字 ToUnicode 全坏，T056 修复回归）、`resume.txt` —— 简历导入 S4/S5
  - 重新生成简历夹具：`node scripts/make-resume-fixtures.mjs`（夹具全部本地生成，无外部依赖）
- 端到端验收：按 [`specs/001-job-application-autofill/quickstart.md`](./specs/001-job-application-autofill/quickstart.md) 的 **S0–S8、S10** 场景执行（S9 为 v1.1 LLM 预留，第一版跳过）
  - 自动化：`npm run build && python scripts/e2e-quickstart.py`（Playwright 加载 `build/chrome-mv3-prod`，覆盖 S0/S1/S2/S3/S4/S5/S8/S10 与 FR-016 补扫，54 项断言）
- 量化指标：SC-001/002（匹配正确率）、SC-003（记忆命中率）、SC-006（≤3s 反馈）、SC-007（黑名单不触碰）、SC-008（零外发 + 掩码）

## 目录结构

```
src/
  background.ts            # MV3 service worker 消息路由（profile/settings/memory/report/resume/autofill/confirm）
  options.tsx              # 资料管理页（六分区 + 简历导入 + 设置）
  popup.tsx                # 一键填写入口与进度
  contents/autofill.ts     # 填写会话编排（scan→match→fill→补扫→报告）
  core/
    model/                 # 实体类型、校验、掩码
    matching/              # DOM 扫描、签名、词表、匹配与计划
    filling/               # 控件填写、会话状态
    resume/                # 简历抽取（extract/text/pdf，含 T056 坏字形修复）
    storage/store.ts       # chrome.storage.local（schemaVersion 迁移、LRU 限额）
    ui/                    # 结果面板、确认面板、草稿核对、表单（Shadow DOM 隔离）
  styles/                  # 原生 CSS（无框架）
scripts/
  make-resume-fixtures.mjs # 本地生成简历 PDF/txt 夹具（含坏字形夹具）
  e2e-quickstart.py        # Playwright 端到端验收（54 项断言）
  postbuild-fix.mjs        # 修复 Parcel `_` 前缀文件名（Chrome 加载要求）
  copy-pdf-worker.mjs      # postinstall 复制 pdf.js worker
specs/                     # spec-kit 规格文档（spec/data-model/contracts/tasks/quickstart）
tests/unit/                # Vitest 单测（matching/filling/validation/store/confirm/memory/resume…）
```
