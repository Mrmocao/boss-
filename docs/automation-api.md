# 外部 AI 只读集成 API v1

此入口供部署后的 AI 定时读取运行信息，不授予发信、候选人回复、解除接管、配置修改等执行权限。它与本地工作台19336端口分开，默认监听127.0.0.1:19338。

## 初始化与启动

```powershell
$runner = 'C:/project/招聘辅助助手/boss-local.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $runner api:init
powershell -NoProfile -ExecutionPolicy Bypass -File $runner service:stop
powershell -NoProfile -ExecutionPolicy Bypass -File $runner service:start
powershell -NoProfile -ExecutionPolicy Bypass -File $runner service:status
```

`api:init`在项目`.local/automation-api.json`生成随机token，不打印它；重复运行保留已有值。该文件已被Git忽略。部署到别的机器应重新生成独立token，通过部署环境的凭据存储交给调用方，不写入提示词或日志。

配置字段：enabled、host（当前固定127.0.0.1）、port（默认19338）、token。更新token/关闭enabled每个请求生效；端口调整或从禁用启用需重启服务。web工作台没有读取token的API。

所有请求必须包含：

```http
Authorization: Bearer <独立的AI只读token>
Accept: application/json
```

不接受URL查询参数中的token。HTTP方法仅GET，不接受浏览器Origin、不启用CORS。认证成功后的请求限制为全局每分钟120次；建议AI每30–60秒拉取一次总览。

## 路由

| GET路由 | 内容 |
|---|---|
| `/api/v1/snapshot` | 单次一致快照：运行健康、集成状态、统计、人工介入汇总、覆盖范围 |
| `/api/v1/health` | API可用性、守护与业务进程活性、心跳、暂停、数据新鲜度 |
| `/api/v1/integrations` | 平台/账号状态、模型配置状态、问卷有效期、邮箱轮询状态、通知渠道 |
| `/api/v1/statistics` | 今日/昨日新增、当前沟通、待回复、人工、待批改、移除分类、发送回执计数 |
| `/api/v1/handoffs?limit=50&cursor=…` | 人工/配置待办元数据：类别、时间、草稿占用、排队状态、下次自动回检时间 |
| `/api/v1/conversations?limit=50&cursor=…` | 活动会话元数据：平台、账号、匿名会话标识、阶段、最后消息方向等 |
| `/api/v1/openapi.json` | OpenAPI 3.1机器可读描述（同样要求认证） |

当前真正接入的招聘平台为boss，账号为company-2；platformId/accountId是后续多平台接入的稳定分层。`conversationRef`是平台、账号、会话ID的哈希，不按姓名关联。被移除会话不出现在明细，仅计入归档总数。

人工类别：policy_question、qualification_review、identity_or_history、delivery_verification、assessment_or_attachment、model_error、manual_takeover、needs_review。自由文本原因可能含候选人资料，因此此API仅提供类别；需要具体对话的人工用户通过本地工作台查看。

## 响应与数据新鲜度

成功统一结构：

```json
{
  "apiVersion": "v1",
  "requestId": "请求追踪UUID",
  "generatedAt": "2026-11-16T02:00:00.000Z",
  "snapshotRevision": "当前返回数据的SHA256版本",
  "freshness": {
    "stateAvailable": true,
    "stale": false,
    "lastObservationAt": "2026-11-16T01:59:59.000Z"
  },
  "data": {}
}
```

时间戳为ISO 8601 UTC；统计日界为Asia/Shanghai。`autoReviewAt`为Unix毫秒，其他At字段为ISO字符串或null。读取API不会触发BOSS扫描、标为已读、模型调用、邮箱收件或任何发送。

`generatedAt`仅为API返回时间，**不能据此认定业务数据实时**。进程退出、心跳超过90秒、观察数据超过90秒或观察时间缺失时，会标为stale。守护心跳使用20秒阈值。后台进程存在不代表网页连接成功：必须检查`service.automaticProcessingActive`和平台account.connected。`reportedHealth`保留磁盘原状态，但`health`在进程死亡时返回stopped。

