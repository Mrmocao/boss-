# 本机服务入口

项目 `C:/project/招聘辅助助手/boss-`；统一入口 `C:/project/招聘辅助助手/boss-local.ps1`。

```powershell
$runner = 'C:/project/招聘辅助助手/boss-local.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $runner service:start
powershell -NoProfile -ExecutionPolicy Bypass -File $runner service:status
powershell -NoProfile -ExecutionPolicy Bypass -File $runner service:stop
```

工作台：http://127.0.0.1:19336/ 。服务持续运行观察器、流程处理和邮箱轮询；网页包含S5人工回复区、候选人状态、材料收件与桌面通知入口。关闭网页不停止服务。没有注册Windows开机任务。

模型和邮箱直接填技能目录config.json，不需要环境变量。保留原model参数；assessment.filePath指定本地试题，默认直接文件模式，无需填写assessment.url；mailboxes可添加多个IMAP TLS账号，填写host/username/password后enabled设true。尚未接入OAuth授权；可使用邮箱支持的应用密码或授权码。凭据不要发到聊天，也不要打印完整配置。

本机Python为 `C:/project/招聘辅助助手/.tools/python/python.exe`，Node为 `C:/Program Files/nodejs/node.exe`。无额外npm依赖，Python使用已有PyYAML和标准库。邮箱每60秒轮询一轮，每个账号独立缓存、UID去重；自动收齐条件见项目 `docs/continuous-monitor-guide.md`。

任务 `model:check` 检查模型参数和试题可读性；`browsers` 查专用浏览器；`monitor:status` 查业务进程。全局暂停/恢复和人工接管可在网页操作。旧独立看板或监听占用端口/锁时先核实来源再停止，不关闭其他工具的进程。

更新代码或技能时保留config.json和本机路径适配，不覆盖用户密钥。`.local/`、`.runtime/`是本机数据，不打包。

普通QQ发件账号另填mail-sender.json：SMTP smtp.qq.com:465，用户名/fromAddress为自己的完整QQ邮箱，password为授权码，toAddress为hr-rpg@youkia.net；不要将SMTP参数写进mailboxes。
