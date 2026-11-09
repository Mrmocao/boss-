# BOSS 招聘助手

第二个招聘账号：`npm run company2:login` 打开独立窗口，登录后使用 `npm run company2:status`。新账号为 `company-2`（19335端口），原 `company`（19334端口）继续保留。详见[账号隔离与登录](docs/company-login-and-session.md)。

2026-11-06 测试更新：完成25个离线模拟流程场景及真实BOSS列表采集（163条）；新增只读取配置的回放命令 `python -X utf8 scripts/replay_recruiting_workflow.py`。模拟发送/收件不等于真实全链路通过，详见[第一轮流程测试](docs/workflow-test-2026-11-06.md)。

2026-11-05 业务配置更新：已按用户提供的 `index.html` 整理[游戏执行策划流程](docs/game-execution-planner-workflow.md)，形成[岗位标准配置](config/jobs/game-execution-planner.yaml)与[独立话术](config/messages/game-execution-planner.yaml)。详见[配置填写与校验](docs/recruiting-configuration-guide.md)。该岗位不使用旧Unity教学要求；当前只读，附件和收件口径、固定链接尚待补齐。

当前提供专用 Chrome 接入和公司招聘沟通列表只读采集：滚动读取虚拟列表，导出本地 JSON、CSV 和岗位汇总。候选人聊天详情、自动回复、试题发送和 MCP 注册仍未实现。候选人会话详情、岗位识别和消息去重的下一阶段设计见 [整体设计文档](docs/boss-recruiting-copilot-design.md) 第 18～22 节；开源项目借鉴与自研路线见 [开源整合路线](docs/open-source-integration-and-roadmap.md)。

2026-10-30 已实测连接本机专用 Chrome，用户完成个人账号登录后，检测到 `JOBSEEKER_PAGE` 和 `login=ui_confirmed`。这只代表个人账号页面读取成功；公司招聘账号的 UI 核验见下一条更新。

2026-11-02 更新：公司专用配置已完成招聘端 UI 登录核验，当前会话列表可读（本次加载 40 行）。招聘端单会话详情、稳定消息 ID、发送与回执仍待适配；账号会话由独立 Chrome 目录持久化。

2026-11-02 采集更新：通过滚动虚拟列表读到 124 行、3 个列表岗位，直到页面显示“没有更多了”。这是当前筛选下近 30 天沟通联系人，不能等同正式投递人数或完整账号历史。详见 [只读采集验收](docs/boss-list-collection-validation.md)。

岗位规则配置初稿已建立：[岗位要求与聊天采集初稿](docs/job-requirements-draft.md) 和 [岗位模板填写表](docs/job-template-fillable.yaml)。当前三个岗位的要求只依据沟通列表中的岗位名称推断，待补充 BOSS 职位详情后批准版本。

## 采集沟通列表

已登录公司专用浏览器并进入沟通页后执行：

```powershell
npm run company:collect
# 多个 BOSS 标签页时先查看 ID，再明确选择：
node src/cli.mjs tabs --profile company
node src/cli.mjs collect --profile company --target <id> --max-steps 120
```

命令保留当前筛选，从顶部滚动采集后恢复原位置；不打开联系人、不填输入框、不发送消息。采集姓名、列表岗位、最后消息摘要、页面时间、未读徽标，并标注正式投递、简历和平台身份未知。到达次数/行数上限或加载停滞时明确报告范围不完整；账号、筛选或已选会话变化则停止且不保存本次结果。

输出到 `.local/collections/company/<显示名哈希>/`：`candidates.csv`、`summary.md`、`latest.json` 和 `snapshots/<内容哈希>.json`。相同快照不重复归档，不按姓名合并人员。当前账号显示名属于弱身份；更换同名账号前应隔离整个公司 profile，不能把目录哈希当平台账号 ID。`.local/` 与 `.runtime/` 均不能随项目或技能分发。

## 运行

公司正式账号请使用 `npm run company:login` 打开独立窗口，自行登录后运行 `npm run company:status`。公司目录为 `.runtime/company/chrome-profile`，默认端口 19334，与下面 personal 测试命令分开。详见 [公司登录与会话存储](docs/company-login-and-session.md)。

需要 Node.js 22+ 和 Google Chrome，无需安装 npm 依赖。在本项目目录执行：

```powershell
npm run doctor
npm run login
# 在打开的专用 Chrome 中自行登录 BOSS 招聘账号，然后执行：
npm run status
# 多个 BOSS 标签页时查看 ID：
node src/cli.mjs tabs
```

浏览器使用独立目录 `.runtime/chrome-profile`，本机端口默认 `19333`。登录资料留在本机 Chrome 用户目录；该目录已加入 `.gitignore`，不得作为技能附件分享。

`BOSS_CHROME_PATH` 可指定 Chrome 的绝对路径，`BOSS_CDP_PORT` 可更换端口。端口已占用时启动命令会停止，不会关闭其他程序。现有专用窗口可以直接执行 status。

status 输出 `RECRUITER_PAGE_DETECTED` 只代表识别到招聘端页面特征；真实账号、会话列表及消息内容仍需逐项验证。只读检查不发送消息、不点击会话、不标记候选人。

## 文档与测试

- 整体设计：`docs/boss-recruiting-copilot-design.md`
- 接入方案：`docs/boss-web-access.md`
- 验收记录：`docs/boss-connection-validation.md`
- 项目内技能草案：`skills/boss-recruiting-copilot/SKILL.md`
- 执行 `npm test` 运行离线及本机 mock 测试。

专用 Chrome 可以保留供后续登录验收。手动关闭窗口后连接不可用；下次运行 login 使用相同目录，是否还需登录由 BOSS 决定。
# 常驻监听试运行

新增第二账号策划岗位监听：`npm run monitor:start`；状态：`npm run monitor:status`；停止：`npm run monitor:stop`。
目前仅监听、保存和生成人工待办，**不会自动发消息**。公司模型待配置，虚拟列表覆盖仍不完整。
详见 [常驻监听说明](docs/continuous-monitor-guide.md) 和 [验证记录](docs/continuous-monitor-validation-2026-11-06.md)。
