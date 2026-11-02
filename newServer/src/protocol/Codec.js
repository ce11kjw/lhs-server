/**
 * Codec - WebSocket 协议组包/解包工具
 *
 * WS 包格式：
 *   [version:2B][tag:2B][msgUid:4B][flags:4B][BinJson数据]
 *
 * flags 标志位：
 *   bit0 (1): 数据是否 zlib 压缩
 *   bit2 (4): 是否为错误响应
 *
 * version 约定：
 *   客户端发送 version=2，服务端发送 version=1
 */

const { BinJsonUtil, ByteArray } = require('./BinJsonUtil');
const zlib = require('zlib');

/**
 * 组包 - 将数据打包成 WS 二进制格式
 * @param {number} protocolTag - 协议标签（tag）
 * @param {*} data - 要打包的数据对象
 * @param {number} msgUid - 消息唯一 ID
 * @returns {ArrayBuffer} 打包后的二进制数据
 */
function Pack(protocolTag, data, msgUid) {
  var buffer = new ByteArray();
  buffer.writeUnsignedShort(2); // version = 2
  buffer.writeUnsignedShort(protocolTag);
  buffer.writeUnsignedInt(msgUid);
  buffer.writeInt(0); // flags = 0（无压缩）
  BinJsonUtil.json2bin(data, buffer);
  return buffer.buffer;
}

/**
 * 解包 - 从 WS 二进制格式解析数据
 * @param {ArrayBuffer} arrayBuffer - 二进制数据
 * @returns {Array|*} 解包后的数据
 *   - 有 tag 时返回 [{ tag, msgUid, data, err }]
 *   - tag=0 时直接返回解压后的数据
 */
function Unpack(arrayBuffer) {
  var buffer = new ByteArray(arrayBuffer);

  // 读取包头
  buffer.readUnsignedShort(); // version（跳过）
  var protocolTag = buffer.readUnsignedShort();
  var msgUid = buffer.readUnsignedInt();
  var flags = buffer.readUnsignedInt();

  var data;
  var error;

  // bit0: 是否压缩
  var isCompressed = (flags & 1) !== 0;

  if (isCompressed) {
    // 解压后再反序列化
    var compressed = new Uint8Array(
      buffer.rawBuffer,
      buffer.bufferOffset + buffer.position
    );
    var decompressed = zlib.inflateSync(compressed);
    data = BinJsonUtil.readFullJson(new ByteArray(decompressed.buffer));
  } else {
    data = BinJsonUtil.readFullJson(buffer);
  }

  // bit2: 是否为错误
  if (flags & 4) {
    error = data;
    data = void 0;
  }

  if (protocolTag) {
    return [
      {
        tag: protocolTag,
        msgUid: msgUid,
        data: data,
        err: error,
      },
    ];
  } else {
    // tag=0 表示批量数据
    return data;
  }
}

module.exports = { Pack, Unpack };
