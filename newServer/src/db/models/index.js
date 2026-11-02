/**
 * 数据模型统一导出
 */

const Player = require('./Player');
const Account = require('./Account');
const Guild = require('./Guild');
const Mail = require('./Mail');
const BattleLog = require('./BattleLog');
const Transaction = require('./Transaction');
const GlobalConfig = require('./GlobalConfig');
const GameServer = require('./GameServer');
const RedemptionCode = require('./RedemptionCode');
const ItemDictionary = require('./ItemDictionary');

module.exports = {
  Player,
  Account,
  Guild,
  Mail,
  BattleLog,
  Transaction,
  GlobalConfig,
  GameServer,
  RedemptionCode,
  ItemDictionary,
};
