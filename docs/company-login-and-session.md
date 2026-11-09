# 公司账号登录与会话存储

更新：2026-11-02。

本次验收：用户已自行完成公司招聘账号登录。真实页面为 `/web/chat/index`；可见招聘账号控件、职位管理、牛人管理及沟通导航，当前加载了 40 条会话列表行。独立 CLI 读取返回 `RECRUITER_UI_CONFIRMED`、`login=ui_confirmed`、`conversations=list_observed`。此处确认的是招聘端 UI 会话，不代表已核验公司法定主体或获得稳定账号 ID。未打开候选人会话或发送消息。

会话目录与脱敏检测记录已落地。已验证新 CLI 连接能复用当前浏览器会话；尚未关闭重启浏览器测试，不能承诺重启后永不过期。网站 Cookie 的保存和失效以 Chrome/BOSS 实际行为为准。

## 登录步骤

在项目根目录执行 `npm run company:login`，会打开独立 Chrome 窗口，网址为 `https://www.zhipin.com/web/user/?intent=1`。使用公司招聘账号自行扫码或输入验证码，完成网站要求的验证，然后进入招聘端“沟通”页面。

登录完成后执行 `npm run company:status`。`RECRUITER_UI_CONFIRMED` 表示实测招聘导航与账号控件共同成立；仅 `profile=company` 不能证明账号身份。公司归属和稳定账号标识仍需业务适配。出现求职端、登录/验证提示或身份不明时暂停业务流程。

如果窗口已打开，直接使用该窗口并执行 status；不要反复启动。窗口关闭后重新执行 company:login，Chrome 会复用同一个用户目录。BOSS 决定会话是否仍有效；不保证免登录或永久有效。

## 本地保存内容

| 内容 | 位置 | 用途 |
|---|---|---|
| 公司浏览器登录状态 | `.runtime/company/chrome-profile/` | Chrome 自行持久化网站 Cookie 等会话数据 |
| 公司启动记录 | `.runtime/company/launch.json` | 记录专用目录、端口、启动时间和进程号，不保存凭据 |
| 最近一次公司检测结果 | `.runtime/company/session-status.json` | 检测时间、页面路径与状态；不含聊天正文或 URL 查询参数 |
| 个人测试账号目录 | `.runtime/chrome-profile/` | 保持独立，不复制到公司目录 |

公司默认端口为 `127.0.0.1:19334`，个人为 `127.0.0.1:19333`。公司/个人默认端口不能互换；启动记录不匹配时，读取命令会停止。记录匹配仅说明配置相符，不证明真实账号身份或历史会话仍有效。

项目不单独建立密码、Cookie 或 Token 配置文件，不导出浏览器认证信息。网站会话由本机 Chrome 管理；不能因此把整个目录当成普通无敏感信息文件。`.runtime/` 已加入 `.gitignore`；复制整个项目目录、网盘同步或打包时仍须排除此目录，gitignore 不会阻止这些操作。不要上传该目录或在其他电脑复用；迁移电脑时重新登录。

本地调试端口仅绑定回环地址，已实测监听 `127.0.0.1`。同机有权限的进程仍可能访问它；关闭该专用 Chrome 可停止当前调试访问，但不会主动注销服务器上的会话。未额外更改 Windows 权限或开启远程端口。

## 鉴权与操作授权

- 网站鉴权由 BOSS 与 Chrome 会话共同完成，本程序没有独立官方 API Key。
- 登录成功不意味着同意自动发送消息、做筛选决定或共享简历；这些操作沿用用户明确授权的业务范围。
- 状态文件是历史诊断，不是凭据，也不是执行许可；每次运行重新读取当前页面。
- 账号切换需要重新确认账号和招聘身份，后续消息队列与候选人数据按账号隔离。本轮尚未实现稳定账号 ID 的提取与业务队列。
- 需要撤销登录时，由用户在专用 Chrome 中退出 BOSS；必要时在 BOSS 官方账号设置管理登录设备。仅删除本地状态快照不会撤销服务器会话。

## 常用命令

```powershell
npm run company:doctor
npm run company:login
npm run company:status
node src/cli.mjs tabs --profile company
# 多个 BOSS 标签页时指定一个实际返回的 ID
node src/cli.mjs status --profile company --target <id>
```

`npm run login/status` 仍用于原 personal 配置。正式账号始终使用带 company 的命令，避免用个人账号调试结果代替公司账号验收。

## 第二个招聘账号（2026-11-06）

已新增独立配置 `company-2`。原账号继续使用 `company`；新账号必须在新开的专用窗口自行登录，两个窗口可以同时保留，不退出或复用原账号目录。

| 配置 | 默认本机端口 | 浏览器会话目录 | 数据目录 |
|---|---|---|---|
| personal | 19333 | `.runtime/chrome-profile` | `.local/collections/personal` |
| company | 19334 | `.runtime/company/chrome-profile` | `.local/collections/company` |
| company-2 | 19335 | `.runtime/company-2/chrome-profile` | `.local/collections/company-2` |

三个默认端口不能跨配置使用。新账号的启动记录和脱敏状态放在 `.runtime/company-2/`；登录信息仍由Chrome保存，不导出Cookie或复制其他账号目录。同名招聘员在不同profile下的采集数据也分别保存。

```powershell
npm run company2:doctor
npm run company2:login
# 自行登录新账号，进入招聘端沟通页后：
npm run company2:status
node src/cli.mjs tabs --profile company-2
# 用户要求采集这个账号时再执行：
npm run company2:collect
```

只运行login不代表已经登录成功。下一步仍需核验新账号招聘UI、岗位和候选人范围；不会自动把原账号的岗位绑定或处理状态迁入新账号。`company2:*`是npm命令名称，底层profile拼写是`company-2`。

### 第二账号只读验收（2026-11-06）

用户确认登录后，`company2:status`返回`RECRUITER_UI_CONFIRMED`、`login=ui_confirmed`及`conversations=list_observed`。随后在“全部/全部职位/全部”筛选下采集近30天149条沟通记录，全部显示“数值策划”，到达“没有更多了”并恢复原滚动位置。未打开联系人、未发送消息、未操作附件。

输出保存于 `.local/collections/company-2/3422e241a18e8e12/`，与原company数据隔离。仍未在该账号本次沟通列表中观察到“游戏执行策划”；这不证明该职位未发布，也不授权将数值策划映射至独立的游戏执行策划规则。账号核验仍限招聘UI与显示名，稳定平台账号ID未验证。
