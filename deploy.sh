#!/usr/bin/env bash
# ==============================================================================
# 灵画师 H5 · 全新开服一键部署脚本  v2.0
# ------------------------------------------------------------------------------
# 在一台【全新机器】上从零开一个干净服：不迁移任何玩家存档 / CDK / 后台数据。
#   Node20 + MongoDB7 + Redis + MySQL8 + PHP7.2 + nginx + pm2
#   游戏服(8080/9200 WS) + 分销(3001) + 管理后台(8082) + 静态站(81/443)
#
# 全新 = 空 MongoDB（lhs_s1001 首次启动自动建）+ 空 cdks 表 + 空玩家列表。
# 唯一需要从外部带过来的只有【游戏素材 update/】（约 3.8G，属于程序资源，不含玩家数据）。
#
# 用法示例（新机器上，一条命令）：
#   ./deploy.sh --github-token ghp_xxx \
#                --update-src root@38.76.212.88:/www/wwwroot/game/update \
#                --update-pass '源机root密码' \
#                --admin-pass '你的后台密码' --mysql-pass '你的MySQL密码' --gmcode '你的GM口令'
#
# 常用参数（全都有默认值，最少只需 --github-token）：
#   --env-file FILE    从文件读取上述配置（模板见仓库 deploy.env.example）
#   --github-token T   私有仓库 ce11kjw/lhs-server 的 PAT（读权限即可）
#   --repo URL         覆盖仓库地址
#   --pack-dir DIR     用本机已有的 tgz 包目录（含 1-code/2-web/3-conf/5-js.tgz）
#   --code-url URL     从公开 URL 下载代码包 tgz（免 GitHub token，适合分发给别人）
#   --update-src SRC   游戏素材 update/ 来源：目录 | .tar.gz | .tgz | http(s) URL | user@host:/路径
#   --update-pass P    源机 SSH 密码（--update-src 用 user@host: 时需要）
#   --reuse-data       允许目标机已有 MongoDB/MySQL 数据（默认拒绝，保证「全新」）
#   --http-port N      站点端口，默认 81
#   --admin-pass P     后台/GM 登录密码（必填，缺失会询问）
#   --mysql-pass P     MySQL root 密码（必填，缺失会询问）
#   --gmcode C         GM 后台(pay/gm/cdk)通用口令（必填，缺失会询问）
#   --self-signed      同时开 443 自签证书入口（默认不开）
#   --skip-system      跳过 apt 系统依赖安装（已手动装好时用）
#   --tighten-firewall 收紧 iptables（默认不动现有防火墙）
#   --data-dir DIR     数据根，默认 /data/lhs
#   --web-dir DIR      静态站根，默认 /www/wwwroot/game
#   -h|--help          显示帮助
#
# 幂等：可重复执行；已存在的目录会保留，配置会备份后覆盖。
# ==============================================================================
set -euo pipefail

VERSION="1.0"
APP_NAME="灵画师"

# ---------- 默认参数 ----------
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO_URL=""
PACK_DIR=""
UPDATE_SRC=""
UPDATE_PASS=""
CODE_URL=""
REUSE_DATA=0
HTTP_PORT=81
ADMIN_PASS=""
MYSQL_PASS=""
GM_CODE=""
SELF_SIGNED=0
SKIP_SYSTEM=0
NO_FIREWALL=1
DATA_DIR="/data/lhs"
ENV_FILE=""
WEB_DIR="/www/wwwroot/game"
NODE_DIR="/usr/local/nodejs"
NODE_VER="20.18.3"
SERVER_ID=1001
SERVER_NAME="长安一区"
WS_PORT=9200
HTTP_API_PORT=8080
DIST_PORT=3001
ADMIN_PORT=8082

# ---------- 日志 ----------
c_ok=$'\033[32m'; c_wa=$'\033[33m'; c_er=$'\033[31m'; c_in=$'\033[36m'; c_0=$'\033[0m'
step() { printf "\n${c_in}==> [%s] %s${c_0}\n" "$1" "$2"; }
ok()   { printf "    ${c_ok}✓${c_0} %s\n" "$*"; }
warn() { printf "    ${c_wa}!${c_0} %s\n" "$*"; }
die()  { printf "\n${c_er}✗ 失败：${c_0}" >&2; printf "$@"; printf "\n" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

usage() { awk 'NR>=3 && /^# ={10,}/{exit} NR>=3{sub(/^# ?/,""); print}' "$0"; exit 0; }

# ---------- 参数解析 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)     ENV_FILE="$2"; shift 2 ;;
    --github-token) GITHUB_TOKEN="$2"; shift 2 ;;
    --repo)         REPO_URL="$2"; shift 2 ;;
    --pack-dir)     PACK_DIR="$2"; shift 2 ;;
    --code-url)     CODE_URL="$2"; shift 2 ;;
    --update-src)   UPDATE_SRC="$2"; shift 2 ;;
    --update-pass)  UPDATE_PASS="$2"; shift 2 ;;
    --reuse-data)   REUSE_DATA=1; shift ;;
    --http-port)    HTTP_PORT="$2"; shift 2 ;;
    --admin-pass)   ADMIN_PASS="$2"; shift 2 ;;
    --mysql-pass)   MYSQL_PASS="$2"; shift 2 ;;
    --gmcode)       GM_CODE="$2"; shift 2 ;;
    --data-dir)     DATA_DIR="$2"; shift 2 ;;
    --web-dir)      WEB_DIR="$2"; shift 2 ;;
    --self-signed)  SELF_SIGNED=1; shift ;;
    --skip-system)  SKIP_SYSTEM=1; shift ;;
    --tighten-firewall) NO_FIREWALL=0; shift ;;
    --no-firewall)      NO_FIREWALL=1; shift ;;
    -h|--help)      usage ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

