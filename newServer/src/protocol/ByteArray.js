/**
 * ByteArray - 字节数组类
 * 从 egret.js 引擎提取，供 BinJson 协议编解码使用
 * 支持大端（Big Endian）字节序的二进制读写操作
 */

// 字节序常量
const Endian = {
  LITTLE_ENDIAN: 'littleEndian',
  BIG_ENDIAN: 'bigEndian',
};

/**
 * ByteArray 构造函数
 * @param {ArrayBuffer|Uint8Array} buffer - 初始缓冲区（可选）
 * @param {number} bufferExtSize - 缓冲区扩展步长（可选，默认 0）
 */
function ByteArray(buffer, bufferExtSize) {
  void 0 === bufferExtSize && (bufferExtSize = 0);
  this.bufferExtSize = 0;
  this.EOF_byte = -1;
  this.EOF_code_point = -1;
  this.bufferExtSize = bufferExtSize = bufferExtSize < 0 ? 0 : bufferExtSize;

  var bytes,
    length = 0;
  if (buffer) {
    if (buffer instanceof Uint8Array) {
      length = (bytes = buffer).length;
    } else {
      length = buffer.byteLength;
      bytes = new Uint8Array(buffer);
    }
    var arr =
      0 == bufferExtSize
        ? new Uint8Array(length)
        : new Uint8Array((1 + ((length / bufferExtSize) | 0)) * bufferExtSize);
    arr.set(bytes);
  } else {
    arr = new Uint8Array(bufferExtSize);
  }
  this.write_position = length;
  this._position = 0;
  this._bytes = arr;
  this.data = new DataView(arr.buffer);
  this.endian = Endian.BIG_ENDIAN;
}

// ==================== 属性访问器 ====================

/** 字节序（默认大端） */
Object.defineProperty(ByteArray.prototype, 'endian', {
  get: function () {
    return 0 == this.$endian ? Endian.LITTLE_ENDIAN : Endian.BIG_ENDIAN;
  },
  set: function (value) {
    this.$endian = value == Endian.LITTLE_ENDIAN ? 0 : 1;
  },
  enumerable: !0,
  configurable: !0,
});

/** 可读字节数 */
Object.defineProperty(ByteArray.prototype, 'readAvailable', {
  get: function () {
    return this.write_position - this._position;
  },
  enumerable: !0,
  configurable: !0,
});

/** 获取/设置底层 ArrayBuffer（截断到 write_position） */
Object.defineProperty(ByteArray.prototype, 'buffer', {
  get: function () {
    return this.data.buffer.slice(0, this.write_position);
  },
  set: function (value) {
    var length = value.byteLength;
    var bytes = new Uint8Array(value);
    var bufferExtSize = this.bufferExtSize;
    var arr =
      0 == bufferExtSize
        ? new Uint8Array(length)
        : new Uint8Array((1 + ((length / bufferExtSize) | 0)) * bufferExtSize);
    arr.set(bytes);
    this.write_position = length;
    this._bytes = arr;
    this.data = new DataView(arr.buffer);
  },
  enumerable: !0,
  configurable: !0,
});

/** 原始 ArrayBuffer（未截断） */
Object.defineProperty(ByteArray.prototype, 'rawBuffer', {
  get: function () {
    return this.data.buffer;
  },
  enumerable: !0,
  configurable: !0,
});

/** 底层 Uint8Array */
Object.defineProperty(ByteArray.prototype, 'bytes', {
  get: function () {
    return this._bytes;
  },
  enumerable: !0,
  configurable: !0,
});

/** DataView 访问器 */
Object.defineProperty(ByteArray.prototype, 'dataView', {
  get: function () {
    return this.data;
  },
  set: function (value) {
    this.buffer = value.buffer;
  },
  enumerable: !0,
  configurable: !0,
});

/** 缓冲区偏移量 */
Object.defineProperty(ByteArray.prototype, 'bufferOffset', {
  get: function () {
    return this.data.byteOffset;
  },
  enumerable: !0,
  configurable: !0,
});

/** 当前读写位置 */
Object.defineProperty(ByteArray.prototype, 'position', {
  get: function () {
    return this._position;
  },
  set: function (value) {
    (this._position = value) > this.write_position && (this.write_position = value);
  },
  enumerable: !0,
  configurable: !0,
});