模型的`configurationReady`仅表示字段配置就绪，连接状态明确为not_probed_by_api；API不会消耗模型调用额度。邮箱最近检查超过180秒标stale，即使原记录写connected也不能当作当前成功。问卷有效期按当前时间计算，过期返回link_expired。SMTP、钉钉不会因保存参数而被标为已连通。

首次启动无state文件：HTTP200且stateAvailable=false/stale=true。文件损坏或读取失败：HTTP503 STATE_UNAVAILABLE。整个服务未运行时连接失败，AI需在自己的监控端报告不可达，不能继续引用上次响应为正常。

## 分页与轮询

limit为1–100，默认50。返回items、total、listRevision、nextCursor。继续请求时原样携带nextCursor。数据在翻页期间改变返回409 SNAPSHOT_CHANGED，客户端从第一页重新读取并按conversationRef去重；该游标不是历史事件偏移，不保证全量事件投递。

响应含ETag。请求可发送`If-None-Match`，未变化返回304且无正文。心跳本身是状态变化，不能期待所有轮询都返回304。API不存无限历史事件；如需要长期趋势，由调用方按日期和标识存自己的快照。

错误响应：`{apiVersion,requestId,error:{code}}`。401缺失或错误token；403浏览器Origin；405非GET；400参数错误；409分页状态变更；429频率超限（Retry-After:60）；503禁用、配置不可读或状态不可用；500内部错误。错误正文不会包含底层异常、路径或密钥。

## 调用示例

```powershell
# 本机读取默认配置；只输出脱敏响应，不输出token
powershell -NoProfile -ExecutionPolicy Bypass -File C:/project/招聘辅助助手/boss-local.ps1 python scripts/poll-automation-api.py

# 部署后访问HTTPS反向代理，凭据文件在调用端本机
python scripts/poll-automation-api.py --base-url https://recruiting-api.example.org --config /secure/automation-api.json --etag-file /var/tmp/recruit-api.etag
```

Python示例每次运行只拉取一次，可接入已有定时器；不自动创建定时任务。示例拒绝远程明文HTTP及重定向，以免把Authorization发到别的站点。

## 部署入口

本次仅在本机开启，不对公网发布。远程部署使用同机反向代理终止TLS，并**仅转发独立19338端口的`/api/v1/`**，不要把19336的网页配置/命令端口一起公开。示例：

```nginx
location /api/v1/ {
    proxy_pass http://127.0.0.1:19338;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host 127.0.0.1:19338;
    proxy_read_timeout 15s;
}
location / { return 404; }
```

上层server需要配置有效TLS证书。保留客户端Origin头，API拒绝浏览器跨站调用；不要记录Authorization。反向代理可再限制来源IP、并发和认证失败频率。本机监听不依赖外部Host头，所以无需修改代码为公网域名；它不提供修改接口。

## 统计口径和隐私范围

新增是系统首次纳入时间，不是平台投递；历史未知日期不推测。统计沿用工作台当前活动记录和保留的归档计数，不能作为完整长期招聘报表。收齐材料不表示评分或真实性审核已完成。

默认不返回候选人姓名、岗位自由文本、对话正文、模型草稿、教育资料、邮箱地址、附件名/路径、签名下载地址、模型密钥、SMTP/IMAP凭据和控制token。外部AI只能据此做运行监控、汇总和待办分类；如后续要执行操作，必须另行设计受控写入接口，不能复用这个只读token。

## 工作台复制接入提示词

打开 http://127.0.0.1:19336/#ai-access ，选择AI与平台同机运行或异机运行，填写API基础地址和调用端本地凭据路径，点击“复制接入提示词”。可粘贴给CC Connect等具备命令/HTTP能力的AI工具。异机使用HTTPS反向代理地址，127.0.0.1只表示调用方自身。页面不包含Token；外部工具从本机文件读取并构造Authorization头。默认先做一次真实查询，定时任务需另由工具实际创建。复制成功不代表已经连接或启动巡检。

巡检提示词按账号保存基线，正常且无变化时静默。调用端通过已绑定的钉钉目标汇报新增变化和异常恢复。收到负责人针对具体会话的发送指令后，可在本机工作台的人工待办按账号和 conversationRef 核对记录并发送，最终以会话发送回执为准。
