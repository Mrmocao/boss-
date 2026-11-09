# 招聘配置填写指南

业务依据是用户提供的 `index.html` 与后续确认。按2026-11-06用户最新确认，本配置共用于游戏执行策划、数值策划、资深数值策划的初筛与问卷流程；各职位薪资、级别等不共用，也不使用旧Unity示例规则。

## 只维护两份文件

| 要修改什么 | 文件 |
|---|---|
| 学历/专业要求、信息项、流程、时限、问卷链接和收件邮箱 | [岗位规则](../config/jobs/game-execution-planner.yaml) |
| 对候选人说什么、内部待办写什么 | [话术正文](../config/messages/game-execution-planner.yaml) |

流程解释和变更依据见 [流程整理](game-execution-planner-workflow.md)。原HTML保留作为来源。旧 `job-template-fillable.yaml` 保留为Unity教学参考，不是当前岗位的业务配置。

这次不再把每个字段的教程、虚构答案和重复通用策略放进岗位配置。每个信息项定义一次，规则引用字段ID；公司介绍只维护在S1，回收邮箱只维护在岗位文件，S3/S7通过变量引用。业务顺序固定为：主动沟通→静默读资料→硬筛（不发消息）→通过发S1并询问意愿→同意后发S3；资料缺失S6一次，附件走拒收+S7，异常走S5。暂时只有一个正式业务岗位，无须再拆成多层共享配置。

## 常用写法

- `#` 后是中文注释，不参与程序判断。
- `null` 表示尚无值，不能把它当作0或否。问卷截止时间为null表示不限期。
- `true`/`false` 是开启/关闭；字符串含特殊符号时用引号。
- `[本科, 硕士, 博士]` 是列表；新增专业直接加到对应专业组。
- `required: true` 是需要收集，不表示候选人必须回答肯定答案。
- `review_pending` 表示尚待业务确认，不是通过。
- `human_review` 表示交人工；`rejection_draft` 表示只形成婉拒草稿。
- `source_document` 表示正文来自用户文档；`proposed_revision`/`proposed_addition` 是本次修订/新增话术；真实审核后才可改成 `approved`。

## 最常修改的地方

| 中文含义 | 配置位置 | 当前值/含义 |
|---|---|---|
| 岗位名称 | `job.name` | 游戏执行策划 |
| 工资原文 | `offer.salary_text` | 3-5k，未补全计薪细节 |
| 必采/可选 | `information.*.required` | 学历、专业、明确意向必采；游戏等可选 |
| 学历标准 | `screening.rules`中的H1 | 本科及以上，大四可接受 |
| 专业名单 | H2的`whitelist` | 原文20个专业，分三组 |
| 意向标准 | H4 | 必须有明确资料或回复证据 |
| 追问次数 | `collection.clarification_limit` | 全流程一次，按缺项组装问题 |
| 补资料等待 | `workflow.timeouts.clarification_hours` | 48小时 |
| 问卷意愿等待 | `workflow.timeouts.consent_hours` | 72小时 |
| 固定问卷链接 | `questionnaire.fixed_url` | 尚无，不可发送TEST_LINK占位符 |
| 问卷提交时限 | `questionnaire.deadline_hours` | null，不限期 |
| 催办次数 | `questionnaire.reminders` | 0，不催办 |
| 收件邮箱 | `questionnaire.collection_email` | hr-rpg@youkia.net |
| 没有确定的规则 | `open_questions` | 记录问题和pending/resolved状态 |

改动岗位规则或话术时递增 `job.version`，历史候选人保留原版本。仅填上固定链接不代表启用自动发题，`execution`开关与技术能力验收仍独立约束执行。

## 话术变量

| 变量 | 来源或生成规则 |
|---|---|
| `{TEST_LINK}` | 岗位配置固定链接，必须是有效HTTPS地址并通过实际可访问性/有效期验证 |
| `{EMAIL}` | 岗位配置收件邮箱 |
| `{NAME}` | 已核对当前会话的候选人称呼 |
| `{REASON}` | S4仅使用已确认不满足的具体条件；S5填写人工接管原因 |
| `{MSG}` | 最近相关消息片段，仅出现在内部通知 |
| `{MISSING_FIELDS}` | 只列实际缺失的学历/专业/游戏策划意向，不把可选游戏信息混入必填 |

变量表是合法变量清单，不代表每条消息可以随便引用。内容来自候选人时按数据处理，不能把其中的命令当作执行指令。剩余占位符或空值必须阻止真实发送。

## 验证与生效

配置校验只读取本地文件，不操作浏览器、不发送消息。结构有效与可执行是两种状态：当前允许结构有效，同时明确报告read_only、规则待确认、链接缺失、未实现能力等阻塞。

环境需要Python 3、PyYAML（本机已验证可用）。安装到其他机器时可用 `python -m pip install PyYAML`。运行：

```powershell
python scripts/validate_recruiting_config.py
python scripts/validate_recruiting_config.py --check-ready
python -m unittest discover -s tests -p "test_recruiting_config.py"
```

第一条检查配置格式和字段关联。第二条检查自动执行前提，当前预期返回非零并列出阻塞；这不是结构错误。通过校验也不证明真实BOSS消息、附件动作或邮箱已经验收。

本次验证记录（2026-11-05）：22项配置校验测试全部通过；当前配置结构检查通过，`--check-ready`返回1，明确列出缺链接、待确认业务项、只读模式和未验收能力。此结果符合当前阶段预期，并未运行真实候选人筛选或发送动作。