/** 已写入数据长度 */
Object.defineProperty(ByteArray.prototype, 'length', {
  get: function () {
    return this.write_position;
  },
  set: function (value) {
    this.write_position = value;
    this.data.byteLength > value && (this._position = value);
    this._validateBuffer(value);
  },
  enumerable: !0,
  configurable: !0,
});

/** 剩余可读字节数（基于底层 buffer 大小） */
Object.defineProperty(ByteArray.prototype, 'bytesAvailable', {
  get: function () {
    return this.data.byteLength - this._position;
  },
  enumerable: !0,
  configurable: !0,
});

// ==================== 内部方法 ====================

ByteArray.prototype.setArrayBuffer = function (_buffer) {};

/** 清空缓冲区 */
ByteArray.prototype.clear = function () {
  var buffer = new ArrayBuffer(this.bufferExtSize);
  this.data = new DataView(buffer);
  this._bytes = new Uint8Array(buffer);
  this._position = 0;
  this.write_position = 0;
};

/** 确保缓冲区至少有 size 字节容量 */
ByteArray.prototype._validateBuffer = function (size) {
  var bufferExtSize = this.bufferExtSize;
  if (this.data.byteLength < size) {
    var arr =
      0 == bufferExtSize
        ? new Uint8Array(size)
        : new Uint8Array((1 + ((size / bufferExtSize) >> 0)) * bufferExtSize);
    arr.set(this._bytes);
    this._bytes = arr;
    this.data = new DataView(arr.buffer);
  }
};

/** 校验当前位置是否有足够字节可读 */
ByteArray.prototype.validate = function (size) {
  var length = this._bytes.length;
  if (0 < length && this._position + size <= length) {
    return !0;
  }
  throw new Error('ByteArray validate error: End of file was reached.');
};

/** 确保写入位置有足够空间 */
ByteArray.prototype.validateBuffer = function (size) {
  this.write_position = size > this.write_position ? size : this.write_position;
  size += this._position;
  this._validateBuffer(size);
};

// ==================== 读取方法 ====================

ByteArray.prototype.readBoolean = function () {
  if (this.validate(1)) {
    return !!this._bytes[this.position++];
  }
};

ByteArray.prototype.readByte = function () {
  if (this.validate(1)) {
    return this.data.getInt8(this.position++);
  }
};

/** 从当前位置读取 length 字节到目标 ByteArray */
ByteArray.prototype.readBytes = function (target, offset, length) {
  void 0 === offset && (offset = 0);
  void 0 === length && (length = 0);
  if (target) {
    var srcPos = this._position;
    var available = this.write_position - srcPos;
    if (available < 0) {
      throw new Error('ByteArray readBytes error: End of file was reached.');
    } else {
      if (0 == length) {
        length = available;
      } else if (available < length) {
        throw new Error('ByteArray readBytes error: End of file was reached.');
      }
      var targetPos = target._position;
      target._position = 0;
      target.validateBuffer(offset + length);
      target._position = targetPos;
      target._bytes.set(this._bytes.subarray(srcPos, srcPos + length), offset);
      this.position += length;
    }
  }
};

ByteArray.prototype.readDouble = function () {
  if (this.validate(8)) {
    var value = this.data.getFloat64(this._position, 0 == this.$endian);
    this.position += 8;
    return value;
  }
};

ByteArray.prototype.readFloat = function () {
  if (this.validate(4)) {
    var value = this.data.getFloat32(this._position, 0 == this.$endian);
    this.position += 4;
    return value;
  }
};

ByteArray.prototype.readInt = function () {
  if (this.validate(4)) {
    var value = this.data.getInt32(this._position, 0 == this.$endian);
    this.position += 4;
    return value;
  }
};

ByteArray.prototype.readShort = function () {
  if (this.validate(2)) {
    var value = this.data.getInt16(this._position, 0 == this.$endian);
    this.position += 2;
    return value;
  }
};

ByteArray.prototype.readUnsignedByte = function () {
  if (this.validate(1)) {
    return this._bytes[this.position++];
  }
};

ByteArray.prototype.readUnsignedInt = function () {
  if (this.validate(4)) {
    var value = this.data.getUint32(this._position, 0 == this.$endian);
    this.position += 4;
    return value;
  }
};

