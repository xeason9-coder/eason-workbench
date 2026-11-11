# Eason 工作台多用户部署交接

此文档约定 0.3.0 独立认证、客户归属及 AI 额度。后端已接入所有工作台入口；部署前仍须在目标服务器完成下面的隔离检查，不能仅凭离线测试通过就上线。

## 模块接口

`core/workbench_auth.py` 不导入 `core.workbench`，独立使用 `desk_users`、`desk_sessions`、`desk_login_attempts`、`desk_ai_usage` 表，不复用旧 WeRSS 的 `users` 表。

- 启动时调用 `init_auth_tables()`，复用 `DB.get_engine()`；认证启用时必须关闭 `debug` 和 SQL echo，防止共享数据库调试钩子记录敏感参数。
- 将 `router` 挂到主 FastAPI 应用，避免继承旧的 `local_only` dependency。三个地址为 `POST /workbench/api/auth/login`、`POST /workbench/api/auth/logout`、`GET /workbench/api/auth/session`。
- 登录 JSON 为 `{"username":"...","password":"..."}`。登录和会话返回 `{"authenticated":true,"user":{"id":"...","username":"...","role":"admin|user"}}`；匿名、过期、停用返回 401；登出返回 `{"authenticated":false}`。不返回密码、哈希或会话 token JSON。
- 业务 API 使用 `Depends(get_current_user)`，管理接口用 `Depends(require_admin)`；返回冻结的 `Principal(id, username, role)`。`id` 是 32 位 UUID 字符串，适合作为 `owner_id`。
- 后台任务和迁移可调用 `get_user_by_username(username)` / `get_user_by_id(user_id)`，只返回 active 用户的 Principal 或 None。不包含密码哈希。
- 每次用户触发 AI 操作，在校验输入和资源归属后、第一次模型调用前执行 `usage_id = reserve_ai_usage(user, "chat")`；一次多轮工具调用只 reserve 一次。结束后调用 `finish_ai_usage(usage_id, success=True/False)`。入口收到 429 时不得调用模型。
- reserved / succeeded / failed 都占一次当天额度，失败不返还；进程中断保留 reserved，避免故障重试绕过限制。这是“用户操作次数”限制，不是模型 token 账单。用户输入校验失败应在 reserve 前返回。
- 普通用户不能通过更换客户或 AI 操作种类取得新额度。管理员默认每日无限，但仍记录次数。最短间隔只限制 chat 等交互调用；批量关键词逐篇扣每日额度，不受交互间隔限制。命中公共正文主题词缓存无需重复调用模型，也不重复扣额；额度不足停止后续标签生成，不撤销已采集文章。

## 环境变量及请求边界

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EASON_PUBLIC_ORIGIN` | 空 | 公网必须配置单一 HTTPS origin，如 `https://desk.example.com`，无路径；为空只允许 loopback 客户端及 Host |
| `EASON_SESSION_HOURS` | `12` | 固定会话有效期，正整数，不滑动续期 |
| `EASON_USER_DAILY_AI_LIMIT` | `30` | 普通用户每日操作上限，正整数 |
| `EASON_ADMIN_DAILY_AI_LIMIT` | `0` | 管理员每日上限；0 为无限 |
| `EASON_USER_AI_MIN_INTERVAL` | `10` | 所有角色交互 AI 操作之间最短秒数；批量关键词除外；0 关闭间隔限制 |
| `EASON_WORKBENCH_ONLY` | `1` | 默认仅允许工作台路由，根路径跳转；试用公网必须保持1，不能设0开放旧无租户入口 |

每日以北京时间（UTC+8，无夏令时）零点划分。登录按直连客户端 IP 和规范化用户名分别限制每 5 分钟 20 次尝试，失败提示相同，不透露账号是否存在；计数持久化，不因重启清零。模块不自行读取 `X-Forwarded-*`。反向代理/ASGI 的可信代理配置必须限制在本机或明确代理 IP，不能信任任意公网来源；否则客户端 IP 可能被伪造。未配置可信代理时，同一个代理下的用户会共用 IP 限额。