[ -z "$REPO_URL" ] && REPO_URL="https://github.com/ce11kjw/lhs-server.git"

# ---------- 读取配置文件（可选）----------
if [ -z "$ENV_FILE" ] && [ -f ./deploy.env ]; then ENV_FILE=./deploy.env; fi
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die "配置文件不存在：$ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
  # 文件里的值覆盖到变量（仅限本脚本用到的键）
  GITHUB_TOKEN="${GITHUB_TOKEN:-}"; UPDATE_SRC="${UPDATE_SRC:-$UPDATE_SRC}"
  UPDATE_PASS="${UPDATE_PASS:-}"; ADMIN_PASS="${ADMIN_PASS:-}"
  MYSQL_PASS="${MYSQL_PASS:-}"; GM_CODE="${GM_CODE:-}"
  [ -n "${HTTP_PORT_CFG:-}" ] && HTTP_PORT="$HTTP_PORT_CFG"
  ok "已读取配置文件：$ENV_FILE"
fi

# ---------- 必填项：没给就当场问 ----------
ask_val() { # $1=变量名 $2=提示语 $3=参数名
  local name="$1" hint="$2" flag="$3" cur="${!1:-}"
  [ -n "$cur" ] && return 0
  if [ -t 0 ]; then
    printf "  ${c_in}?${c_0} %s（也可用 %s 传入）: " "$hint" "$flag" >&2
    IFS= read -r cur || true
    [ -n "$cur" ] || die "「%s」不能为空\n" "$hint"
    printf -v "$name" '%s' "$cur"
    ok "$hint 已填写"
  else
    die "缺少「%s」，非交互模式请用 %s 或 --env-file 传入" "$hint" "$flag"
  fi
}

ask_val ADMIN_PASS  "后台/GM 登录密码"        "--admin-pass"
ask_val MYSQL_PASS  "MySQL root 密码"          "--mysql-pass"
ask_val GM_CODE     "GM 后台口令（ht/gm 等）"  "--gmcode"

# 素材走 user@host: 且没给密码 → 当场问
if [ -n "$UPDATE_SRC" ] && [ -z "$UPDATE_PASS" ] && [[ "$UPDATE_SRC" == *@*:* ]]; then
  ask_val UPDATE_PASS "源机 SSH 密码（拉 update 素材用）" "--update-pass"
fi

# 代码来源：默认匿名 clone 公开仓库（无需 token）

# ---------- 环境前置 ----------
[ "$(id -u)" -eq 0 ] || die "必须 root 运行"
if [ -r /etc/os-release ]; then . /etc/os-release; OS_ID="$ID"; OS_VER="$VERSION_ID"; else die "无法识别系统"; fi
case "$OS_ID" in
  ubuntu|debian) ok "系统 $OS_ID $OS_VER" ;;
  *) die "仅支持 Ubuntu/Debian，当前 $OS_ID" ;;
esac
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] || die "仅支持 x86_64，当前 $ARCH"

AVAIL_MB=$(df -Pm / | awk 'NR==2{print $4}')
MIN_MB=2048
[ -n "${UPDATE_SRC:-}" ] && MIN_MB=6144
if [ "$AVAIL_MB" -lt "$MIN_MB" ]; then
  die "根分区可用 ${AVAIL_MB}MB < 需要 ${MIN_MB}MB（含游戏资源请换大盘或先清空间）"
fi
ok "根分区可用 ${AVAIL_MB}MB"

# 来源检查已在上面 ask 阶段完成

# ==============================================================================
# 1) 系统依赖
# ==============================================================================
install_node() {
  if [ -x "$NODE_DIR/bin/node" ]; then
    ok "Node 已存在：$("$NODE_DIR/bin/node" -v)"; return
  fi
  local url="https://npmmirror.com/mirrors/node/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz"
  local tmp="/tmp/node-v${NODE_VER}.tar.xz"
  curl -fsSL --retry 3 "$url" -o "$tmp" || die "Node 下载失败：$url"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp" -C "$NODE_DIR" --strip-components=1
  rm -f "$tmp"
  ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
  ln -sf "$NODE_DIR/bin/npm"  /usr/local/bin/npm
  ln -sf "$NODE_DIR/bin/npx"  /usr/local/bin/npx
  ok "Node 安装完成：$("$NODE_DIR/bin/node" -v)"
}

