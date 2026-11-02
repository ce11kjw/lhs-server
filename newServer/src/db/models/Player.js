/**
 * Player 模型 - 玩家主文档
 * 采用嵌入式设计，一个玩家一个文档，包含大部分游戏数据
 * 结构参考 player_template.json
 */

const { Schema, model } = require('mongoose');

// 使用 Mixed 类型存储复杂嵌套结构，保持与客户端数据格式完全兼容
// 游戏数据结构多变，用严格 Schema 反而增加维护成本
const playerSchema = new Schema(
  {
    // === 基础信息 ===
    userId: { type: String, required: true, unique: true, index: true },
    playerId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, unique: true, index: true },
    level: { type: Number, default: 1 },
    exp: { type: Number, default: 0 },
    avatar: { type: Number, default: 11305 },
    avatarFrame: { type: Number, default: -1 },
    title: { type: Number, default: -1 },
    changeName: { type: Number, default: 0 },
    birth: { type: Number, default: 0 },
    changeBirth: { type: Number, default: 0 },
    createTime: { type: Number, default: 0 },
    schemaVersion: { type: Number, default: 2 },

    // === 分销系统关联 ===
    agentId: { type: String, default: null, index: true },
    inviteCode: { type: String, default: null, index: true },

    // === 社交/杂项 ===
    commentGift: { type: Number, default: 0 },
    fbGiftRecord: { type: Schema.Types.Mixed, default: () => ({}) },
    fbShareCount: { type: Number, default: 0 },

    // === 核心游戏数据（Mixed 类型，保持灵活性） ===
    boxInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    equipInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    taskInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    raidInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    roleInfo: { type: Schema.Types.Mixed, default: () => ({ realmInfo: { taskGroup: [], realmLevel: 0, realmExp: 0, realmStage: 0 } }) },
    formationInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    shopInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    rechargeInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    guildInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    farmInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    mineInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    swordInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    alchemyInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    petInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    fashionInfo: { type: Schema.Types.Mixed, default: () => ({ fashion: {}, fashionData: [] }) },
    systemUnlockInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    other_attr_info: { type: Schema.Types.Mixed, default: () => ({}) },
    artifactInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    spiritInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    fishInfo: { type: Schema.Types.Mixed, default: () => ({}) },
    activityInfo: { type: Schema.Types.Mixed, default: () => ({}) },

    // === 物品与货币 ===
    items: { type: Schema.Types.Mixed, default: () => ({}) },
    currencies: {
      type: Schema.Types.Mixed,
      default: () => ({ gold: 10000, diamond: 500, silver: 5000 }),
    },

    // === 其他 ===
    blockList: { type: [Number], default: [] },
  },
  {
    timestamps: true, // 自动添加 createdAt, updatedAt
    minimize: false, // 保留空对象（游戏数据需要）
    // The game keeps adding top-level runtime fields over time.
    // Allow unknown keys to persist instead of silently dropping them.
    strict: false,
  }
);

// 复合索引：按等级查询（排行榜等场景）
playerSchema.index({ level: -1 });

module.exports = model('Player', playerSchema);