ByteArray.prototype.readUnsignedShort = function () {
  if (this.validate(2)) {
    var value = this.data.getUint16(this._position, 0 == this.$endian);
    this.position += 2;
    return value;
  }
};

/** 读取 UTF-8 字符串（前2字节为长度） */
ByteArray.prototype.readUTF = function () {
  var length = this.readUnsignedShort();
  return 0 < length ? this.readUTFBytes(length) : '';
};

/** 读取指定长度的 UTF-8 字节并解码为字符串 */
ByteArray.prototype.readUTFBytes = function (length) {
  if (this.validate(length)) {
    var view = this.data;
    var bytes = new Uint8Array(view.buffer, view.byteOffset + this._position, length);
    this.position += length;
    return this.decodeUTF8(bytes);
  }
};

// ==================== 写入方法 ====================

ByteArray.prototype.writeBoolean = function (value) {
  this.validateBuffer(1);
  this._bytes[this.position++] = +value;
};

ByteArray.prototype.writeByte = function (value) {
  this.validateBuffer(1);
  this._bytes[this.position++] = 255 & value;
};

/** 从源 ByteArray 写入指定范围的字节 */
ByteArray.prototype.writeBytes = function (source, offset, length) {
  void 0 === length && (length = 0);
  offset = void 0 === offset ? 0 : offset;
  if (
    offset < 0 ||
    length < 0 ||
    0 <
      (length = 0 == length ? source.length - offset : Math.min(source.length - offset, length))
  ) {
    this.validateBuffer(length);
    this._bytes.set(source._bytes.subarray(offset, offset + length), this._position);
    this.position = this._position + length;
  }
};

ByteArray.prototype.writeDouble = function (value) {
  this.validateBuffer(8);
  this.data.setFloat64(this._position, value, 0 == this.$endian);
  this.position += 8;
};

ByteArray.prototype.writeFloat = function (value) {
  this.validateBuffer(4);
  this.data.setFloat32(this._position, value, 0 == this.$endian);
  this.position += 4;
};

ByteArray.prototype.writeInt = function (value) {
  this.validateBuffer(4);
  this.data.setInt32(this._position, value, 0 == this.$endian);
  this.position += 4;
};

ByteArray.prototype.writeShort = function (value) {
  this.validateBuffer(2);
  this.data.setInt16(this._position, value, 0 == this.$endian);
  this.position += 2;
};

ByteArray.prototype.writeUnsignedInt = function (value) {
  this.validateBuffer(4);
  this.data.setUint32(this._position, value, 0 == this.$endian);
  this.position += 4;
};

ByteArray.prototype.writeUnsignedShort = function (value) {
  this.validateBuffer(2);
  this.data.setUint16(this._position, value, 0 == this.$endian);
  this.position += 2;
};

/** 写入 UTF-8 字符串（前2字节为长度） */
ByteArray.prototype.writeUTF = function (value) {
  var bytes = this.encodeUTF8(value);
  var length = bytes.length;
  this.validateBuffer(2 + length);
  this.data.setUint16(this._position, length, 0 == this.$endian);
  this.position += 2;
  this._writeUint8Array(bytes, !1);
};

/** 写入 UTF-8 字节（不含长度前缀） */
ByteArray.prototype.writeUTFBytes = function (value) {
  this._writeUint8Array(this.encodeUTF8(value));
};

ByteArray.prototype._writeUint8Array = function (bytes, validate) {
  var position = this._position;
  var newPosition = position + bytes.length;
  (validate = void 0 === validate || validate) && this.validateBuffer(newPosition);
  this.bytes.set(bytes, position);
  this.position = newPosition;
};

ByteArray.prototype.toString = function () {
  return '[ByteArray] length:' + this.length + ', bytesAvailable:' + this.bytesAvailable;
};

// ==================== UTF-8 编解码 ====================