install_system() {
  step 1 "安装系统依赖"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    curl wget ca-certificates gnupg lsb-release git unzip tar xz-utils rsync \
    build-essential python3 jq libcap2-bin >/dev/null
  ok "基础工具就绪"

  # --- nginx ---
  need nginx || apt-get install -y -qq nginx >/dev/null
  ok "nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"

  # --- Redis ---
  need redis-server || apt-get install -y -qq redis-server >/dev/null
  systemctl enable --now redis-server >/dev/null 2>&1 || true
  ok "redis 已启动"

  # --- MySQL 8 ---
  if ! need mysql; then
    apt-get install -y -qq mysql-server >/dev/null
  fi
  systemctl enable --now mysql >/dev/null 2>&1 || systemctl enable --now mysqld >/dev/null 2>&1 || true
  # 设置 root 密码（首次用 auth_socket 直连；已有密码则用密码直连）
  if mysql -uroot -e 'SELECT 1' >/dev/null 2>&1; then
    mysql -uroot <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${MYSQL_PASS}';
FLUSH PRIVILEGES;
SQL
    ok "MySQL root 密码已设置"
  elif mysql -uroot -p"${MYSQL_PASS}" -e 'SELECT 1' >/dev/null 2>&1; then
    ok "MySQL root 密码已是目标值"
  else
    warn "MySQL root 密码未知，后续建库可能失败（可用 --mysql-pass 指定现有密码）"
  fi

  # --- MongoDB 7 ---
  if ! need mongod; then
    local codename="jammy"
    curl -fsSL "https://www.mongodb.org/static/pgp/server-7.0.asc" \
      | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${codename}/mongodb-org/7.0 multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-7.0.list
    apt-get update -qq
    apt-get install -y -qq mongodb-org >/dev/null
  fi
  systemctl enable --now mongod >/dev/null 2>&1 || true
  ok "MongoDB $(mongod --version 2>/dev/null | awk 'NR==1{print $3}')"

  # --- PHP 7.2（ondrej/sury 源）---
  if ! need php; then
    apt-get install -y -qq software-properties-common >/dev/null
    add-apt-repository -y ppa:ondrej/php >/dev/null 2>&1 || true
    apt-get update -qq
    apt-get install -y -qq php7.2-cli php7.2-fpm php7.2-mysql php7.2-mbstring php7.2-curl php7.2-xml php7.2-json >/dev/null
  fi
  systemctl enable --now php7.2-fpm >/dev/null 2>&1 || true
  ok "PHP $(php -r 'echo PHP_VERSION;' 2>/dev/null)"

  # --- Node 20 + pm2 ---
  install_node
  if ! [ -x "$NODE_DIR/bin/pm2" ]; then
    PATH="$NODE_DIR/bin:$PATH" npm install -g pm2 --silent >/dev/null 2>&1 || die "pm2 安装失败"
    ln -sf "$NODE_DIR/bin/pm2" /usr/local/bin/pm2
  fi
  ok "pm2 $(PATH=$NODE_DIR/bin:$PATH pm2 -v 2>/dev/null)"
}

if [ "$SKIP_SYSTEM" -eq 0 ]; then install_system; else step 1 "跳过系统依赖（--skip-system）"; fi

