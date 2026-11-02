/**
 * Guild 模型 - 公会
 */

const { Schema, model } = require('mongoose');

const guildSchema = new Schema(
  {
    guildId: { type: Number, required: true, unique: true, index: true },
    name: { type: String, required: true, unique: true },
    leaderId: { type: String, required: true }, // 会长 userId
    level: { type: Number, default: 1 },
    exp: { type: Number, default: 0 },
    icon: { type: Number, default: 0 },
    notice: { type: String, default: '' },
    activation: { type: Number, default: 0 },
    blessLv: { type: Number, default: 1 },
    blessValue: { type: Number, default: 0 },
    blessRewards: { type: [Schema.Types.Mixed], default: [] },
    blessRecords: { type: [String], default: [] },
    autoJoin: { type: Number, default: 0 },
    needLevel: { type: Number, default: 0 },
    searchable: { type: Number, default: 1 },
    templeBuffId: { type: Number, default: 0 },
    templeBuffTime: { type: Number, default: 0 },
    members: [
      {
        userId: String,
        playerId: String,
        playerid: String,
        dbid: String,
        name: String,
        playername: String,
        identity: Number, // 0=盟主, 1=副盟主, 2=成员
        joinTime: Number,
        donateCount: Number,
        donate: Number,
        weekdonate: Number,
        totalDonate: Number,
        totaldonate: Number,
        level: Number,
        power: Number,
        kungfuId: Number,
        subJob: Number,
        avatar: Number,
        avatarUrl: String,
        avatarurl: String,
        avatarFrame: Number,
        title: Number,
        logouttime: Number,
      },
    ],
    applications: [
      {
        userId: String,
        playerid: String,
        name: String,
        level: Number,
        power: Number,
        avatar: Number,
        avatarurl: String,
        avatarFrame: Number,
        applyTime: Number,
      },
    ],
    maxMembers: { type: Number, default: 20 },
    createTime: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = model('Guild', guildSchema);
