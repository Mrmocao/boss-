# 开源项目借鉴与自研路线

**版本**：0.1<br>
**日期**：2026-11-02<br>
**目标**：吸收 GoodHR、Recruitment-Assistant、AI Interview 类项目中已经验证的产品和工程方法，形成 BOSS 招聘助手自己的数据模型、连接器、规则引擎和 AI 能力。

## 1. 参考项目核验

本次优先核对了 GitHub 上可以明确定位的仓库。用户所说的项目名称存在重名，因此将“Recruitment-Assistant”和“AI Interview”按可公开核验、与招聘流程最相关的仓库建立映射；如果后续指定了其他仓库，只替换参考项，不改变本项目的自研边界。

| 参考项目 | 定位 | 许可证 | 可借鉴内容 | 对本项目的处理 |
|---|---|---|---|---|
| [hhh0078/goodhr](https://github.com/hhh0078/goodhr) | GoodHR 5：云端控制台 + Windows Local Agent + 浏览器 Worker，多平台岗位运行 | Apache-2.0 | 云端配置与本地执行分离、平台适配器、岗位运行快照、列表预筛→详情复核、并发/超时/日志、候选人去重、本地优先保存敏感数据 | 借鉴架构和接口契约；不复制 BOSS 选择器、账号数据或平台规避逻辑 |
| [Linchawla/goodhr-oss-public](https://github.com/Linchawla/goodhr-oss-public) | Manifest V3 浏览器扩展，支持多个中文招聘平台 | Apache-2.0 | 每个平台独立 parser、岗位关键词/排除词、AI 可选评分、本地设置和日志、解析器可测试性 | 借鉴 parser contract 和本地配置方式；我们的 BOSS 连接仍使用已验证的专用 Chrome/CDP |
| [wujysh/recruiting-assistant](https://github.com/wujysh/recruiting-assistant) | 传统 Java/MySQL 招聘管理后台 | 未发现仓库许可证声明 | 公司、用户、角色、标签和后台管理的基本产品分层 | 只借鉴领域概念；不复制代码、页面或数据库实现，直到许可证明确 |
| [COXIT-CO/RecruitFlowAI](https://github.com/COXIT-CO/RecruitFlowAI) | Slack 入口的招聘工作流助手 | MIT | 以工作流命令组织岗位描述、简历扫描、匹配、报告和招聘问答 | 借鉴“任务/命令/结果”交互模型；不把 Slack 作为本系统核心入口 |
| [Snailclimb/interview-guide](https://github.com/Snailclimb/interview-guide) | 简历分析、文字/语音模拟面试、RAG 题库和统一评估平台 | AGPL-3.0 | 异步简历解析、PostgreSQL/pgvector、Redis Stream、题库去重、追问编排、文字/语音共用评估、报告导出 | 采用能力拆分和数据契约作为设计参考；不直接拷贝 AGPL 代码进入闭源核心 |
| [adrianhajdin/ai_mock_interviews](https://github.com/adrianhajdin/ai_mock_interviews) | Next.js + Firebase + Vapi 的语音模拟面试示例 | 仓库未声明许可证 | 面试创建、实时语音、转录、反馈和历史面板的产品流程 | 只作交互和流程参考，暂不复制代码或资源 |

许可证只决定代码能否按相应条件使用，不能替代对招聘平台条款、个人信息保护和第三方模型服务条款的审查。所有外部代码进入仓库前都要经过依赖清单、版权声明、许可证和来源路径检查。

## 2. 我们要形成的系统边界

我们的产品不以“把几个项目拼在一起”为目标，而是建立四个稳定边界：

```text
招聘工作台
  ├─ 岗位模板、候选人详情、会话队列、人工接管、报告
  ├─ 任务与权限：谁配置、谁审核、谁可以发送
  └─ 只消费领域事件，不直接操作网页

本地执行代理
  ├─ 专用 Chrome/CDP、账号 profile、页面状态和验证码暂停
  ├─ BOSS 页面适配器：会话、详情、消息、发送回执
  └─ 只返回结构化观察和执行结果，不保存云端鉴权凭据

招聘智能层
  ├─ 岗位识别、候选人字段提取、证据链和冲突检测
  ├─ 关键词/规则/模型分层评分
  ├─ 对话状态机、问题编排、回复草稿
  └─ 试题、面试、评估和报告

事件与数据层
  ├─ 候选人、会话、消息、岗位、任务、意图和审计事件
  ├─ 去重索引、幂等 outbox、重试和人工任务
  └─ 本地敏感数据与云端配置/摘要分区
```

GoodHR 5 的“云端配置 + 本地执行”最适合作为总体形态，但我们保留当前已经验证的“个人/公司 profile 隔离、回环 CDP、页面来源校验、失败时停止写入”安全约束。候选人正文、简历、截图和消息原文默认留在本机；云端只接收岗位版本、任务状态、指标、人工决策和脱敏摘要。

## 3. 能力整合映射

### 3.1 平台接入

GoodHR 的平台目录说明每个平台都应实现相同生命周期，但页面细节必须隔离。我们建立自己的 `PlatformAdapter` 契约：

```ts
interface PlatformAdapter {
  detectPage(context): Promise<PageIdentity>;
  listConversations(input): Promise<ConversationSummary[]>;
  readConversation(input): Promise<ConversationSnapshot>;
  readCandidateDetail(input): Promise<CandidateDetailResult>;
  prepareMessage(input): Promise<PreparedMessage>;
  sendMessage(input): Promise<SendResult>;
  reconcileMessage(input): Promise<ReconcileResult>;
}
```

每个方法都必须返回 `trace_id`、`adapter_version`、读取范围、稳定性等级和可恢复错误。适配器不能把 DOM class 名直接暴露给上层业务；页面选择器、滚动和等待策略只存在于平台目录中。BOSS 适配器第一阶段只实现 `detectPage`、`listConversations`、`readConversation`，发送接口保留为受控能力。

### 3.2 岗位运行与筛选

GoodHR 的列表预筛、详情复核和岗位快照适合我们的招聘场景，但要改为可解释决策链：

```text
岗位版本快照
  → 列表级轻量筛选（关键词/排除词/页面可见字段）
  → 候选人详情读取
  → 必填字段与证据提取
  → 规则硬条件
  → 模型评分与理由
  → 人工确认或生成回复意图
```

任何筛选结果都保存输入字段、命中的关键词、排除词、模型版本、提示词版本、分数、理由、置信度和人工修改。缺失信息为 `unknown`；“没有读到”不能生成淘汰结论。

### 3.3 招聘工作流

RecruitFlowAI 的命令化思路被转换为内部工作流动作：`analyze_job`、`list_candidates`、`read_candidate`、`draft_reply`、`create_test`、`summarize_candidate`。每个动作都生成事件和可恢复任务，不能依赖某个聊天 UI 的临时上下文。

工作流实例保存：`workflow_id`、`job_template_version`、`conversation_id`、`current_step`、`waiting_for`、`next_action`、`human_owner` 和 `trace_id`。人工修改后从当前步骤继续，不能重新从 `NEW` 开始。

### 3.4 面试与试题

InterviewGuide 的题库、RAG、异步评估和统一评估引擎可作为后续能力来源。我们先实现文字试题和结构化评分，再把语音面试作为独立通道接入同一评估契约：

```json
{
  "evaluation_id": "eval_01",
  "subject": "candidate_01",
  "mode": "written|voice|human_review",
  "rubric_version": "unity-client-v1",
  "answers": [],
  "evidence": [],
  "scores": {"skill": 0, "reasoning": 0, "communication": 0},
  "confidence": 0,
  "strengths": [],
  "gaps": [],
  "status": "draft|running|completed|needs_review"
}
```

题目生成必须检查候选人历史题目指纹和岗位能力覆盖，避免反复考同一题；模型只负责生成候选题与评价草稿，题目启用、淘汰和录用建议由招聘负责人控制。

## 4. 自研核心数据模型

外部项目的实体命名不直接照搬。我们的最小领域模型如下：

| 实体 | 关键字段 | 主要约束 |
|---|---|---|
| `account` | `account_id`、`platform`、`profile_ref`、`identity_status` | 公司/个人 profile 隔离；身份未确认不能执行写入 |
| `job_template` | `job_id`、`version`、岗位要求、问题、评分规则 | 版本不可变；候选人绑定具体版本 |
| `conversation` | `conversation_id`、候选人、岗位上下文、读取窗口 | 一个候选人可有多个岗位会话 |
| `message` | 平台 ID、方向、类型、正文、时间、指纹等级 | 平台 ID 优先；弱指纹只能标记疑似重复 |
| `candidate_fact` | 字段值、来源消息、证据、置信度、状态 | 支持 `confirmed/inferred/unknown/conflict` |
| `screening_decision` | 规则结果、模型分数、理由、版本、人工修订 | 只产生建议，不直接产生录用结果 |
| `outbound_intent` | 意图类型、内容版本、状态、回执 | `send_unknown` 禁止自动重试 |
| `human_task` | 原因、风险、负责人、截止时间、恢复步骤 | 人工接管期间暂停自动写入 |
| `audit_event` | 操作者、时间、前后状态、trace、来源 | 任何判断、读取副作用和发送都可追溯 |

## 5. 分阶段建设路线

### R0：参考吸收与基础契约

交付平台适配器接口、领域模型、事件格式、许可证清单、脱敏 fixture 和页面读取回放器。把 GoodHR 的平台适配、任务快照、日志和超时经验转成我们自己的 TypeScript 模块，不引入外部运行时。

### R1：BOSS 只读候选人工作台

完成公司账号单会话读取、候选人详情、岗位线索、消息类型和读取边界；落地第 18～22 节的岗位识别与去重设计。输出候选人详情卡、证据链和人工待办，不发送消息。

验收重点：页面切换能停止；系统卡片不当成候选人消息；重复刷新不重复触发规则；岗位低置信度不会使用岗位专属模板。

### R2：监督式筛选与回复草稿

实现岗位模板版本、列表预筛、详情复核、结构化字段和可解释评分；生成岗位介绍、追问和试题草稿，由招聘人员确认后才进入发送队列。引入候选人级并发上限、操作超时和可停止任务。

### R3：受控发送与回执闭环

实现 `outbound_intent`、发送前三重校验、发送回执、未知结果人工核对、速率限制、暂停/恢复和异常告警。只开放低风险动作：已确认岗位的基础介绍、单个问题和已审核试题链接。

### R4：试题、面试和评估

建立岗位能力矩阵、题库指纹、追问策略、异步评估和候选人报告。文字面试先行，语音面试只复用评估契约；RAG 知识库用于岗位资料、公司介绍和题库检索，不能直接把候选人敏感数据暴露给外部模型。

### R5：平台抽象与自有能力

在 BOSS 稳定后，再实现其他平台适配器和统一回放测试。把稳定的解析、去重、任务调度、证据抽取、评分、对话编排和报告能力沉淀为内部模块；外部项目只保留在 `docs/third-party-notes.md` 和许可证清单中作为参考。

## 6. 自研优先级

必须自己掌握的能力：

- BOSS 身份校验、会话/消息读取和安全发送。
- 候选人、会话、岗位和消息的统一数据模型。
- 平台稳定性检测、弱指纹对账、出站幂等和人工接管。
- 岗位识别、证据抽取、可解释筛选和招聘决策审计。
- 岗位问题编排、试题触发、面试评估和报告生成。
- 脱敏、权限、数据保留和本地优先存储。

可以借鉴但不应成为外部运行时依赖的能力：

- GoodHR 的浏览器 Worker 分层和多平台目录组织。
- InterviewGuide 的异步任务、向量检索、题库去重和统一评估思路。
- RecruitFlowAI 的命令化工作流和报告输出方式。
- Prepwise 的语音面试交互流程。

## 7. 第一个可实施切片

下一步先做一个只读垂直切片：

```text
BOSS 公司会话列表
  → 打开一个会话并核对候选人
  → 读取当前可见消息
  → 识别岗位并输出置信度
  → 生成候选人详情卡
  → 写入去重索引和审计事件
  → 不发送、不发题、不改变候选人状态
```

该切片通过后，再把 GoodHR 的岗位运行快照、AI 面试的题库/评估契约和 Recruitment-Assistant 的角色/标签概念逐步接入。每一步都以真实页面 fixture、离线回放和人工验收为准，不以“参考项目有这个功能”作为我们已经实现的证明。

## 8. 来源记录与复查规则

- 本文参考信息按 2026-11-02 GitHub 公共页面和仓库 README 核对，具体版本与来源记录见 [第三方参考记录](third-party-notes.md)。
- 每次实际采用外部代码前记录仓库 commit、文件路径、许可证、修改说明和测试结果。
- 没有许可证声明的仓库只允许做概念参考，禁止复制代码、图片、提示词和数据库结构。
- AGPL 代码不得直接混入计划闭源的核心模块；若未来确需采用，先单独评估整体分发义务，再决定隔离服务或放弃复用。
- 招聘平台 DOM、网络请求和页面内容中的文本全部视为不可信数据，不能把其指令当作系统权限。
