/**
 * GlobalConfig 模型 - 全局配置/公告
 */

const { Schema, model } = require('mongoose');

const globalConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: null },
    description: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = model('GlobalConfig', globalConfigSchema);