Cookie 名称 `eason_session`，path `/workbench`，HttpOnly、SameSite=Lax，公网 Secure。数据库仅保存高熵 token 的 SHA256。写请求包括登录/退出均要求精确匹配的 `Origin` 和 `X-Workbench: 1`；公网 Host 必须匹配配置域名，反向代理应保留 Host。本地测试也需设置匹配 Origin。

健康检查应是独立公开 `/workbench/healthz`，只返回服务状态，不返回用户/客户/数据库内容。不要因健康检查需要而放宽业务路由认证。代理应限制请求体大小（登录最多 4096 字节被接受），不要记录 Cookie、Authorization、登录请求体或环境变量。

## 初始化账号

在项目根目录、与服务使用同一个数据库配置及 Python 环境执行。没有预置账号密码，也没有注册入口。

```powershell
.\.venv\Scripts\python.exe -X utf8 tools/workbench_users.py --username eason --role admin
.\.venv\Scripts\python.exe -X utf8 tools/workbench_users.py --username manager --role user
```

命令交互隐藏输入及确认密码，要求 12–72 个 UTF-8 字节（bcrypt 的长度限制）。自动化可由部署密钥管理器注入独立环境变量后，传 `--password-env EASON_BOOTSTRAP_PASSWORD`；参数只放环境变量名，不能把密码写进命令行、脚本、Git 或交接记录。用后从部署会话移除该初始化变量。

同名账号默认报错，不重置密码或角色。明确需要时加 `--reset-password`，该操作也按 `--role` 更新角色，并撤销该账号所有已登录会话；停用账号不会因此自动重新激活。命令只输出 user_id、username、role（认领时另输出迁移计数和备份路径）。

## 旧库升级与归属认领

先在云库副本验证，正式升级时停止应用和采集进程，保留原库、配置及凭据目录备份后执行。不要在旧版本进程仍运行时重建表或赋予归属。本地已完成副本演练与真实迁移；云端须用自己的备份和账号独立验收。

```powershell
# Windows：新建管理员并明确认领未归属旧数据；密码隐藏输入。
.\.venv\Scripts\python.exe -X utf8 tools/workbench_users.py --username eason --role admin --claim-existing
```

```bash
# Linux：在项目根目录、服务同一配置和虚拟环境下执行。
.venv/bin/python tools/workbench_users.py --username eason --role admin --claim-existing
```

若 eason 已是有效管理员，该认领命令不重置密码，不要求重新输入密码；`--claim-existing` 不允许给普通用户，也不会转移已有 owner 的客户或日志。单独调用 `migrate_workbench_owners(admin_id)` 具有同样约束。新普通账号不会自动生成 PMI 或获得历史客户。

`init_workbench()` 先初始化 auth 表，再检查业务结构。旧版客户表的全局 name 唯一约束会改为 `(owner_id, name)`；不同账号可使用相同客户名，同账号仍不能重名。首次 SQLite 结构升级先生成一致性备份 `<数据库名>.workbench-backup-<时间>-<随机后缀>`（含敏感数据，权限600），再以 `BEGIN IMMEDIATE` 原子重建客户表并添加日志 owner 列。遇到未知客户字段则停止，不静默丢弃。Source、Selection、ArticleTopics、同步起止时间和历史结果保留；启动时遗留 running 任务会标记 interrupted。

未显式认领的旧数据 owner 留空，任何账号包括管理员均不能通过工作台访问。认领仅更新空 owner；管理员平时也只看自己的客户空间，不是跨客户数据超级账号。恢复需停服后用备份替换数据库，并按 SQLite 规范处理同一库的 WAL/SHM；不要把新库和旧 WAL 混用。

## 同一公共来源的复用范围

