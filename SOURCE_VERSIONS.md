# 合并来源与许可

2026-11-11 将两份已同步、工作区干净的源码快照收入本仓库。两部分是普通目录，不使用 Git submodule，也不要求同事另行克隆。公开仓库从清理后的源码快照开始提交，不导入可能包含私人资料的原提交历史；统一了目录路径、初始化和交付文档。

| 目录 | 原私有仓库 | 导入提交 |
|---|---|---|
| `KB/` | [xeason9-coder/KB](https://github.com/xeason9-coder/KB) | `375a04034b91a60d3094b33ff4058ee78cb86a58` |
| `we-mp-rss/` | [xeason9-coder/we-mp-rss](https://github.com/xeason9-coder/we-mp-rss) | `ec5a9215e00d11bac03082c3bab20144c2efff93` |

原仓库及其历史保留，未删除或改写。当前业务代码以本单仓库后续提交为准，旧仓库不会自动跟随更新。

采集器原作者 RACHEL 的 MIT 许可保留在 [we-mp-rss/LICENSE](we-mp-rss/LICENSE)。KB 及其第三方文件原有版权、许可说明保持原样，包括 `KB/scripts/vite/sites-vite-plugin.LICENSE` 和 `KB/vendor/shadcn-tailwind-4.13.0.LICENSE.md`。未给其他来源代码重新声明统一许可证。

公开快照不包含原电脑的 `.git`、运行数据库、账号密码、模型密钥、微信会话、备份、原项目内置的私人资料包或内部交接记录。旧资料包专用导入入口已停用，常规资料上传与知识库功能保留。采集器原来已纳入版本控制的静态资源与 `qtserver/node_modules` 随原快照保留；根目录忽略规则阻止新增本地安装目录进入版本控制。
