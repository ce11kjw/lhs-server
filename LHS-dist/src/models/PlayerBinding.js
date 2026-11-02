const mongoose = require('mongoose');

/**
 * PlayerBinding（玩家绑定）数据模型
 * 记录玩家与代理商的绑定关系
 */
const playerBindingSchema = new mongoose.Schema(
  {
    // 玩家ID（游戏服务端的玩家唯一标识）
    playerId: {
      type: String,
      required: true,
      unique: true,
    },

    // 代理商ID
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agent',
      required: true,
    },

    // 邀请码
    inviteCode: {
      type: String,
      required: true,
      uppercase: true,
      length: 6,
    },

    // 绑定时间
    bindAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// 索引优化
playerBindingSchema.index({ playerId: 1 });
playerBindingSchema.index({ agentId: 1 });
playerBindingSchema.index({ inviteCode: 1 });

module.exports = mongoose.model('PlayerBinding', playerBindingSchema);
