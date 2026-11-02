# 灵画师（LHS）分销系统

三级代理分销系统，支持推广佣金、提现管理、数据统计等功能。

## 技术栈
- Node.js 22+
- Express 4
- MongoDB 8
- JWT 认证
- Joi 参数校验
- Jest 单元测试

## 项目结构
```
LHS-dist/
├── src/
│   ├── config/          # 配置文件
│   ├── models/          # Mongoose 数据模型
│   ├── routes/          # API 路由
│   ├── services/        # 业务逻辑
│   ├── middleware/      # 中间件
│   ├── utils/           # 工具函数
│   └── app.js           # 应用入口
├── tests/               # 测试文件
├── docs/                # 文档
├── workflow/            # 任务文档
└── package.json
```

## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 文件，配置 MongoDB 连接等
```

### 3. 启动服务
```bash
# 开发模式（自动重启）
npm run dev

# 生产模式
npm start
```

### 4. 运行测试
```bash
npm test
```

### 5. 代码检查
```bash
# Lint 检查
npm run lint

# 自动修复
npm run lint:fix

# 格式化代码
npm run format
```

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| PORT | 服务端口 | 3001 |
| MONGODB_URI | MongoDB 连接字符串 | mongodb://localhost:27017/lhs-dist |
| JWT_SECRET | JWT 密钥 | your-secret-key-change-in-production |
| JWT_EXPIRES_IN | JWT 过期时间 | 7d |
| INTERNAL_API_KEY | 内部接口密钥 | your-internal-api-key |
| DEFAULT_ADMIN_ENABLED | 是否自动创建默认管理员 | 非生产环境有密码时开启 |
| DEFAULT_ADMIN_USERNAME | 默认管理员用户名 | admin |
| DEFAULT_ADMIN_PASSWORD | 默认管理员强密码 | 必须自行设置 |
| DEFAULT_ADMIN_PHONE | 默认管理员手机号 | 13900000001 |
| DEFAULT_ADMIN_SYNC_PASSWORD | 是否把已存在默认管理员同步为配置密码 | 0 |
| WITHDRAWAL_FEE_RATE | 提现手续费比例 | 0.01 |
| DEFAULT_COMMISSION_RATE_DIRECT | 直接推广佣金比例 | 0.30 |
| DEFAULT_COMMISSION_RATE_LEVEL1 | 一级上级佣金比例 | 0.10 |
| DEFAULT_COMMISSION_RATE_LEVEL2 | 二级上级佣金比例 | 0.05 |
| DEFAULT_COMMISSION_RATE_LEVEL3 | 三级上级佣金比例 | 0.03 |
| DEFAULT_COMMISSION_RATE_LEVEL4 | 四级上级佣金比例 | 0.02 |

## API 文档
详见 [docs/API.md](docs/API.md)

## 数据库设计
详见 [docs/DATABASE.md](docs/DATABASE.md)

## 业务流程

### 代理注册流程
1. 用户提供上级邀请码（可选）
2. 系统生成唯一邀请码
3. 创建代理账号，设置层级和佣金比例

### 佣金计算流程
1. 游戏服务端调用充值回调接口
2. 根据邀请码找到直接推广代理（L2）
3. 向上追溯最多三级，按比例计算佣金
4. 使用事务更新各代理余额

### 提现流程
1. 代理申请提现，填写银行信息
2. 系统扣除余额（含手续费）
3. 管理员审批
4. 审批通过后完成提现，拒绝则退回余额

## 开发规范

### 代码质量
- 提交前必须通过 `npm run lint` 和 `npm test`
- 新增功能必须补充单元测试
- 单个文件不超过1000行

### 注释规范
- 使用中文注释
- 专业术语保持英文
- 关键业务逻辑必须注释

### Git 提交规范
```
feat: 新功能
fix: 修复bug
docs: 文档更新
style: 代码格式调整
refactor: 重构
test: 测试相关
chore: 构建/工具相关
```

## 安全建议

1. **生产环境必须修改以下配置：**
   - JWT_SECRET
   - INTERNAL_API_KEY
   - DEFAULT_ADMIN_PASSWORD（如启用默认管理员）
   - MongoDB 连接密码

2. **网络安全：**
   - 内部接口仅允许游戏服务端 IP 访问
   - 使用 HTTPS
   - 启用 CORS 白名单

3. **数据安全：**
   - 定期备份数据库
   - 敏感字段加密存储
   - 日志脱敏处理

## 性能优化

1. **数据库优化：**
   - 为常用查询字段创建索引
   - 使用 MongoDB 事务保证一致性
   - 定期归档历史数据

2. **接口优化：**
   - 分页查询避免全表扫描
   - 使用 Redis 缓存热点数据
   - 限流防止恶意请求

## 部署说明

### Docker 部署（推荐）
```bash
# 构建镜像
docker build -t lhs-dist .

# 运行容器
docker run -d -p 3001:3001 --env-file .env lhs-dist
```

### PM2 部署
```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start src/app.js --name lhs-dist

# 查看日志
pm2 logs lhs-dist

# 重启服务
pm2 restart lhs-dist
```

## 故障排查

### MongoDB 连接失败
- 检查 MongoDB 服务是否启动
- 检查连接字符串是否正确
- 检查网络防火墙设置

### JWT 认证失败
- 检查 token 是否过期
- 检查 JWT_SECRET 是否一致
- 检查 Authorization header 格式

### 佣金计算错误
- 检查邀请码是否存在
- 检查代理层级关系
- 查看事务日志

## 联系方式
- 项目负责人：大内总管
- 开发团队：server-dev, dist-dev

## 许可证
ISC
