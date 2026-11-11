# 本地知识库融合接口

本接口只供知识库服务端调用，不改变旧 `/workbench/` 的账号、客户所有者或来源。浏览器不能持有服务密钥。

## 连接与身份

- Python 地址使用环回地址；每次 `/fusion/*` 请求携带 `Authorization: Bearer <服务密钥>`，服务端同时检查连接来源为环回地址。
- 密钥来自环境变量 `FUSION_SERVICE_TOKEN` 或 `data/fusion-service.key`。首次启动仅在文件不存在时生成；至少 32 字节，不输出其值，不提交 Git。
- 登录复用 `desk_users`、bcrypt 密码、持久登录限流与 `desk_sessions`。`eason_session` 是 HttpOnly Cookie，融合路径为 `/`。知识库服务端转发 Set-Cookie；本地 HTTP 不设置 Secure，未来 HTTPS 适配由入口设置 Secure。
- 选中客户用 `X-Fusion-Client: <id>`。会员和外部成员只能选择实际授权客户；全局 admin 与现有 owner 有 manager 权限。没有 owner 的旧数据不自动认领。
- 通过新增 `fusion_client_members` 表保存权限，无迁移既有 owner。重复建表幂等。

## 账号与客户

| 方法与 `/fusion/` 后路径 | 输入 | 输出 |
| --- | --- | --- |
| POST `auth/login` | `{username,password}` | `{authenticated,user,clients,client:null}` + Set-Cookie |
| POST `auth/logout` | 无 | `{authenticated:false}` + 清 Cookie |
| GET `auth/session` | 可选 X-Fusion-Client | `{authenticated,user,clients,client}` |
| GET `admin/users` | 全局管理员 | `{items:[{id,username,role,active,created_at}]}` |
| POST `admin/users` | `{username,password,role:"admin"或"user"}` | `{user}` |
| PUT `admin/users/{id}` | `{active:boolean}` | `{ok:true}`，停用即时删除其会话，不能停用当前管理员 |
| GET `clients` | 已登录；可选 `include_archived=true`，普通账号只包含自己创建的归档空间 | `{items:[client]}`；含归档模式中每项有 archived 布尔值 |
| POST `clients` | 已登录，`{name,description?}` | 新 client 的 owner 固定为当前账号；每个账号最多两个未归档客户 |
| PUT `clients/{id}` | `{name,description?,archived?}`，建议提交完整三字段 | 更新后的 client，含 archived；活动客户 owner/manager 可改名定位，归档/恢复由 owner 或全局管理员操作 |
| GET `clients/{id}/members` | 客户 manager | `{owner_id,items}` |
| PUT `clients/{id}/members` | 客户 manager，`{user_id,role,grants}` | `{ok:true}`，幂等增改 |
| DELETE `clients/{id}/members/{user_id}` | 客户 manager | `{ok:true}`，撤销显式成员资格 |

`client` 为 `{id,name,description,role,grants,owned}`；role 为 `manager/member/external`；grants 为 `{documents:[],tasks:[],articles:[]}`。全局账号 role 与客户 role 不同；`owned` 表示当前账号是否为创建者。普通账号创建自己的空间后在该空间拥有 manager 权限，不获得全局管理员权限。

客户修改中 name 必填且为 1–80 字，description 最多 300 字、默认空，archived 默认 false。归档立即拒绝该空间的会话选择、监测及成员管理访问；仅空间创建者或全局管理员的含归档列表返回其 manager 角色。归档不删除来源、文章、成员授权、人工笔记或知识库内容，也不改变 owner；恢复后原授权重新生效。创建与恢复共用事务写锁，按 owner 核对最多两个活动客户；恢复容量不足、同 owner 名称冲突均返回 409，整次更新回滚。普通成员或外部成员修改已授权客户返回 403，无权限客户及非所有者、非全局管理员访问归档客户返回 404。

内部成员可使用其客户空间。外部成员只能读取 grants 中明确授予的内容；这些阅读权限不表示允许对外引用。文章 ID 由 Python 核对所属客户；document/task ID 由知识库服务端在转发授权前核对所属空间。知识库使用 `client:<id>` 保存和检索 D1 数据，不能只靠浏览器过滤。

## 信源监测与检索

后台调度可无用户 Cookie 调用 `GET /fusion/internal/clients`，仍必须通过环回连接和服务 Bearer 验证，仅返回 `{active_ids:[id]}`（未归档且有 owner 的客户）。此路径不在浏览器代理白名单中，不返回客户内容；后台据此停止归档空间的后续模型步骤。

`/fusion/monitor/{path}` 对应旧 `/workbench/api/{path}` 的请求字段和返回格式；必须带选中客户请求头，query/body/path 的 client_id 与它不一致返回 404。仅以下白名单开放：

- `GET state`：只返回当前客户、当前来源和同步记录；不含其他客户。普通用户不返回管理员模型配置；任何返回都不含密钥。
- `GET articles`、`GET/PUT article`、`GET article/reader`、`GET export`。
- `POST clients/{id}/sources`、`PUT/DELETE clients/{id}/sources/{feed_id}`。
- `POST sync`、`POST keywords`、`POST chat`。
- 管理员专用：`GET/PUT settings`、`POST model-test`、`GET weread/shelf`、`GET weread/search`、`GET wechat/search`；`POST weread/qr`、`GET weread/status`、`GET weread/qr-image`；wechat 同名三条路径。

列表保留 q、days、source_id、view、page、limit；详情/reader/修改需 article_id；sync/keywords/chat 保留 body.client_id。返回二维码 URL 改为知识库 `/api/fusion/monitor/*`；知识库阅读 iframe 同样使用该入口。

外部账号只可 GET state/articles/article/reader/export 与 POST chat。列表、搜索、CSV、阅读和模型实际输入都在数据库查询处按授权文章 ID 过滤；不能通过模型选择同一 owner 的另一个客户。外部账号不能修改备注、收藏、来源或触发同步。未授权单篇返回 404，其余不允许操作返回 403。

工作台采集保留促销文章原件，再按客户设置可恢复的 hidden 标记：只自动排除正文不超过 1600 字、标题明确出现限时优惠/早鸟价/免费试听/招生或开班通知，且前 300 字含购买、费用或报名行动的短通知。一般内容、长篇教学和只有推广页脚的文章保留；已有人工选择、收藏和备注不覆盖。可在排除列表恢复，之后同步不再自动隐藏。此为保守规则，不能识别所有软文；旧版本直接跳过而未采集的原文不会凭空恢复。

模型检索每进程最多两个任务并行，额外任务最多等待 120 秒，超时返回 429 和 Retry-After。取消请求会释放已取得的槽位。额度仍记真实操作者，每次检索/关键词模型操作保留既有计费和失败语义；此为单进程本地试运行，未实现多进程共享队列。

## 验证

新增测试运行 `.venv\Scripts\python.exe -X utf8 -m unittest tests.test_fusion`；旧工作台回归运行 `.venv\Scripts\python.exe -X utf8 -m unittest discover -s tests -p "test_workbench*.py"`。旧隔离测试使用同目录导入，须用 discover 执行。

新增测试全部使用临时 SQLite、虚构账号与虚构文章。七用户并发检查使用模拟模型，验证排队、峰值两个模型任务及每个用户独立用量；不代表真实模型供应商吞吐、费用或 Mac 已验收。测试不启动采集定时器，不修改正式文章数据。真实模型、真实扫码与知识库前端集成另行验收。
