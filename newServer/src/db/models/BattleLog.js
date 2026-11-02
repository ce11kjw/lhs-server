/**
 * BattleLog 模型 - 战斗记录
 * 独立集合，可定期清理
 */

const { Schema, model } = require('mongoose');

const battleLogSchema = new Schema(
  {
    type: { type: String, required: true, index: true }, // arena, tower, raid
    attackerId: { type: String, required: true, index: true },
    defenderId: { type: String, default: null },
    result: { type: Number, default: 0 }, // 0=失败, 1=胜利
    detail: { type: Schema.Types.Mixed, default: () => ({}) },
    // 7 天后自动过期
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

module.exports = model('BattleLog', battleLogSchema);