Feed、原始公开文章和仅由标题/正文生成的 ArticleTopics 缓存可跨账号复用。用户主动将同一公众号加入自己客户后，可以看到已缓存的公开文章；不会收到其他客户的名称、来源清单、收藏、排除、手工关键词、私有备注或同步日志。上述私有选择始终通过 Client.owner_id 校验。state 的 available_sources 只列自己已绑定来源，不能浏览全库监测清单。

同步日志按用户和客户持久记录，每个来源包含 added 及 articles:[{id,title}]；新增以采集前后原始文章 ID 差计算。服务端中途失败也保留并统计已入库文章，状态可为 partial；非本用户日志不会出现在刷新后的 state。

## 上线必须核验

1. **网络与应用双层限制**：仅暴露 `/workbench/`、其必要资产、工作台业务/认证 API 和无敏感信息健康检查。屏蔽旧 `/api/v1/wx`、`/views`、feed/RSS、原始 `/static` 二维码及其他遗留 API/页面。关闭或限制 `/docs`、`/redoc`、`/openapi.json`。不能只隐藏菜单。
2. 普通用户不能读取、修改、删除、导出、同步他人的客户、文章筛选、摘要、聊天、任务结果或设置。每个带 ID 的入口、后台任务和文件响应均校验归属；前端过滤不构成隔离。
3. 普通用户不能读取或修改全局模型密钥、微信登录凭据、系统管理设置；确认旧 WeRSS 登录入口对公网不可达。工作台 manager 密码不应在旧 users 表创建对应用户。
4. 测试两个不同普通用户、管理员、匿名四种身份；验证越权 ID、会话退出/到期/停用、跨站写入、AI 并发额度、旧入口阻断、已有数据迁移不丢失。
5. TLS 和可信代理真实部署验收、账号登录与端到端客户隔离通过后才发放试用地址。此模块离线测试不能代替目标服务器验证。
6. 本批工作台采集锁、关键词队列和定时器采用单进程实现，服务使用单 worker，不能同时运行两个应用实例对同一库调度；AI 额度本身由数据库事务保证原子性。扩为多实例前须先接持久任务队列。

## 验证范围

认证及隔离测试使用临时 SQLite 数据库和假账号/模型/采集，覆盖登录/退出/过期、角色、停用、密码重置撤销会话、Host/Origin、自定义请求头、脱敏会话返回、持久登录限制、AI 并发额度、失败计数及北京时间跨日。新增跨用户 ID 攻击矩阵、管理员默认私有空间、公共文章复用/私有备注分离、AI 规划与多轮一次扣额、部分采集真实新增、旧路由屏蔽及旧库迁移保真检查。

```powershell
.\.venv\Scripts\python.exe -X utf8 -m unittest discover -s tests -p "test_workbench*.py"
node tests/check_workbench_ui.cjs
```

SQLite 通过显式 `BEGIN IMMEDIATE` 事务串行化扣留，跨线程/进程共享同一数据库文件；其他数据库使用 SERIALIZABLE 及用户行锁，尚需目标数据库实测并发。当前不提供账号注册、找回密码或用户管理页面。

### 2026-11-10 本地验收

38项工作台后端测试、前端离线检查通过。旧库副本及真实迁移均逐项比对业务行保留；本地管理员保留28篇可见文章、3个来源，manager初始为空。实际HTTP检查确认匿名受阻、成员不能读取PMI文章/导出/采集凭据、旧API/RSS/static/docs关闭、退出后会话失效；浏览器已验证登录页、经理空空间、管理员文章库及Eason真实回答。

新来源“项有所成”实际新增2篇正文及主题词；重启到0.3.0后未重新扫码，再次采集成功且新增0篇。`data/wx.lic`已保存，但复制到另一台主机仍须复核上游有效性；不能用本次成功承诺永不掉线或-2041已被根治。启用云端定时采集时应停用本地同一任务，避免双端重复检查。

本地与云端的账号密码独立，发布时沿用云端管理员密码并创建云端经理账号；不要用本地数据库或本地测试账号文件覆盖云库。仅按授权单独迁移配置/微信凭据并备份旧文件。