/** 将字符串编码为 UTF-8 字节数组 */
ByteArray.prototype.encodeUTF8 = function (str) {
  for (var i = 0, codePoints = this.stringToCodePoints(str), bytes = []; codePoints.length > i; ) {
    var codePoint = codePoints[i++];
    if (this.inRange(codePoint, 55296, 57343)) {
      this.encoderError(codePoint);
    } else if (this.inRange(codePoint, 0, 127)) {
      bytes.push(codePoint);
    } else {
      var numBytes, byteMark;
      if (this.inRange(codePoint, 128, 2047)) {
        numBytes = 1;
        byteMark = 192;
      } else if (this.inRange(codePoint, 2048, 65535)) {
        numBytes = 2;
        byteMark = 224;
      } else if (this.inRange(codePoint, 65536, 1114111)) {
        numBytes = 3;
        byteMark = 240;
      }
      bytes.push(this.div(codePoint, Math.pow(64, numBytes)) + byteMark);
      while (0 < numBytes) {
        var byteVal = this.div(codePoint, Math.pow(64, numBytes - 1));
        bytes.push(128 + (byteVal % 64));
        --numBytes;
      }
    }
  }
  return new Uint8Array(bytes);
};

/** 将 UTF-8 字节数组解码为字符串 */
ByteArray.prototype.decodeUTF8 = function (bytes) {
  for (
    var i = 0,
      str = '',
      bytesSeen = 0,
      bytesNeeded = 0,
      lowerBoundary = 0,
      upperBoundary = 0,
      codePoint = 0;
    bytes.length > i;

  ) {
    var decoded,
      byte1 = bytes[i++];
    decoded =
      byte1 == this.EOF_byte
        ? 0 != bytesNeeded
          ? this.decoderError(!1)
          : this.EOF_code_point
        : 0 == bytesNeeded
          ? this.inRange(byte1, 0, 127)
            ? byte1
            : (this.inRange(byte1, 194, 223)
                ? ((bytesNeeded = 1), (upperBoundary = 128), (codePoint = byte1 - 192))
                : this.inRange(byte1, 224, 239)
                  ? ((bytesNeeded = 2), (upperBoundary = 2048), (codePoint = byte1 - 224))
                  : this.inRange(byte1, 240, 244)
                    ? ((bytesNeeded = 3), (upperBoundary = 65536), (codePoint = byte1 - 240))
                    : this.decoderError(!1),
              (codePoint *= Math.pow(64, bytesNeeded)),
              null)
          : this.inRange(byte1, 128, 191)
            ? ((bytesSeen += 1),
              (codePoint += (byte1 - 128) * Math.pow(64, bytesNeeded - bytesSeen)),
              bytesSeen !== bytesNeeded
                ? null
                : ((decoded = codePoint),
                  (lowerBoundary = upperBoundary),
                  (upperBoundary = bytesNeeded = codePoint = bytesSeen = 0),
                  this.inRange(decoded, lowerBoundary, 1114111) &&
                  !this.inRange(decoded, 55296, 57343)
                    ? decoded
                    : this.decoderError(!1, byte1)))
            : ((upperBoundary = bytesNeeded = codePoint = bytesSeen = 0),
              i--,
              this.decoderError(!1, byte1));

    if (decoded !== null && decoded !== this.EOF_code_point) {
      if (decoded <= 65535) {
        if (0 < decoded) {
          str += String.fromCharCode(decoded);
        }
      } else {
        decoded -= 65536;
        str += String.fromCharCode(55296 + ((decoded >> 10) & 1023));
        str += String.fromCharCode(56320 + (1023 & decoded));
      }
    }
  }
  return str;
};

ByteArray.prototype.encoderError = function (codePoint) {
  throw new Error('Encoding error: ' + codePoint);
};

ByteArray.prototype.decoderError = function (fatal, byte1) {
  if (fatal) {
    throw new Error('Decoding error');
  }
  return byte1 || 65533;
};

ByteArray.prototype.inRange = function (a, min, max) {
  return min <= a && a <= max;
};

ByteArray.prototype.div = function (n, d) {
  return Math.floor(n / d);
};

/** 将字符串转换为 Unicode 码点数组 */
ByteArray.prototype.stringToCodePoints = function (str) {
  var cps = [];
  for (var i = 0, len = str.length; i < len; ) {
    var c = str.charCodeAt(i);
    var c2;
    if (this.inRange(c, 55296, 57343)) {
      if (
        !this.inRange(c, 56320, 57343) &&
        i != len - 1 &&
        ((c2 = str.charCodeAt(i + 1)), this.inRange(c2, 56320, 57343))
      ) {
        i += 1;
        cps.push(65536 + ((1023 & c) << 10) + (1023 & c2));
      } else {
        cps.push(65533);
      }
    } else {
      cps.push(c);
    }
    i += 1;
  }
  return cps;
};

module.exports = ByteArray;
