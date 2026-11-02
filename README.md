# 灵画师 H5 服务端

自建私服服务端，含游戏服 / 分销系统 / 管理后台三套。

---

## 🚀 全新开服 · 一键部署

在一台**全新机器**（Ubuntu 22.04/24.04，x86_64，root）上从零开一个干净服：
不迁移任何玩家存档 / CDK / 后台数据。

```bash
# 1) 拿脚本
git clone https://github.com/ce11kjw/lhs-server.git
cd lhs-server

# 2) 填配置（密码等全部自己填，脚本里没有硬编码凭据）
cp deploy.env.example deploy.env && vim deploy.env

# 3) 一条命令开服
chmod +x deploy.sh && ./deploy.sh
```

脚本会依次完成：系统依赖（nginx / Redis / MongoDB7 / MySQL8 / PHP7.2）→
Node20 + pm2 → 拉代码铺目录 → 放置游戏素材 `update/` → 装依赖 →
生成 `ecosystem.config.js` 与分销 `.env` → 建 CDK 库表 → 配 nginx →
pm2 启动 + 开机自启 → 端口/页面验收。

**必填项**（`deploy.env` 或参数，缺失时脚本会当场询问）：

| 键 | 说明 |
|---|---|
| ~~`GITHUB_TOKEN`~~ | **不需要**（仓库公开，匿名 clone）；仅自建私有仓库时用 |
| `UPDATE_SRC` | 游戏素材 `update/`（约 3.8G）来源：目录 / tgz / URL / `user@host:/路径` |
| `ADMIN_PASS` | 后台与前缀账号 `aplm` 的密码 |
| `MYSQL_PASS` | 新建 MySQL root 密码 |
| `GM_CODE` | GM 后台（`ht/gm`、`ht/cdk`、`ht/pay`）口令 |

**「全新」保障**：启动前会检查目标机 MongoDB 是否已有 `lhs_s1001.players` 存档、
`cdks.cdk` 是否已有记录；有的话直接拒绝执行，除非显式加 `--reuse-data`。

**注意**
- `update/` 是游戏素材（纹理/骨骼/音频），不含玩家数据，必须带过去，否则玩家会卡在资源加载
- 公网访问需在商家面板/安全组放行 `81`（以及启用 `--self-signed` 时的 `443`）
- 首次进后台先注册一个账号，再用 GM 后台给自己开通

参数全列表：`./deploy.sh --help`

## 目录结构

| 目录 | 说明 | 端口 |
|---|---|---|
| `newServer/` | 游戏主服务（WebSocket + HTTP） | 8080(HTTP) / 8081(AGENT) / 9200(WS) |
| `LHS-dist/` | 三级分销系统 | 3001 |
| `LHS-admin/` | 管理后台网关（静态 + 反代） | 8082 |

## 技术栈

- Node.js v20.18.3 + pm2
- MongoDB 7.0（主库 `lhs_s1001`）+ Redis 7
- MySQL 8（CDK 授权库 `cdks`）
- PHP 7.2（GM 后台 / CDK / 支付页）

## 协议

客户端与服务端通过 **tag 数字** 分发消息（`src/router.js`）。

主要 tag 段位：

| 段 | 系统 |
|---|---|
| 1-100 | 账号/登录/基础 |
| 1000-2000 | 玩家数据/背包/任务 |
| 2000-2300 | 各类玩法 |
| 2300-2311 | 主线战斗/挂机/分享 |
| 3200-3210 | **坐骑（剑灵）系统** |
| 3300-3314 | 宠物系统 |
| 4100-4111 | 英灵（法相）系统 |

## 最近修复（2026-10-12）

1. **挂机章节被主线覆盖** — `raid.js advanceLevel()` 不再自动改写 `hangUpChapter`
2. **升星不升级词条** — 新增 `syncMountSkillLevels()`，按 `SwordConfig.skillConds` 阈值升级
3. **坐骑属性错误** — `buildMountAttrs()` 改读 `SwordLevelConfig` + `SwordStarLevelConfig`

详见 `CHANGELOG.md`。

## 启动

```bash
cd newServer
npm install --omit=dev
pm2 start ecosystem.config.js
```
