# LHS-admin

统一管理入口，承载原 `admin-users.html` 的游戏后台功能，并通过目录反向代理接入分销系统。

## 启动

```bash
node server.js
```

默认端口和代理目标：

- `http://127.0.0.1:8082/`：统一管理首页
- `/game/*` -> `http://127.0.0.1:8080/*`，游戏后台与 `newServer` 管理 API
- `/dist/*` -> `http://127.0.0.1:3001/*`，分销系统后台与 API

可用环境变量覆盖：

- `LHS_ADMIN_PORT`
- `GAME_ADMIN_ORIGIN`
- `DIST_ADMIN_ORIGIN`

## 页面

- `admin-users.html`：迁移后的用户/大区/代理操作管理，API 经 `/game/api/admin/*` 代理。
- `dist-admin.html`：分销管理入口，内嵌统一入口 `/dist/index.html`。
