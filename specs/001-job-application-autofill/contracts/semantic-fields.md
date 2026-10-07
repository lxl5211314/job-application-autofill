# Contract: 字段语义目录（semantic-fields）

**Feature**: 001-job-application-autofill | **Date**: 2026-09-27

"字段语义"是匹配（research R4）、记忆（data-model §3）与报告（data-model §4）共用的唯一词表。落点：`src/core/matching/vocabulary.ts`。字段签名（signature）生成规则附于文末。

## 1. 标量字段（对应 Profile）

| semanticFieldId | 类型/控件 | 中文别名（label/id/placeholder 命中） | 英文别名 | 备注 |
|---|---|---|---|---|
| `basic.name` | text | 姓名、名字、真实姓名、申请人姓名、姓 名、姓、名 | name, full name, applicant name, surname, first name, given name | 与"联系人姓名"区分（后者不匹配）；「姓/名」两输入框布局按 `splitNameValue` 拆分（T061，复姓 2 字） |
| `basic.gender` | radio/select/text | 性别 | gender, sex | T063；值归一化 男/女；选项等价 男↔男性↔Male（`GENDER_EQUIVALENCES`）；简历锚点「性别：」 |
| `basic.birthday` | text/select | 出生日期、出生年月、出生年月日、出生时间、生日 | birthday, birth date, date of birth, dob | T063；宽松格式 1999 / 1999-09 / 1999年9月；只读日期弹层走 T057 上报「需人工」 |
| `basic.phone` | tel/text | 手机号、手机号码、联系电话、移动电话、手机 | mobile, phone, cell, telephone | 归一化：去空格/连字符/+86 前缀 |
| `basic.email` | email/text | 邮箱、电子邮箱、电子邮件、Email 地址 | email, e-mail | 需含 `@` 形态时优先 email 类型控件 |
| `basic.school` | text | 学校、毕业院校、就读学校、最高学历毕业学校、学校名称 | school, university, college, institution | 教育经历条目内同名字段由条目负责 |
| `basic.major` | text | 专业、所学专业、专业名称、主修专业 | major, specialty, field of study | |
| `basic.degree` | select/radio/text | 学历、最高学历、学历层次 | degree, education level | 选项映射：本科/学士↔Bachelor，硕士/研究生↔Master，博士↔Doctor/PhD（等价表命中=高置信，否则确认面板） |
| `basic.political_status` | select/text | 政治面貌、党团面貌 | political status | 选项：中共党员/共青团员/群众等，非枚举值→确认 |
| `intent.position` | text/select | 应聘岗位、求职岗位、意向岗位、投递岗位、职位、岗位 | position, job title, role, applied role | 多岗位分隔符归一化（`/、,，`） |
| `intent.city` | text/select | 意向城市、工作地点、期望城市、工作城市、求职城市 | city, location, work location | |
| `intent.salary` | text/select | 期望薪资、薪资要求、期望月薪、意向薪资 | expected salary, salary expectation | 归一化："15-20K"、"15000-20000" 视为同类值 |

## 2. 经历型字段（对应 ExperienceEntry）

| semanticFieldId 模式 | 覆盖的页面区域 | 识别信号 |
|---|---|---|
| `entry.education.*` | 教育经历表格/表单（学校、专业、学历、起止时间、GPA/排名） | 区块标题含"教育经历/教育背景"；表格表头 |
| `entry.internship.*` | 实习经历（公司、部门、岗位、起止时间、工作内容） | 区块标题含"实习/实践经历"；"公司名称""工作内容"等表头 |
| `entry.project.*` | 项目经历（项目名、角色、时间、项目描述） | 区块标题含"项目经历/项目经验" |
| `entry.award.*` | 获奖情况/证书（奖项名、时间、级别） | 区块标题含"获奖/奖励/证书/资格证书" |

约定：
- 经历区块按"区块标题 → 行（一条经历）→ 列（条目属性）"解析；**同一语义列在不同行重复出现时逐行填入对应序号的经历**，条目不足时该单元格跳过并标记 `missing_in_profile`（FR-012/015）。
- 单行经历表单（许多站点一次显示一条、带"添加一条"按钮）：只填当前可见行，不点击"添加"按钮（不制造条目，FR-018 精神：不代替用户做提交类操作）。

## 3. 非填写区（一律标 `manual_required`，FR-018）

验证码/OCR 区域、`type=file` 上传、扫码登录、密码框、"提交/投递/下一步/确认投递"类按钮、条款勾选框（"我已阅读并同意"——协议勾选由用户自行决定）。

## 4. 歧义字段（`ambiguous` 标记，FR-022）

`备注`、`其他说明`、`补充信息`、`自我评价`（可自动填的仅当用户资料库显式提供了对应自定义文本——v1 不提供，故一律确认）、任何同时命中 ≥2 个 semanticFieldId 的标签。歧义字段的已有记忆**不直接套用**，进确认面板。

## 5. 字段签名（signature）生成规则（记忆主键）

```text
signature = sha1(
  norm(labelText)                    // 最近 label/前置文本/aria-label，全角→半角、去标点空白
+ "|" + controlKind                  // text | tel | email | select | radio | checkbox | textarea
+ "|" + norm(nameIdPlaceholder)      // name/id/placeholder 择最长可用者，去前后缀分隔符
+ "|" + optionSetFingerprint         // select/radio：排序后选项文本的短哈希；否则 "-"
)
```

- 目的：跨站点稳定（SC-003），同时用 `optionSetFingerprint` 区分"学历"这类同名不同选项的字段。
- 生成与匹配实现于 `src/core/matching/`；单测覆盖"同名不同义不串值、异名同义能命中"。

## 6. 匹配置信度分档（research R4）

| 档位 | 条件 | 行为 |
|---|---|---|
| high | 记忆命中（非歧义）或 `autocomplete` 属性白名单（T058）或 别名精确命中 + 控件类型吻合 + 无冲突 | 直接填写 |
| gray（label 包含/选项形态，控件吻合） | 单一候选但信号较弱、或存在多个候选 | ~~可选 LLM 辅助~~（v1.1 预留，spec FR-028）→ 确认面板 |
| gray（仅 name/id 弱信号，T058 P1-3） | 词边界匹配 name/id、无 label、控件吻合（如 `userPhone`） | **不确认不填写** → `action:skip`，报告 `not_found` + 原因（降噪：成熟插件对拿不准的低置信匹配宁可不问） |
| low | 无候选 / 歧义标签 / 与页面预填值冲突 | 歧义与冲突 → 确认面板（附候选值）；无候选 → 静默不报 |
