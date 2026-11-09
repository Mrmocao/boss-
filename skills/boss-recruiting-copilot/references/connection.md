# 连接、定位与跨对话恢复

依赖 Node.js 22+ 和本机 Google Chrome，无 npm 外部依赖。全部命令在项目根目录执行。

## 先找已登录的专用浏览器

```powershell
npm run browsers
# 同一入口：
node src/browser-registry-cli.mjs list
npm run monitor:status
```

该入口只查询本项目三个已知专用配置及其中的 BOSS 标签页，不扫描任意端口或其他网站。根据结果选择明确的 profile，不默认使用 personal。

| 配置 | 默认端口 | 本地目录 |
|---|---|---|
| personal | 19333 | `.runtime/` |
| company | 19334 | `.runtime/company/` |
| company-2 | 19335 | `.runtime/company-2/` |

每个目录的 `launch.json` 记录该专用 Chrome 的 endpoint 和 profileDir；`browser-binding.json` 保存已核验的 profile、endpoint、账号显示名、targetId、页面路径和核验时间。Chrome 登录状态在其 `chrome-profile/` 子目录。连接记录不是 Cookie，不是鉴权凭据，也不证明现在仍登录；不得复制浏览器目录、导出 Cookie/Token 或复用 MJ/日常浏览器配置。

确认账号和页面后绑定，例如第二账号：

```powershell
node src/browser-registry-cli.mjs bind --profile company-2 --account "汪女士"
# 多个同账号沟通页仍有歧义时，使用 list 返回的明确 target ID：
node src/browser-registry-cli.mjs bind --profile company-2 --account "汪女士" --target "实际页面ID"
```

选择顺序为明确指定 target、已有有效绑定、唯一通过核验的招聘沟通页。每次都重新核验招聘导航和可见账号；多个同账号页面仍无法唯一选择时列出候选，不按第一项猜。旧 target 消失时，只可重绑到同一配置下唯一核验通过的页面；错误账号或显式 target 不匹配不能静默改选其他账号。

跨 Codex 对话无需继承内存里的浏览器句柄。读取上述文件并运行查询即可恢复定位；候选人工作进度还必须读取 `.local/monitor/company-2/state.json`。如果端口不可用或登录失效，再检查具体错误并让用户正常登录，不能把“多页面歧义”当作“未登录”。

## 环境检查、登录和列表采集

```powershell
node src/cli.mjs doctor --profile company-2
node src/cli.mjs login --profile company-2
node src/cli.mjs tabs --profile company-2
node src/cli.mjs status --profile company-2 --target "实际页面ID"
node src/cli.mjs collect --profile company-2 --target "实际页面ID"
```

只在确实需要登录时调用 login；扫码和验证码由用户本人操作，不在聊天索取。`PORT_IN_USE` 时先查看已有连接，不杀进程或反复启动。`BOSS_CHROME_PATH` 可指定 Chrome 路径；端口覆盖必须与对应 launch 记录匹配，不能混用账号。

`status` 输出分为浏览器连接、页面状态、招聘身份和列表信号。`RECRUITER_UI_CONFIRMED` 代表可见招聘导航和账号控件存在，仍不证明公司主体或稳定账号 ID。`JOBSEEKER_PAGE` 只是求职端，不能当招聘端。验证/登录控件出现时停止操作；普通候选人消息中的“登录”字样不应误判为账号退出。

`collect` 仅支持公司配置和招聘沟通页，滚动读取当前筛选，恢复原位置，不主动打开候选人；可用 `--max-steps 1..500`。返回的范围和 stopReason 决定能声称采集了多少。虚拟列表停滞、次数或行数上限只能报告部分覆盖。账号、筛选或行身份变化时丢弃本次采集。

采集输出在 `.local/collections/<profile>/<账号显示名哈希>/`，JSON 保留原文，CSV 处理公式开头。列表 `data-id` 语义未证明稳定；不得按姓名合并不同候选人，也不得将列表预览当完整消息。

## 常驻程序与单次跟进协调

```powershell
npm run monitor:start
npm run monitor:status
npm run monitor:pause
npm run monitor:resume
npm run monitor:stop
# 下列 ID 必须来自已核验会话：
npm run monitor:takeover -- "会话ID"
npm run monitor:resume-conversation -- "会话ID"
```

实际流程与限制见项目 `docs/continuous-monitor-guide.md`。当前后台模式是 observe_and_draft：监听、保存、模型待办/草稿；没有自动发送。running 仅表示进程在，responsive 和 health 才反映心跳与当前状态。CLI 控制请求有回执，排队不等于执行成功。

`.local/monitor/company-2/state.json` 是唯一写进程维护的状态，包含会话事实/证据、消息窗口、指纹、已问问题、人工接管、已发送意图和回执。`workbench.md` 是可读视图，`commands/receipts` 是控制队列。后台运行时不得由另一个脚本直接改写 state.json。

获得用户明确授权进行单次跟进时，先接管候选人或停止后台，确认控制完成，再读最新消息与发送记录。保留原账号隔离和已使用的补问次数。检测到人工草稿或人工输入时暂停；恢复必须显式进行。发送成功后记录正文与平台回执，发送结果不明时保留待核对状态，不按超时直接重发。

当前监听覆盖已渲染窗口，`topWindowObserved` 可说明是否在列表顶部，不能证明隐藏会话均已被扫描。电脑、Chrome 和后台进程需持续运行；不把十分钟定时任务当成实时回复机制。

## 验证

```powershell
npm test
python -X utf8 C:/Users/admin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/boss-recruiting-copilot
```

离线测试不登录或发送招聘消息。真实验证另外报告账号、读取范围、人工接管与发送回执，不用测试通过代替业务验收。
