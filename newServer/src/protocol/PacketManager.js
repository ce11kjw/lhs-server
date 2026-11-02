/**
 * PacketManager - 统一封包/解包管理器
 * 封装 WS 和 HTTP 两种协议的打包解包操作，供网络层调用
 */

const { BinJsonUtil, ByteArray } = require('./BinJsonUtil');
const { Unpack } = require('./Codec');
const { unpackRequest, packResponse } = require('./ReqCodec');
const zlib = require('zlib');

/**
 * 编码单条 WS 消息
 * 格式：[version:2B][tag:2B][msgUid:4B][flags:4B][BinJson数据]
 * 服务端固定 version=1
 *
 * @param {number} tag - 协议标签
 * @param {*} data - 消息数据
 * @param {number} [msgUid=0] - 消息唯一 ID
 * @returns {Buffer}
 */
function packSingle(tag, data, msgUid) {
  const buf = new ByteArray();
  buf.writeUnsignedShort(1); // version = 1（服务端固定）
  buf.writeUnsignedShort(tag);
  buf.writeUnsignedInt(msgUid || 0);
  buf.writeUnsignedInt(0); // flags = 0（无压缩）
  BinJsonUtil.json2bin(data, buf);
  return Buffer.from(buf.bytes.buffer, buf.bytes.byteOffset, buf.length);
}

/**
 * 编码批量 WS 消息（tag=0, 压缩）
 * @param {Array} messages - 消息数组
 * @returns {Buffer}
 */
function packBatch(messages) {
  const buf = new ByteArray();
  buf.writeUnsignedShort(1); // version = 1
  buf.writeUnsignedShort(0); // tag = 0（批量）
  buf.writeUnsignedInt(0); // msgUid
  buf.writeUnsignedInt(1); // flags = 1（压缩）

  const dataBuf = new ByteArray();
  BinJsonUtil.json2bin(messages, dataBuf);
  const dataBytes = Buffer.from(dataBuf.bytes.buffer, dataBuf.bytes.byteOffset, dataBuf.length);

  const compressed = zlib.deflateSync(dataBytes);
  buf.writeBytes(new ByteArray(compressed));

  return Buffer.from(buf.bytes.buffer, buf.bytes.byteOffset, buf.length);
}

/**
 * 解码客户端 WS 消息
 * @param {Buffer} buffer - 客户端发送的原始数据
 * @returns {Array|*} 解包结果
 */
function unpackClient(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return Unpack(arrayBuffer);
}

/**
 * 打包 HTTP 响应（BinJson + zlib 压缩）
 * @param {*} data - 响应数据
 * @returns {Buffer}
 */
function packHttpResponse(data) {
  return packResponse(data);
}

/**
 * 解包 HTTP 请求
 * @param {Buffer} buffer - 请求体 Buffer
 * @returns {{ protocolId: number, params: * }}
 */
function unpackHttpRequest(buffer) {
  return unpackRequest(buffer);
}

module.exports = {
  packSingle,
  packBatch,
  unpackClient,
  packHttpResponse,
  unpackHttpRequest,
};
