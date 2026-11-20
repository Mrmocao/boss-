# 连接与服务恢复

本机使用 C:/project/招聘辅助助手/boss-，统一入口 C:/project/招聘辅助助手/boss-local.ps1。

先执行 browsers 和 service:status、monitor:status，复用已登记的company-2专用浏览器，不因对话没有句柄而重新登录。personal/19333、company/19334、company-2/19335；各自的launch.json和browser-binding.json只是定位线索，操作前仍核验实时招聘账号。不能复用日常浏览器或导出Cookie。

统一服务 service:start/status/stop 管理网页、监听与邮箱轮询；网页 http://127.0.0.1:19336/ 提供人工区、暂停/恢复和通知。自动模式已经按用户2026-11-10要求启用。最后来信满30秒后合并处理，人工接管和未知发送结果不会因重启解除。

详细业务与安装说明见项目 docs/continuous-monitor-guide.md。config.json直接配置模型、assessment.filePath和mailboxes；凭据不要打印到日志。没有文件发送控件或邮箱凭据时显示待处理，不冒充真实发送或收件。

候选人进度在 .local/monitor/company-2/state.json，由唯一后台进程写入；其他工具通过命令队列操作，不能直接改写。工作台 workbench.md 是只读视图。列表滚动扫描报告实际覆盖，关键身份或历史缺失时转人工。
