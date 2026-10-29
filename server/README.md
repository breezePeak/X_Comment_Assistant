# 热点帖子服务

现有 GPT bot 负责定时搜索热点、生成正文和配图，然后调用本服务入库。插件负责浏览、复制、保存配图，以及在你发布成功后标记已消费。本服务不调用模型、不调度 bot、不自动发布 X。

本服务也保存插件自动采集的本人帖子与互动数据。浏览自己的 X 主页并滚动时，插件只上传本人发布的帖子（含本人引用帖），相同数据不重复更新；记录按账号与帖子 ID 保存在 SQLite `own_posts` 表，重装插件后可以重新读取。

## 部署

### Windows 系统服务（开机自启）

在**管理员 PowerShell** 中执行一次（需要 Node.js 24+）：

```powershell
cd D:\my_project\X_Comment_Assistant
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server\install-service.ps1
```

安装脚本使用 [WinSW 2.12.0](https://github.com/winsw/winsw/releases/tag/v2.12.0)（首次安装从官方地址下载并校验 SHA256），将服务注册为 `XCommentAssistant`，开机自动启动，异常退出后 10 秒重启。服务使用低权限 LocalService 账户，仅监听 `127.0.0.1:12345`；沿用 `server/data/posts.sqlite`，不会删除数据。安装时会停止本目录原有的手动启动进程，重复执行会更新并重启服务。如果系统有多个 Node.js 版本，可追加 `-NodePath 'C:\path\to\node.exe'` 指定 24+ 版本。

运行文件保存在 `server/data/windows-service`，包含独立的 Node.js 副本，不依赖登录后的 PATH；升级 Node.js 时重新运行安装脚本。日志为 `server/data/XCommentAssistant.out.log`、`XCommentAssistant.err.log` 和 `XCommentAssistant.wrapper.log`，输出日志每个约 10 MiB 轮转，保留 3 份。安装后请保留项目路径和 `server/data`。

日常管理（管理员 PowerShell）：

```powershell
Get-Service XCommentAssistant
Restart-Service XCommentAssistant  # 更新服务端代码后执行
Stop-Service XCommentAssistant
# 卸载服务，保留数据库和运行文件：
& .\server\data\windows-service\XCommentAssistant.exe uninstall
```

### 本地一键启动（手动备用）

Windows 双击本目录的 **`启动本地服务.cmd`**。需要 Node.js 24+，无需 Docker、Token、配置文件或 npm 安装。服务后台运行，重复双击会识别已有服务。

- 地址：`http://127.0.0.1:12345`，仅监听本机。
- 数据库：本目录下 `data/posts.sqlite`，与插件存储分开；卸载插件不会删除它。保留整个 `data` 文件夹即可保留数据。
- 插件：重新加载扩展并刷新 X，默认自动连接。之前配置过远程地址时，在设置中点击「使用本地默认」。
- 日志：`data/service.log`、`data/service-error.log`。

本地模式无 Token，会检查请求的回环地址、Host 和 Origin，拒绝普通外部网站直接调用。命令行也可在本目录执行 `node server.mjs --local`。本地模式忽略远程监听和数据库环境变量，始终使用本机 12345 端口及本目录数据库。

### 可选：远程 Docker Compose

只需上传本 `server` 文件夹到服务器，例如 `/opt/server`，无需上传插件和其他项目文件。服务器需要已安装 Docker Compose，然后执行：

```sh
cd /opt/server
test -f .env || printf 'POSTS_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d --build
curl --fail http://127.0.0.1:12345/healthz
cat .env
```

服务器安全组/防火墙放行 TCP **12345**。插件服务地址填 **`http://服务器IP:12345`**，Token 填 `.env` 中 `POSTS_API_TOKEN=` 后面的值。Docker 对外发布 12345，容器内部使用 8787。HTTP 会明文传输 Token 和帖子数据；需要限制访问时可在安全组只放行自己的 IP。

容器以非 root 用户运行，数据放在 `posts-data` 命名卷；重建镜像不会删除数据。不要使用 `docker compose down -v`，它会删除数据卷。可选的 HTTPS 反向代理示例见 [nginx.example.conf](nginx.example.conf)。

升级时覆盖此文件夹中的程序文件，保留原 `.env`，在同一目录运行 `docker compose up -d --build`；启动时自动创建 `own_posts` 表，保留原有热点帖子与数据卷。服务端所有运行依赖均在此文件夹中。

### 直接运行

本机直接执行 `node server.mjs --local` 即可。下面是保留的远程 Token 模式：在本文件夹创建 `.env` 并填写随机 Token，然后执行（无需 npm）：

```sh
node --env-file=.env server.mjs
```

环境变量：

| 变量 | 默认值 / 说明 |
| --- | --- |
| `POSTS_API_TOKEN` | 必填，32—256 位非空格 ASCII；建议使用上面的 64 位随机十六进制值。 |
| `HOST` | `127.0.0.1`，Docker 镜像中为 `0.0.0.0`。 |
| `PORT` | `8787`。 |
| `DATABASE_PATH` | `./data/posts.sqlite`，相对于启动工作目录；Docker 中为 `/app/data/posts.sqlite`。 |

备份时先停止服务，再复制整个数据目录（包括 SQLite 的 WAL 文件）。本版本是单人共用帖子池；所有使用同一服务的插件共享消费状态。

## 鉴权

本地模式无需鉴权头。以下要求仅适用于远程 Token 模式，除 `GET /healthz` 外，所有接口（包括图片）都要求请求头：

```http
Authorization: Bearer <POSTS_API_TOKEN>
```

缺少或错误的 Token 返回 `401`。密钥不接受 URL 查询参数，不内置在插件或代码里，也不打印到日志。只把 Token 配置到可信 bot 和插件中；Token 持有者有读取、入库和修改消费状态的权限，也可以读取和更新所有已上传账号的本人帖子数据。账号字段用于分组，不是多用户权限隔离；服务端依赖可信插件报告作者身份，不验证 X 登录会话。公网使用 HTTPS；泄漏后更换服务端 Token、重启服务，并更新 bot 和插件配置。

请求体上限 30 MiB，每张上传图片上限 5 MiB，每条帖子 1—4 张图片。附带的 Nginx 示例还提供按 IP 限流；Token 用于防止未授权写入，网络流量攻击需在反向代理或主机防火墙处理。

## GPT bot 调用

### POST /api/posts

**请求方式：**`POST`  
**接口路径：**`/api/posts`  
**请求头：**`Authorization: Bearer <POSTS_API_TOKEN>`、`Content-Type: application/json`

**请求参数（JSON）：**

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `externalId` | string | 是 | 帖子唯一 ID |
| `title` | string | 否 | 标题 |
| `text` | string | 是 | 帖子正文 |
| `images` | array | 是 | 图片列表；每项包含 `url`，或 `mimeType` 与 `base64`；可包含 `alt` |
| `sources` | array | 否 | 来源列表；每项包含 `title`、`url` |

### 其他接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/posts` | 默认只返回未消费帖子，最新入库优先，每页默认 20 条。 |
| `GET /api/posts?status=all` | 包含已消费帖子；`status=consumed` 只看已消费。 |
| `GET /api/posts?limit=20&before=123` | 游标分页，limit 为 1—50，before 使用上一页的 nextCursor。 |
| `POST /api/posts/:id/consume` | `{"consumed":true}` 标记；`{"consumed":false}` 恢复。重复标记保留首次消费时间。 |
| `GET /api/posts/:id/images/:index` | 带 Token 获取已上传图片，index 从 0 开始；外部图片链接不提供代理。 |

列表返回 `{"posts":[...],"nextCursor":123}`，没有下一页时 `nextCursor` 为 null。帖子包含 `id`、`externalId`、`title`、`text`、`sources`、`images`、`createdAt` 和 `consumedAt`；消费前 `consumedAt` 为 null。时间为 UTC ISO 字符串，插件按浏览器本地时区显示。图片元数据包含 `url`（外部图片）或 `path`（本服务上传图片）；列表不返回 Base64。

常见错误：`400` 参数错误、`401` 密钥错误、`404` 不存在、`409` externalId 冲突、`413` 请求过大、`415` 非 application/json。流式超大请求可能直接中断连接。

## 本人帖子数据接口

- `POST /api/analytics/posts`：提交 `{ "owner": "小写账号", "posts": [...] }`，每批 1—100 条。字段与插件 JSON 导出的 `posts` 相同，包括字符串 ID、同账号帖子 URL、正文/引用文字、UTC 发布时间及采集时间、媒体与截断标记、`metrics`、`metricLabels`。`metrics` 的浏览/赞/回复/转帖/收藏分别为 `views/likes/replies/reposts/bookmarks`，值为非负整数或 `null`。整批校验后事务提交，返回 `{ "accepted": 条数 }`。
- `GET /api/analytics/posts?owner=账号&limit=100&before=游标`：按入库顺序分页，`limit` 为 1—100，返回 `{ "owner": "账号", "posts": [...], "nextCursor": 数字或null }`。第一批无需 `before`，下一页使用上次返回的游标。

本地模式不使用 Token，远程模式两者均使用同一个 Bearer Token。按「owner + 帖子 ID」唯一保存最新快照，重复上传幂等；指标或正文变化才更新，旧采集时间的快照不能覆盖新快照；已展开正文不会被后续缩略正文覆盖。仅保存最近快照，不记录每次互动变化历史。

插件先保存本机待上传队列，再自动分批上传；成功入库才移除对应待上传标记，网络失败或服务未升级时每分钟重试。新版本插件需要配套升级服务端，否则会收到 `404` 并保留待上传数据。卸载插件前确认已上传；SQLite 文件和 Docker 数据卷损坏/删除仍会导致服务端记录丢失，请保留备份。

## 插件连接与使用

1. 双击「启动本地服务.cmd」，重新加载扩展并刷新 X，默认连接本机，无需 Token。
2. 之前用过远程地址时，打开齿轮设置，找到“热点帖子服务与本人数据”，点击「使用本地默认」。远程服务仍可填写自定义地址及 Token；评论 AI 配置可以留空。
3. 侧边栏切换“热点帖子”，点击刷新；可查看正文、配图和来源，修改正文后复制，保存图片，再点击“去 X 发帖”。
4. 在 X 粘贴正文并添加图片，自行发布。**确认发布成功后**，回插件点击“我已发布”，标记成功才隐藏该帖。
5. 勾选“显示已消费”可以查看历史，点击“恢复待发布”可撤销误标记。断网或鉴权失败时不会在本地伪装成已消费。

复制、保存图片或打开 X 不会消耗帖子。插件不监控 X 的发布结果；编辑只用于当前复制，刷新会恢复服务端原文。配置存于扩展的本机存储，仅扩展页面可以读取；密钥不会传给 X 或外部图片网站。外部图片站点仍会收到浏览器的普通图片请求。

## 验证

项目根目录运行 `npm test`，覆盖原有评论逻辑与服务端鉴权、去重、图片、状态、分页、重启持久化和输入边界。`tests/browser.cjs` 的浏览器回归还覆盖热点列表和设置交互，需要本机 Playwright 与 Chrome。

### 原创曝光历史

- `POST /api/analytics/impressions`：提交 `{ "owner": "me", "value": 23600, "raw": "23.6K", "collectedAt": "2026-10-29T01:00:00Z" }`。未提供 `date` 时，按北京时间 10:00 切日生成数据日期（此前归昨天）；数值变化时新增或更新同日记录。`date` 可显式传入有效的 YYYY-MM-DD 日期；`source: "manual"` 表示手动补录，允许修正历史且不被同日自动采集覆盖。旧采集时间不能覆盖较新的记录。返回 `{ "accepted": 1 }`（包括已记录或无需新增的幂等请求）。
- `GET /api/analytics/impressions?owner=me`：返回 `{ "owner": "me", "impressions": [...] }`，日期倒序。每条包含 `owner/date/value/raw/collectedAt`。沿用现有鉴权与本地服务访问限制。
- 服务启动自动创建 `original_impressions` 表，保留原有数据库。更新并重启服务后生效。
