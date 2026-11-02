/**
 * ReqCodec - HTTP 请求打包/解包工具
 *
 * HTTP 请求格式（客户端 → 服务端）：
 *   新版 H5：[version:4B][protocolId:4B][originalLength:4B][zlib压缩的BinJson数据]
 *   旧版兼容：[protocolId:4B][originalLength:4B][zlib压缩的BinJson数据]
 *
 * HTTP 响应格式（服务端 → 客户端）：
 *   [zlib压缩的BinJson数据]
 */

const { BinJsonUtil, ByteArray } = require('./BinJsonUtil');
const zlib = require('zlib');

/**
 * 解析 HTTP 请求包（服务端用）
 * @param {Buffer} packetBuffer - 请求体 Buffer
 * @returns {{ protocolId: number, params: * }}
 */
function unpackRequest(packetBuffer) {
  var byteArray = new ByteArray(packetBuffer);

  var firstField = byteArray.readInt();
  var protocolId = firstField;
  var originalLength = byteArray.readInt();

  // The current official H5 client prefixes binGameMsg requests with a
  // 32-bit frame version. Legacy test clients omit this field.
  if (firstField === 1) {
    protocolId = originalLength;
    originalLength = byteArray.readInt();
  }

  // 读取剩余的压缩数据
  var compressedLength = byteArray.bytesAvailable;
  var compressed = new Uint8Array(
    byteArray.rawBuffer,
    byteArray.bufferOffset + byteArray.position,
    compressedLength
  );

  var decompressed = zlib.inflateSync(compressed);
  var params = BinJsonUtil.readFullJson(new ByteArray(decompressed));

  return {
    protocolId: protocolId,
    params: params,
    originalLength: originalLength,
  };
}

/**
 * 打包 HTTP 响应（服务端用）
 * @param {*} data - 响应数据
 * @returns {Buffer} zlib 压缩后的二进制数据
 */
function packResponse(data) {
  var binData = new ByteArray();
  BinJsonUtil.json2bin(data, binData);

  var uncompressed = new Uint8Array(binData.rawBuffer, binData.bufferOffset, binData.length);
  var compressed = zlib.deflateSync(uncompressed);

  return Buffer.from(compressed);
}

/**
 * 打包 HTTP 请求（客户端用，测试用途）
 * @param {number} protocolId - 协议号
 * @param {*} params - 请求参数
 * @returns {Buffer} 打包后的二进制数据
 */
function packRequest(protocolId, params) {
  var binData = new ByteArray();
  BinJsonUtil.json2bin(params, binData);

  var uncompressed = new Uint8Array(binData.rawBuffer, binData.bufferOffset, binData.length);
  var compressed = zlib.deflateSync(uncompressed);

  var packet = new ByteArray();
  packet.writeInt(protocolId);
  packet.writeInt(binData.length);
  packet.writeBytes(new ByteArray(compressed));

  return Buffer.from(packet.buffer);
}

/**
 * 解包 HTTP 响应（客户端用，测试用途）
 * @param {Buffer} responseBuffer - 响应数据 Buffer
 * @returns {*} 解包后的数据
 */
function unpackResponse(responseBuffer) {
  if (!responseBuffer || responseBuffer.length === 0) {
    return null;
  }

  var byteArray = new ByteArray(responseBuffer);
  var compressed = new Uint8Array(
    byteArray.rawBuffer,
    byteArray.bufferOffset + byteArray.position
  );
  var decompressed = zlib.inflateSync(compressed);
  var result = BinJsonUtil.readFullJson(new ByteArray(decompressed));

  return result;
}

module.exports = {
  unpackRequest,
  packResponse,
  packRequest,
  unpackResponse,
};