# ==============================================================================
# 2) 代码与静态资源
# ==============================================================================
SRC_ROOT="/tmp/lhs-src"
fetch_code() {
  step 2 "获取部署包"

  # --- 从公开 URL 下载代码包（免 token）---
  if [ -n "$CODE_URL" ]; then
    ok "从 URL 下载代码包：$CODE_URL"
    rm -rf "$SRC_ROOT"; mkdir -p "$SRC_ROOT"
    local f="/tmp/lhs-code-bundle.tgz"
    curl -fL --retry 3 --connect-timeout 15 "$CODE_URL" -o "$f" || die "代码包下载失败"
    tar xzf "$f" -C "$SRC_ROOT" 2>/dev/null || tar xf "$f" -C "$SRC_ROOT" || die "代码包解压失败"
    # 兼容打包时带一层目录
    if [ ! -d "$SRC_ROOT/newServer" ]; then
      local sub; sub=$(find "$SRC_ROOT" -maxdepth 1 -mindepth 1 -type d | head -1)
      [ -n "$sub" ] && [ -d "$sub/newServer" ] && mv "$sub"/* "$SRC_ROOT"/ 2>/dev/null || true
    fi
    [ -d "$SRC_ROOT/newServer" ] || die "代码包里没有 newServer/，请检查 $CODE_URL"
    ok "代码包已解开：$(ls "$SRC_ROOT" | tr '\n' ' ')"
    return
  fi

  # --- 优先用本机 tgz 目录 ---
  if [ -n "$PACK_DIR" ]; then
    [ -d "$PACK_DIR" ] || die "包目录不存在：$PACK_DIR"
    ok "使用本机包目录：$PACK_DIR"
    mkdir -p "$SRC_ROOT"
    [ -f "$PACK_DIR/1-code.tgz" ] && cp -f "$PACK_DIR/1-code.tgz" "$SRC_ROOT/" || true
    [ -f "$PACK_DIR/2-web.tgz" ]  && cp -f "$PACK_DIR/2-web.tgz"  "$SRC_ROOT/" || true
    [ -f "$PACK_DIR/5-js.tgz" ]   && cp -f "$PACK_DIR/5-js.tgz"   "$SRC_ROOT/" || true
    # 包目录里若带完整源码树也一并拿
    [ -d "$PACK_DIR/newServer" ] && rsync -a "$PACK_DIR/newServer/" "$SRC_ROOT/newServer/" || true
    [ -d "$PACK_DIR/LHS-dist" ]  && rsync -a "$PACK_DIR/LHS-dist/"  "$SRC_ROOT/LHS-dist/"  || true
    [ -d "$PACK_DIR/LHS-admin" ] && rsync -a "$PACK_DIR/LHS-admin/" "$SRC_ROOT/LHS-admin/" || true
    return
  fi

  # --- git 仓库 ---
  local url="$REPO_URL"
  case "$url" in
    https://github.com/*) url="https://x-access-token:${GITHUB_TOKEN}@${url#https://}" ;;
  esac
  rm -rf "$SRC_ROOT"
  git clone --depth 1 -q "$url" "$SRC_ROOT" || die "git clone 失败（检查 --github-token 是否有该私有仓库读权限）"
  ok "代码已拉取：$(cd "$SRC_ROOT" && git log --oneline -1)"
  # 仓库里的 pack/ 也当作补充包
  if [ -d "$SRC_ROOT/pack" ]; then
    for f in 1-code.tgz 2-web.tgz 5-js.tgz; do
      [ -f "$SRC_ROOT/pack/$f" ] && ln -sf "$SRC_ROOT/pack/$f" "$SRC_ROOT/$f"
    done
    ok "附加使用仓库内 pack/ 三个包"
  fi
}

lay_out_code() {
  step 3 "铺开代码目录"
  mkdir -p "$DATA_DIR" "$WEB_DIR" "$DATA_DIR/js"

  # --- 服务端源码 ---
  for d in newServer LHS-dist LHS-admin; do
    if [ -d "$SRC_ROOT/$d" ]; then
      mkdir -p "$DATA_DIR/$d"
      rsync -a --exclude node_modules --exclude .git "$SRC_ROOT/$d/" "$DATA_DIR/$d/"
      ok "铺开 $d"
    else
      warn "缺少 $d（将依赖 pack 解包）"
    fi
  done

  # --- pack 1-code.tgz：补齐被 .gitignore 排除的运行时文件（data/、bin/、配置表等）---
  if [ -f "$SRC_ROOT/1-code.tgz" ]; then
    tar xzf "$SRC_ROOT/1-code.tgz" -C "$DATA_DIR" --skip-old-files 2>/dev/null || \
      tar xzf "$SRC_ROOT/1-code.tgz" -C "$DATA_DIR" 2>/dev/null || warn "1-code.tgz 解包有告警"
    ok "1-code.tgz 已合并到 $DATA_DIR/newServer"
  fi

  # --- pack 2-web.tgz：前端静态站 ---
  if [ -f "$SRC_ROOT/2-web.tgz" ]; then
    local tmpg="/tmp/lhs-game-extract"; rm -rf "$tmpg"; mkdir -p "$tmpg"
    tar xzf "$SRC_ROOT/2-web.tgz" -C "$tmpg"
    if [ -d "$tmpg/game" ]; then
      rsync -a --ignore-existing "$tmpg/game/" "$WEB_DIR/"
      ok "2-web.tgz 已合并到 $WEB_DIR"
    fi
    rm -rf "$tmpg"
  fi

  # --- pack 5-js.tgz：前端核心 js ---
  if [ -f "$SRC_ROOT/5-js.tgz" ]; then
    mkdir -p "$DATA_DIR/js"
    tar xzf "$SRC_ROOT/5-js.tgz" -C "$DATA_DIR" 2>/dev/null || true
    if [ -d "$DATA_DIR/js" ]; then
      mkdir -p "$WEB_DIR/js"
      rsync -a --ignore-existing "$DATA_DIR/js/" "$WEB_DIR/js/"
      ok "5-js.tgz 已合并到 $WEB_DIR/js（$(ls "$WEB_DIR/js" | wc -l) 个文件）"
    fi
  fi
}

put_update() {
  step 4 "放置游戏资源 update/"
  mkdir -p "$WEB_DIR/update"
  if [ -z "$UPDATE_SRC" ]; then
    warn "未提供 --update-src：update/ 保持为空，进游戏会卡在资源加载"
    warn "资源约 3.8G，建议：--update-src /path/to/update.tgz 或 --update-src user@host:/www/wwwroot/game/update"
    return
  fi
  case "$UPDATE_SRC" in
    http://*|https://*)
      local f="/tmp/update-dl"; curl -fL --retry 3 "$UPDATE_SRC" -o "$f" || die "资源下载失败"
      tar xzf "$f" -C "$WEB_DIR/update" --strip-components=1 2>/dev/null || tar xzf "$f" -C "$WEB_DIR/update"
      rm -f "$f" ;;
    *.tar.gz|*.tgz|*.tar)
      tar xzf "$UPDATE_SRC" -C "$WEB_DIR/update" --strip-components=1 2>/dev/null || tar xzf "$UPDATE_SRC" -C "$WEB_DIR/update" ;;
    *:*)
      if [ -n "$UPDATE_PASS" ]; then
        need sshpass || apt-get install -y -qq sshpass >/dev/null 2>&1 || die "需要 sshpass 才能带密码 rsync"
        SSHPASS="$UPDATE_PASS" rsync -a --info=progress2 -e "sshpass -e ssh -o StrictHostKeyChecking=no" \
          "$UPDATE_SRC/" "$WEB_DIR/update/" || die "rsync 资源失败"
      else
        rsync -a --info=progress2 "$UPDATE_SRC/" "$WEB_DIR/update/" || die "rsync 资源失败（无免密时请加 --update-pass）"
      fi ;;
    *)
      [ -d "$UPDATE_SRC" ] || die "资源路径不存在：$UPDATE_SRC"
      rsync -a "$UPDATE_SRC/" "$WEB_DIR/update/" ;;
  esac
  local n; n=$(find "$WEB_DIR/update" -type f 2>/dev/null | wc -l)
  [ "$n" -gt 100 ] || warn "update/ 只有 $n 个文件，疑似不完整"
  ok "update/ 就绪：$n 个文件，$(du -sh "$WEB_DIR/update" | cut -f1)"
}

install_npm_deps() {
  step 5 "安装 Node 依赖"
  export PATH="$NODE_DIR/bin:$PATH"
  for d in newServer LHS-dist LHS-admin; do
    [ -f "$DATA_DIR/$d/package.json" ] || continue
    if [ -d "$DATA_DIR/$d/node_modules" ] && [ -n "$(ls -A "$DATA_DIR/$d/node_modules" 2>/dev/null)" ]; then
      ok "$d/node_modules 已存在，跳过"
      continue
    fi
    ( cd "$DATA_DIR/$d" && \
      if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund --silent; \
      else npm install --omit=dev --no-audit --no-fund --silent; fi ) \
      || die "$d 依赖安装失败"
    ok "$d 依赖完成"
  done
}

fetch_code
lay_out_code
put_update
install_npm_deps

# ==============================================================================
# 3) 配置生成
# ==============================================================================
API_KEY="$(openssl rand -hex 32)"
DIST_API_KEY="$(openssl rand -hex 32)"
JWT_SECRET="$(openssl rand -hex 32)"

backup_file() { [ -f "$1" ] && cp -a "$1" "$1.bak-$(date +%Y%m%d-%H%M%S)" || true; }

write_ecosystem() {
  step 6 "生成 pm2 ecosystem 配置"
  local f="$DATA_DIR/newServer/ecosystem.config.js"
  backup_file "$f"
  cat > "$f" <<EOF
// 由 deploy.sh 生成（$(date '+%F %T')）— 多区多进程，共享 MongoDB/Redis
module.exports = {
  apps: [
    {
      name: 'lhs-s${SERVER_ID}',
      script: 'src/app.js',
      cwd: '${DATA_DIR}/newServer',
      max_memory_restart: '1200M',
      env: {
        NODE_ENV: 'production',
        WS_PORT: ${WS_PORT},
        WS_PUBLIC_PORT: ${HTTP_PORT},
        WS_PUBLIC_PATH: '/ws',
        WS_BEHIND_PROXY: 1,
        HTTP_PORT: ${HTTP_API_PORT},
        SERVER_ID: ${SERVER_ID},
        SERVER_NAME: '${SERVER_NAME}',
        SERVER_HOST: '0.0.0.0',
        MONGO_URI: 'mongodb://127.0.0.1:27017/lhs_s${SERVER_ID}',
        REDIS_URL: 'redis://127.0.0.1:6379',
        REDIS_PREFIX: 's${SERVER_ID}:',
        API_KEY: '${API_KEY}',
        DIST_API_KEY: '${DIST_API_KEY}',
        ADMIN_USERNAME: 'aplm',
        ADMIN_PASSWORD: '${ADMIN_PASS}',
        FREE_RECHARGE_FOR_ALL: '1',
        CORS_ALLOWED_ORIGINS: '*',
      },
    },
    {
      name: 'lhs-dist',
      script: 'src/app.js',
      cwd: '${DATA_DIR}/LHS-dist',
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production', PORT: ${DIST_PORT} },
    },
    {
      name: 'lhs-admin',
      script: 'server.js',
      cwd: '${DATA_DIR}/LHS-admin',
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production', PORT: ${ADMIN_PORT}, GAME_API: 'http://127.0.0.1:${HTTP_API_PORT}' },
    },
  ],
};
EOF
  "$NODE_DIR/bin/node" -e "require('$f')" >/dev/null 2>&1 && ok "ecosystem 语法校验通过" || warn "ecosystem 语法异常，请检查 $f"
}

write_dist_env() {
  step 7 "生成分销系统 .env"
  local f="$DATA_DIR/LHS-dist/.env"
  backup_file "$f"
  cat > "$f" <<EOF
NODE_ENV=production
PORT=${DIST_PORT}
MONGODB_URI=mongodb://127.0.0.1:27017/lhs_dist

DEFAULT_ADMIN_ENABLED=true
DEFAULT_ADMIN_USERNAME=aplm
DEFAULT_ADMIN_PASSWORD=${ADMIN_PASS}
DEFAULT_ADMIN_PHONE=13800000000

JWT_SECRET=${JWT_SECRET}
INTERNAL_API_KEY=${DIST_API_KEY}
CORS_ALLOWED_ORIGINS=*
CORS_ALLOW_ALL=true
EOF
  chmod 600 "$f"
  ok "LHS-dist/.env 已写入"
}

write_nginx() {
  step 8 "配置 nginx（端口 ${HTTP_PORT}）"
  local body="/etc/nginx/sites-available/game-lhs-body.conf"
  cat > "$body" <<EOF
    root ${WEB_DIR};
    index index.html;
    client_max_body_size 64m;

    # 纹理/骨骼/音频：走 update/resource，强缓存
    location ~* \\.(ktx|skel|pvr|mp3|ogg|wav|ttf|otf|woff2?)\$ {
        root ${WEB_DIR}/update;
        try_files /resource\$uri @fallback;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
        access_log off;
    }
    location /js/ { alias ${WEB_DIR}/js/; expires 7d; add_header Cache-Control "public, max-age=604800"; access_log off; }
    location ~* \\.gz\$ {
        root ${WEB_DIR}; try_files \$uri =404;
        add_header Content-Encoding gzip; add_header Cache-Control "no-cache";
        types { application/octet-stream gz; }
        default_type application/octet-stream; gzip off; access_log off;
    }
    location /update/ { alias ${WEB_DIR}/update/; expires 7d; add_header Cache-Control "public, max-age=604800"; access_log off; }

    location = /index.html    { root ${WEB_DIR}; add_header Cache-Control "no-cache, no-store, must-revalidate"; expires -1; }
    location = /register.html { root ${WEB_DIR}; add_header Cache-Control "no-cache, no-store, must-revalidate"; expires -1; }
    location = /               { root ${WEB_DIR}; try_files /index.html =404; add_header Cache-Control "no-cache, no-store, must-revalidate"; expires -1; }

    location ~ \\.php\$ {
        try_files \$uri =404;
        fastcgi_pass unix:/run/php/php7.2-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_read_timeout 60s;
    }

    location /ws {
        proxy_pass http://127.0.0.1:${WS_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s; proxy_send_timeout 3600s; proxy_buffering off;
    }
    location /gameMsg.do { proxy_pass http://127.0.0.1:${HTTP_API_PORT}; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_buffering off; }
    location /api/       { proxy_pass http://127.0.0.1:${HTTP_API_PORT}; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; }
    location /admin/     { proxy_pass http://127.0.0.1:${ADMIN_PORT}/; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; }
    location /dist-api/  { proxy_pass http://127.0.0.1:${DIST_PORT}/; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }
    location /dist/      { proxy_pass http://127.0.0.1:${DIST_PORT}/; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }

    location / { try_files \$uri \$uri/ /index.html; }
    location @fallback { root ${WEB_DIR}; }
EOF

  cat > /etc/nginx/sites-available/game.lhs.conf <<EOF
server {
    listen ${HTTP_PORT};
    listen [::]:${HTTP_PORT};
    server_name _;
    include /etc/nginx/sites-available/game-lhs-body.conf;
    access_log /var/log/nginx/game-lhs-access.log;
    error_log  /var/log/nginx/game-lhs-error.log;
}
EOF
  ln -sf /etc/nginx/sites-available/game.lhs.conf /etc/nginx/sites-enabled/game.lhs.conf

  if [ "$SELF_SIGNED" -eq 1 ]; then
    mkdir -p /etc/nginx/ssl
    [ -f /etc/nginx/ssl/lhs.crt ] || openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout /etc/nginx/ssl/lhs.key -out /etc/nginx/ssl/lhs.crt \
      -subj "/CN=lhs" -addext "subjectAltName=IP:$(curl -s4 --max-time 5 ifconfig.me || echo 127.0.0.1)" >/dev/null 2>&1
    cat > /etc/nginx/sites-available/game-direct.conf <<EOF
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name _;
    ssl_certificate     /etc/nginx/ssl/lhs.crt;
    ssl_certificate_key /etc/nginx/ssl/lhs.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    include /etc/nginx/sites-available/game-lhs-body.conf;
    access_log /var/log/nginx/game-direct-access.log;
    error_log  /var/log/nginx/game-direct-error.log;
}
EOF
    ln -sf /etc/nginx/sites-available/game-direct.conf /etc/nginx/sites-enabled/game-direct.conf
    ok "443 自签证书入口已启用"
  fi

  # 端口不是 80 时保留 default 也可能冲突，直接禁用默认站
  [ -e /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default && ok "已禁用 nginx 默认站点"
  nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx 配置校验失败"; }
  systemctl enable --now nginx >/dev/null 2>&1; systemctl reload nginx
  ok "nginx 已重载"
}

patch_php_config() {
  step 9 "配置 ht/config（GM 口令 / 数据库）"
  local f="$WEB_DIR/ht/config/config.php"
  if [ ! -f "$f" ]; then warn "未找到 $f（跳过，可稍后手改）"; return; fi
  backup_file "$f"
  sed -i "s/\(\$gmcode[[:space:]]*=[[:space:]]*\)'[^']*'/\1'${GM_CODE}'/" "$f"
  grep -q "\$gmcode" "$f" && ok "GM 口令已设为 ${GM_CODE}" || warn "GM 口令替换失败，请手改 $f"
}

write_ecosystem
write_dist_env
write_nginx
patch_php_config

# ==============================================================================
# 4) 数据库 / 权限 / 启动 / 验收
# ==============================================================================
init_mysql() {
  step 10 "初始化 CDK 数据库"
  local my="mysql -uroot -p${MYSQL_PASS}"
  $my -e 'SELECT 1' >/dev/null 2>&1 || { warn "MySQL 连接失败，跳过建库（稍后手动执行 README 里的 SQL）"; return; }
  $my <<'SQL'
CREATE DATABASE IF NOT EXISTS cdks DEFAULT CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci;
CREATE TABLE IF NOT EXISTS cdks.cdk (
  id     INT NOT NULL AUTO_INCREMENT,
  cdk    VARCHAR(32) NOT NULL,
  lv     TINYINT DEFAULT NULL,
  qid    INT DEFAULT NULL,
  uid    VARCHAR(32) DEFAULT NULL,
  pass   VARCHAR(32) DEFAULT NULL,
  status TINYINT DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
SQL
  local t; t=$($my -N -e "show tables;" cdks 2>/dev/null | tr '\n' ' ')
  ok "cdks 库表：$t"
}

fix_perms() {
  step 11 "修正文件权限（nginx 必须可读）"
  find "$WEB_DIR" -type d -exec chmod 755 {} + 2>/dev/null || true
  find "$WEB_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true
  find "$WEB_DIR" -name "*.php" -exec chmod 644 {} + 2>/dev/null || true
  chmod -R a+rX "$DATA_DIR" 2>/dev/null || true
  ok "权限已统一 755/644"
}

start_app() {
  step 12 "启动服务（pm2）"
  export PATH="$NODE_DIR/bin:$PATH"
  cd "$DATA_DIR/newServer"
  # 平滑重启：存在则 restart，否则 start
  pm2 delete all >/dev/null 2>&1 || true
  pm2 start ecosystem.config.js --update-env >/dev/null || die "pm2 启动失败"
  sleep 6
  pm2 save >/dev/null 2>&1 || true
  pm2 startup systemd -u root --hp /root >/tmp/pm2-startup.log 2>&1 || true
  ok "pm2 已启动并设置开机自启"
  pm2 list | sed -n '1,12p'
}

health_check() {
  step 13 "验收"
  local fail=0
  for p in "$HTTP_API_PORT" "$WS_PORT" "$DIST_PORT" "$ADMIN_PORT"; do
    if ss -ltnp 2>/dev/null | grep -q ":${p} "; then ok "端口 ${p} 监听中"; else warn "端口 ${p} 未监听"; fail=$((fail+1)); fi
  done
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${HTTP_PORT}/" || echo 000)
  [ "$code" = "200" ] && ok "站点 http://127.0.0.1:${HTTP_PORT}/ → 200" || { warn "站点返回 $code"; fail=$((fail+1)); }
  local ready
  ready=$(curl -s --max-time 8 "http://127.0.0.1:${HTTP_API_PORT}/ready" || echo '')
  if echo "$ready" | grep -q '"ok"'; then ok "游戏服 /ready：$ready"; else warn "游戏服 /ready 异常：${ready:-<空>}"; fail=$((fail+1)); fi
  return 0
}

tighten_firewall() {
  [ "$NO_FIREWALL" -eq 1 ] && { step 14 "跳过防火墙（默认不修改）"; return; }
  step 14 "收紧防火墙（仅 22/${HTTP_PORT}/443）"
  iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT
  iptables -C INPUT -p tcp --dport "$HTTP_PORT" -j ACCEPT 2>/dev/null || iptables -I INPUT 2 -p tcp --dport "$HTTP_PORT" -j ACCEPT
  iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 3 -p tcp --dport 443 -j ACCEPT
  iptables -C INPUT -i lo -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i lo -j ACCEPT
  iptables -P INPUT DROP
  if need netfilter-persistent; then netfilter-persistent save >/dev/null 2>&1 || true
  elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4; fi
  ok "已放行 22/${HTTP_PORT}/443，其余入向丢弃（内网端口 8080/9200/3001/8082 仅回环）"
}

fresh_guard() {
  step 0 "全新性检查（不迁移任何存档）"
  if [ "$REUSE_DATA" -eq 1 ]; then
    warn "--reuse-data 已指定，跳过全新性检查"; return
  fi
  # MongoDB 里若已有玩家，说明不是空机
  if need mongosh || need mongo; then
    local mc; mc=$(command -v mongosh || command -v mongo)
    local n; n=$("$mc" --quiet --eval 'db.getMongo().getDBNames().filter(x=>/^lhs_/.test(x)).length' 2>/dev/null || echo 0)
    if [ "${n:-0}" -gt 0 ]; then
      local players; players=$("$mc" --quiet lhs_s${SERVER_ID} --eval 'db.players.countDocuments({})' 2>/dev/null || echo 0)
      if [ "${players:-0}" -gt 0 ]; then
        die "目标机 MongoDB 已有 ${players} 个玩家存档（lhs_s${SERVER_ID}.players）——这不是全新机器。确认要覆盖请加 --reuse-data"
      fi
    fi
  fi
  # 数据目录里若已有 CDK 记录
  if mysql -uroot -p"${MYSQL_PASS}" -N -e "select count(*) from cdks.cdk" >/dev/null 2>&1; then
    local c; c=$(mysql -uroot -p"${MYSQL_PASS}" -N -e "select count(*) from cdks.cdk" 2>/dev/null || echo 0)
    [ "${c:-0}" -gt 0 ] && die "目标机 cdks.cdk 已有 ${c} 条记录，不是全新环境。确认要保留请加 --reuse-data"
  fi
  ok "目标环境干净，将创建全新服（空存档 / 空 CDK）"
}

fresh_guard
init_mysql
fix_perms
start_app
health_check
tighten_firewall

# ---------- 摘要 ----------
IP="$(curl -s4 --max-time 5 ifconfig.me || echo '<本机IP>')"
cat <<EOF

$(printf "${c_ok}")════════════════ 部署完成 ════════════════$(printf "${c_0}")
  游戏地址     http://${IP}:${HTTP_PORT}/
  HTTPS 直连   $( [ "$SELF_SIGNED" -eq 1 ] && echo "https://${IP}/" || echo "（未启用，加 --self-signed 可开）")
  GM 后台      http://${IP}:${HTTP_PORT}/ht/gm/gm.html      口令 ${GM_CODE}
  CDK 生成     http://${IP}:${HTTP_PORT}/ht/cdk/index.php
  CDK 激活     http://${IP}:${HTTP_PORT}/ht/pay/index.php
  管理后台     http://${IP}:${HTTP_PORT}/admin/admin-users.html
  分销系统     http://${IP}:${HTTP_PORT}/dist/

  【全新服】已创建：玩家列表为空、CDK 为空库
  账号          aplm / ${ADMIN_PASS}
  MySQL         root / ${MYSQL_PASS}   （库 cdks，表 cdk）
  数据目录      ${DATA_DIR}
  静态目录      ${WEB_DIR}

  运维：
    pm2 list | pm2 logs lhs-s${SERVER_ID}
    systemctl status nginx mongod redis-server mysql php7.2-fpm
  注意：
    1) update/ 若为空（未传 --update-src），玩家进游戏会卡在资源加载
    2) 首次上线先注册一个号，再用 GM 后台给自己开通
    3) 公网访问需在商家面板/安全组放行 ${HTTP_PORT}$( [ "$SELF_SIGNED" -eq 1 ] && echo "/443")
$(printf "${c_ok}")═════════════════════════════════════════$(printf "${c_0}")

EOF
