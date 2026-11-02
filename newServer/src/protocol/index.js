/**
 * 协议层统一导出
 */

const ByteArray = require('./ByteArray');
const { BinJsonUtil, BinJsonStringPool, writeAutoNumber, readAutoNumber } = require('./BinJsonUtil');
const { Pack, Unpack } = require('./Codec');
const ReqCodec = require('./ReqCodec');
const PacketManager = require('./PacketManager');

module.exports = {
  // 底层工具
  ByteArray,
  BinJsonUtil,
  BinJsonStringPool,
  writeAutoNumber,
  readAutoNumber,

  // WS 协议
  Pack,
  Unpack,

  // HTTP 协议
  ...ReqCodec,

  // 统一封包管理
  PacketManager,
};
