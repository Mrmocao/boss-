# 项目协作入口

本项目是 BOSS 招聘辅助助手。处理招聘连接、会话或流程时，先读 `skills/boss-recruiting-copilot/SKILL.md`，按需读其 `references/connection.md`。

## 浏览器与跨对话恢复

- 先运行 `npm run browsers`（等价于 `node src/browser-registry-cli.mjs list`）查找已有专用浏览器，再运行 `npm run monitor:status`。不要默认使用 personal，不因当前对话无句柄或多个标签页就认为没有登录。
- 已知 profile：personal/19333、company/19334、company-2/19335。只用对应的专用配置，不复用日常 Chrome 或其他工具浏览器。
- 定位记录：各 profile 的 `.runtime/.../launch.json` 与 `browser-binding.json`。记录仅用于定位，操作前重新核验当前招聘账号与页面；不导出 Cookie/Token。
- 当前试运行配置：`config/monitor.json`。会话进度与回执：`.local/monitor/company-2/state.json`；阅读视图：同目录 `workbench.md`。这些文件包含本地数据，勿提交或打包。

## 修改与执行

- 规则来源为 `config/jobs/`、话术为 `config/messages/`；详见 `docs/recruiting-configuration-guide.md`。单候选人例外不改变全局筛选规则。
- 2026-11-10 用户授权持续自动 S1–S7 流程。统一服务使用 `service:start/status/stop`；自动发送由单一监听进程持有状态锁执行。最后一条来信停止满30秒才合并回复，模型调用期间新消息使旧结果失效。
- 薪资、异常、资料冲突、未知发送结果进入 S5 人工区。网页人工回复经命令队列交给唯一写进程发送；不绕过指纹、账号、输入框和回执核验。邮箱使用技能配置 mailboxes，试题直接文件发送使用 assessment.filePath（默认file模式）；缺少配置不伪造完成。
- 单次获授权发送前通过控制命令接管或停止后台，核对最新消息、已问问题和发送回执；后台持有状态锁时不得直接改写状态。
- 中文交流简洁自然，不主动自称 AI/机器人/招聘助手，不虚构真人身份或经历；被直接问身份时如实回答。
- 实现变更运行 `npm test`；真实浏览器验证单独说明，不宣称离线测试等于完整业务验收。

- 2026-11-13：人工接管10分钟未回复后重新核验并按规则恢复；保留草稿、身份、未知发送结果保护。超过3天无有效沟通及已确认拒绝/不符合要求移出本地活动列表，仅保留分类计数和去重审计，不删除BOSS聊天。

- 外部AI轮询使用独立19338端口/api/v1只读API，Bearer Token位于.local/automation-api.json，不输出凭据。快照需带新鲜度与运行状态，不将离线磁盘状态当实时正常；接口不授予发信或配置修改权限。
