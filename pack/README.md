# 灵画师 H5 服务端 · 部署包（38.76 生产环境快照）

来源机器：`38.76.212.88:/root/lhs-pack/`（打包时间 2026-10-12 16:43~16:48）
用途：整套部署的可还原压缩包，与仓库根目录的源码树互为补充。

| 文件 | 大小 | 内容 |
|---|---|---|
| `1-code.tgz` | 5.5M | `newServer/` 游戏主服务（Node + 配置表 + 脚本，968 项）|
| `2-web.tgz` | 6.8M | `game/` 前端静态站（Egret H5 + tools，102 项）|
| `3-conf.tgz` | 4K | `etc/nginx/sites-available/game-lhs-body.conf`、`sites-enabled/game-direct.conf` |
| `5-js.tgz` | 8.5M | `js/` 前端核心脚本（main.min / start.min / egret 等，16 项，含 .gz）|

校验：`sha256sum -c SHA256SUMS`

## 未包含
- **`update/` 游戏资源包（约 201M / 39 个 pack-*.tar.gz）** —— 体积过大，走 WebDAV 与机器本地备份，不入 git
- **`4-update.tgz`** —— 同上述原因，打包时已省略
- 运行时数据：`data/`、`logs/`、`node_modules/`、`.env`（见仓库 .gitignore）

## 还原步骤（简）
```bash
tar xzf 1-code.tgz      # -> newServer/
tar xzf 2-web.tgz       # -> game/
tar xzf 5-js.tgz        # -> js/（放到 game/ 下）
tar xzf 3-conf.tgz      # -> etc/nginx/...
```
依赖：Node v20（`/usr/local/nodejs`）、MongoDB、Redis、MySQL、PHP 7.2、pm2。
