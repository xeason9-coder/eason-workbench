# Eason 知识与内容工作台

这是完整融合项目的单仓库入口。一次克隆包含知识库主系统、公众号采集与账号服务、Eason 检索、后台调度，以及 Windows 启动／停止／备份脚本；不需要再下载第二个仓库，也没有 submodule。

```text
eason-workbench/
├─ KB/                    知识库界面、资料与内容工作流、四类 Agent
├─ we-mp-rss/             账号、客户空间、公众号采集、Eason 检索
├─ 本地服务.ps1           启动／停止三个本地服务
├─ 启动本地版.cmd
├─ 停止本地版.cmd
├─ 备份本地数据.ps1
├─ tests/check-monorepo.mjs
├─ runtime/               运行后生成，不入 Git
└─ backups/               按需备份，不入 Git
```

## 已包含的功能

- 资料上传与解析、待审核知识整理、正式知识库、研究策划、写作与检查、人工审核、草稿历史与引用。
- 公众号监测、文章与正文检索、Eason 右侧可收起栏、监测参考转内容策划。
- 管理员与普通账号；普通账号可自建、归档和恢复自己的客户空间，每个账号最多两个未归档空间；其他账号的数据须单独授权。
- 四类 Agent 的管理员共享 API 配置与 Eason 独立 DeepSeek 配置；普通账号无需自行填写密钥。
- 后台任务、人工确认节点、明确重试、客户隔离和本地备份。

## 获取源码

本仓库公开，可直接克隆：

```powershell
git clone https://github.com/xeason9-coder/eason-workbench.git
cd eason-workbench
```

原两仓库保留用于追溯；此后完整项目以本仓库为入口。导入版本与许可见 [SOURCE_VERSIONS.md](SOURCE_VERSIONS.md)。

## Windows 全新安装

本地验证环境为 Node 24.14、pnpm 11.25、Python 3.12.13。以下命令从仓库根目录开始；全新安装不会自动出现原电脑的账号、文章或资料。

先准备采集器环境：

```powershell
cd we-mp-rss
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
New-Item -ItemType Directory -Path data -Force
if (-not (Test-Path config.yaml)) { Copy-Item config.example.yaml config.yaml }
```

仅首次安装复制模板，已有 `config.yaml` 时保留原文件。启动前修改其中已有字段：

| 配置字段 | 本地融合版设置 |
|---|---|
| `port` | `8768` |
| `server.host` | `127.0.0.1`（模板没有该字段时加入 server 下） |
| `server.threads` / `server.auto_reload` | `1` / `false` |
| `server.enable_job` | `false` |
| `debug` | `false` |
| `db` | `sqlite:///./data/db.db` |
| `secret` | 你们为本次安装生成的随机密钥，保存在本地配置中 |
| `redis.url` / `redis.server.enabled` | 空字符串 / `false` |
| `gather.model` / `gather.content` | `weread_mp` / `true` |
| `gather.content_auto_check` | `false` |

不要将真实密钥提交 Git。创建管理员时交互输入密码，源码没有预置账号密码：

```powershell
.\.venv\Scripts\python.exe -X utf8 tools/workbench_users.py --username admin --role admin
cd ..\KB
pnpm install --frozen-lockfile
node scripts/configure-local.mjs
pnpm build
cd ..
.\启动本地版.cmd
```

打开 <http://127.0.0.1:5173/>，用刚创建的管理员登录，创建客户空间。管理员可以在设置页创建普通账号。普通账号登录后可自行创建客户空间，无需管理员先分配。

`configure-local.mjs` 在本仓库内创建服务密钥和知识库本地配置。已有配置不覆盖；有采集器模型配置时复用它，没有时允许先启动，之后配置模型。四类 Agent 的 API Key 在主工作台“工作台设置 → 四类 Agent 模型配置”中填写。Eason 的独立 DeepSeek API Key 沿用采集器配置，可在 <http://127.0.0.1:8768/workbench/> 的管理员设置中填写；主工作台只切换其标准／进阶模型。微信扫码授权位于主工作台“采集连接与后台同步”。

停止使用根目录 `停止本地版.cmd`。源码更新后需要重新构建；更新、持久数据位置与备份步骤见 [LOCAL_RUN.md](LOCAL_RUN.md)。不要从旧目录和新目录同时启动两套默认端口相同的服务。

## 迁移现有数据

GitHub 包含两部分完整功能源码与安装说明；公开版本排除了原电脑的数据库、账号密码、API Key、加密主密钥、微信授权、备份，以及原项目内置的私人资料包和内部交接记录。资料上传、解析、知识整理、检索和四类 Agent 功能保留。复制代码不会恢复已有业务数据。

如果要迁移原电脑的工作状态，应先停机备份，再通过你们认可的私密方式迁移采集器 `data/`、`config.yaml`、知识库 `.dev.vars` 和完整 `runtime/kb`、`runtime/model-encryption.key`。保留各自对应的数据库和加密密钥；不要用空库或旧测试备份覆盖现有数据。微信授权能否延续须在新环境重新核验。详细备份范围见 [LOCAL_RUN.md](LOCAL_RUN.md)。

## 部署到云

一个仓库仍包含多个运行服务，合仓不要求把不同语言的服务改写成一个进程。当前提供并验证的是 Windows 本地方案。此仓库没有经过验收的一键云部署包；同事上云还需完成目标环境的服务启动、HTTPS 入口与登录 Cookie、私密配置、持久存储和后台运行适配，并在目标服务器验收。不要将仓库中的历史采集器 Docker 配置当作整套融合项目的云部署方案。

HTTPS 反向代理部署时，在 KB 的私密 `.dev.vars` 和 Python 进程环境中同时设置 `FUSION_PUBLIC_ORIGIN="https://你的域名"`（纯 HTTPS origin，不带路径）。保持 `FUSION_LOCAL=1`，并将 nginx 的 `Host` 固定为该域名；保留浏览器 `Origin`，不得靠客户端 `X-Forwarded-*` 决定信任。应用会核对 Host/Origin，公网写操作要求 Origin，登录和客户选择 Cookie 使用 Secure；不设置此变量时保留本机 HTTP 使用方式。

只有统一工作台入口可以经 HTTPS 对外；5173、8768、调试端口和后台 tick 不直接对公网开放。后台仍经环回地址与服务密钥调用。现有构建后的 Wrangler local 入口可由单机进程管理器保持运行，但目标环境的重启、持久化与访问边界仍需验收；不应随意换用另一版 Miniflare 读取现有数据库。

新增微信读书采集曾返回 `-2041`，合仓未解决该外部接口问题。当前公开版本的检查范围见 [VERIFICATION.md](VERIFICATION.md)。

## 验证

不连接模型、不修改正式数据的单仓库检查：

```powershell
node tests/check-monorepo.mjs
cd KB
pnpm exec tsc --noEmit
pnpm test
node tests/fusion-access.integration.mjs
pnpm build
cd ..\we-mp-rss
.\.venv\Scripts\python.exe -X utf8 -m unittest tests.test_fusion
```

`KB/scripts/accept-local-fusion.mjs` 是历史联合验收工具，会创建测试数据并调用付费模型，不是安装步骤，也不能直接复用原电脑的验收收据。请勿在正式空间运行；`--self-test` 仅离线检查工具自身。
