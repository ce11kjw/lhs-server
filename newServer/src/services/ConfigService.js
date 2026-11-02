/**
 * ConfigService - 游戏配置表加载服务
 * 从客户端二进制配置文件中解码并缓存游戏数据表
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BinJsonUtil, ByteArray } = require('../protocol/BinJsonUtil');
const logger = require('../logger');

// 配置文件路径（客户端 bin 文件），支持 CONFIG_BIN_PATH 环境变量覆盖
const CONFIG_PATH_CANDIDATES = [
  process.env.CONFIG_BIN_PATH,
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    'LHS-re',
    'update',
    'resource',
    'assets',
    'excel',
    'config_e5ac72c2.bin'
  ),
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    'update',
    'resource',
    'assets',
    'excel',
    'config_e5ac72c2.bin'
  ),
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    'LHS-re',
    'update',
    'resource',
    'assets',
    'excel',
    'config_d315747e.bin'
  ),
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    'update',
    'resource',
    'assets',
    'excel',
    'config_d315747e.bin'
  ),
].filter(Boolean);

function resolveConfigPath(configPath) {
  if (configPath) return configPath;
  return CONFIG_PATH_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || CONFIG_PATH_CANDIDATES[0];
}

let _tables = null;

/**
 * 加载所有配置表
 * @param {string} [configPath] - 配置文件路径
 * @returns {Object} 配置表映射 { tableName: tableData }
 */
function loadAllTables(configPath) {
  if (_tables) return _tables;
  _tables = {};

  const binPath = resolveConfigPath(configPath);
  if (!fs.existsSync(binPath)) {
    logger.warn(`[Config] 配置文件不存在: ${binPath}，使用空配置`);
    return _tables;
  }

  const buffer = fs.readFileSync(binPath);
  const ba = new ByteArray(buffer);

  while (ba.position < ba.length) {
    const nameLen = ba.readByte();
    const name = ba.readUTFBytes(nameLen);
    const dataLen = ba.readUnsignedInt();
    const raw = buffer.slice(ba.position, ba.position + dataLen);
    ba.position += dataLen;

    try {
      const dec = zlib.inflateSync(raw);
      _tables[name] = BinJsonUtil.readFullJson(new ByteArray(dec.buffer));
    } catch (_e) {
      // 跳过损坏的条目
    }
  }

  logger.info(`[Config] 已加载 ${Object.keys(_tables).length} 张配置表`);
  return _tables;
}

/**
 * 获取指定配置表
 * @param {string} tableName - 配置表名称
 * @returns {*} 配置表数据，不存在返回 null
 */
function get(tableName) {
  const t = loadAllTables();
  return t[tableName] || null;
}

/**
 * 重新加载配置表（热更新用）
 */
function reload(configPath) {
  _tables = null;
  return loadAllTables(configPath);
}

module.exports = { loadAllTables, get, reload };
