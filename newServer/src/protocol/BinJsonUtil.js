/**
 * BinJsonUtil - 二进制 JSON 序列化/反序列化工具
 * 自定义二进制协议，用于客户端与服务端之间的数据传输
 *
 * 数据类型标记（type tag）：
 *   0=null, 1=零, 2-5=负整数(1/2/4/8字节), 6-9=正整数(1/2/4/8字节)
 *   10=浮点数(字符串池), 11=空字符串, 12-14=字符串(1/2/变长索引)
 *   15=空数组, 16=混合数组, 17=正整数数组, 18=有符号整数数组, 19=字符串数组
 *   20=空对象, 21=字符串键对象, 22=正整数键对象, 23=有符号整数键对象
 *   24=true, 25=false
 */

const ByteArray = require('./ByteArray');

/**
 * 写入变长数字（AutoNumber 编码）
 * @param {ByteArray} e - 目标字节数组
 * @param {number} t - 要写入的数字
 * @param {boolean} r - 是否支持负数（首字节 bit6 为符号位）
 */
function writeAutoNumber(e, t, r) {
  if (0 == t) e.writeByte(0);
  else {
    var n = t < 0;
    if (n) {
      if (!r) throw 'AutoNumber传入负数' + t + '但是约定非负';
      t = -t;
    }
    for (; 0 < t; ) {
      var o = t % 128;
      r
        ? ((r = !1), (t = (t - (o &= -65)) / 64), n && (o |= 64))
        : (t = (t - o) / 128),
        0 < t && (o |= 128),
        e.writeByte(o);
    }
  }
}

/**
 * 读取变长数字（AutoNumber 解码）
 * @param {ByteArray} e - 源字节数组
 * @param {boolean} t - 是否支持负数
 * @returns {number}
 */
function readAutoNumber(e, t) {
  for (var r = 0, n = !1, o = !0, i = 1; o; ) {
    var a = e.readUnsignedByte(),
      o = 0 != (128 & a);
    (a &= -129),
      t
        ? ((t = !1), (n = 0 != (64 & a)), (r = a &= -65), (i = 64))
        : ((r += a * i), (i *= 128));
  }
  return n ? -r : r;
}

/**
 * BinJsonStringPool - 字符串池
 * 序列化时缓存重复字符串，通过索引引用减少数据量
 */
function BinJsonStringPool() {
  this.pool = Object.create(null);
  this.buffer = new ByteArray(new ArrayBuffer(10240));
  this.poolSize = 0;
  this.buffer.position = 0;
}

/** 获取字符串在池中的索引，不存在则添加 */
BinJsonStringPool.prototype.getIndex = function (e) {
  var t = this.pool[e];
  return null == t && ((t = this.poolSize++), (this.pool[e] = t), this.writeString(e)), t;
};

/** 将字符串写入池的缓冲区 */
BinJsonStringPool.prototype.writeString = function (e) {
  var t, r, n;
  0 == e.length
    ? writeAutoNumber(this.buffer, 0, !1)
    : ((t = e.length <= 127 ? 1 : e.length <= 16383 ? 2 : 3),
      (r = this.buffer.position),
      (this.buffer.position += t),
      this.buffer.writeUTFBytes(e),
      (n = this.buffer.position - (r + t)),
      (this.buffer.position = r),
      writeAutoNumber(this.buffer, n, !1),
      this.buffer.position - r == t
        ? (this.buffer.position += n)
        : this.buffer.writeUTFBytes(e));
};

// 序列化用的共享临时缓冲区
var _tempBuffer = new ByteArray(new ArrayBuffer(10240));

/**
 * BinJsonUtil - 主工具类
 */
function BinJsonUtil() {}

// 协议版本号
BinJsonUtil.VERSION = 2;

/**
 * 将 JSON 对象序列化为二进制格式
 * 格式：[version:2B][字符串池大小:变长][字符串池数据][字段数据]
 * @param {*} e - JSON 对象
 * @param {ByteArray} t - 目标字节数组
 * @param {BinJsonStringPool} r - 字符串池（可选，外部传入时不写入池头）
 */
BinJsonUtil.json2bin = function (e, t, r) {
  var n = r || new BinJsonStringPool();
  _tempBuffer.position = 0;
  this.jsonField2Buffer(e, _tempBuffer, n);
  t.writeUnsignedShort(this.VERSION);
  r ||
    (writeAutoNumber(t, n.poolSize, !1),
    0 < n.buffer.position && t.writeBytes(n.buffer, 0, n.buffer.position));
  0 < _tempBuffer.position && t.writeBytes(_tempBuffer, 0, _tempBuffer.position);
};

/**
 * 将单个 JSON 字段写入缓冲区
 * 根据值的类型写入对应的 type tag + 数据
 */
BinJsonUtil.jsonField2Buffer = function (e, t, r) {
  if (null == e) t.writeByte(0);
  else if ('number' == typeof e)
    0 == e
      ? t.writeByte(1)
      : Number.isInteger(e)
        ? ((e = (n = e < 0) ? -e : e) <= 255
            ? (t.writeByte(n ? 2 : 6), t.writeByte(e))
            : e <= 65535
              ? (t.writeByte(n ? 3 : 7), t.writeUnsignedShort(e))
              : e <= 4294967295
                ? (t.writeByte(n ? 4 : 8), t.writeUnsignedInt(e))
                : (t.writeByte(n ? 5 : 9),
                  (d = (e - (n = e % 4294967296)) / 4294967296),
                  t.writeUnsignedInt(n),
                  t.writeUnsignedInt(d)))
        : (t.writeByte(10), writeAutoNumber(t, r.getIndex(String(e)), !1));
  else if ('string' == typeof e) {
    var n;
    0 == e.length
      ? t.writeByte(11)
      : (n = r.getIndex(e)) <= 255
        ? (t.writeByte(12), t.writeByte(n))
        : n <= 65535
          ? (t.writeByte(13), t.writeUnsignedShort(n))
          : (t.writeByte(14), writeAutoNumber(t, n - 65536, !1));
  } else if ('boolean' == typeof e) t.writeByte(e ? 24 : 25);
  else if (e instanceof Array)
    if (0 == e.length) t.writeByte(15);
    else {
      var o = null == e[0] ? null : Object.getPrototypeOf(e[0]),
        i = !1;
      if (o == Number.prototype || o == String.prototype)
        for (var a = 0, s = e; a < s.length; a++) {
          if (null == (p = s[a])) {
            o = null;
            break;
          }
          if (Object.getPrototypeOf(p) != o) {
            o = null;
            break;
          }
          if (o == Number.prototype) {
            if (!Number.isInteger(p)) {
              o = null;
              break;
            }
            p < 0 && (i = !0);
          }
        }
      if (o == Number.prototype) {
        t.writeByte(i ? 18 : 17), writeAutoNumber(t, e.length, !1);
        for (var l = 0, c = e; l < c.length; l++) writeAutoNumber(t, (p = c[l]), i);
      } else if (o == String.prototype) {
        t.writeByte(19), writeAutoNumber(t, e.length, !1);
        for (var u = 0, f = e; u < f.length; u++) {
          var p = f[u];
          writeAutoNumber(t, r.getIndex(p), !1);
        }
      } else {
        t.writeByte(16), writeAutoNumber(t, e.length, !1);
        for (var h = 0, m = e; h < m.length; h++) (p = m[h]), this.jsonField2Buffer(p, t, r);
      }
    }
  else {
    var d = Object.keys(e);
    if (0 == d.length) t.writeByte(20);
    else {
      for (var _ = !0, i = !1, g = 0, v = d; g < v.length; g++) {
        var y = v[g],
          b = Number(y);
        if (!Number.isInteger(b) || String(b) != y) {
          _ = !1;
          break;
        }
        b < 0 && (i = !0);
      }
      if (_) {
        t.writeByte(i ? 23 : 22), writeAutoNumber(t, d.length, !1);
        for (var S = 0, w = d; S < w.length; S++) {
          var E = w[S];
          writeAutoNumber(t, Number(E), i), this.jsonField2Buffer(e[E], t, r);
        }
      } else {
        t.writeByte(21), writeAutoNumber(t, d.length, !1);
        for (var R = 0, A = d; R < A.length; R++)
          (E = A[R]), writeAutoNumber(t, r.getIndex(E), !1), this.jsonField2Buffer(e[E], t, r);
      }
    }
  }
};

/**
 * 从二进制格式反序列化完整 JSON 对象
 * @param {ByteArray} e - 源字节数组
 * @param {Array} t - 字符串池（可选，外部传入时跳过池头解析）
 * @returns {*} 反序列化后的 JSON 值
 */
BinJsonUtil.readFullJson = function (e, t) {
  if ((e.readUnsignedShort(), !t)) {
    var r = readAutoNumber(e, !1);
    t = new Array(r);
    for (var n = 0; n < r; ++n) {
      var o = readAutoNumber(e, !1),
        o = 0 == o ? '' : e.readUTFBytes(o);
      t[n] = o;
    }
  }
  return this.readJsonField(e, t);
};

/** 从字符串池读取字符串 */
BinJsonUtil.readString = function (e, t) {
  return t[readAutoNumber(e, !1)];
};

/**
 * 从二进制格式读取单个 JSON 字段
 * 根据 type tag 解析对应的数据类型
 */
BinJsonUtil.readJsonField = function (e, t) {
  var r = e.readUnsignedByte();
  switch (r) {
    case 0:
      return null;
    case 1:
      return 0;
    case 2:
      return -e.readUnsignedByte();
    case 3:
      return -e.readUnsignedShort();
    case 4:
      return -e.readUnsignedInt();
    case 5:
      var n = e.readUnsignedInt();
      return -(4294967296 * e.readUnsignedInt() + n);
    case 6:
      return e.readUnsignedByte();
    case 7:
      return e.readUnsignedShort();
    case 8:
      return e.readUnsignedInt();
    case 9:
      return (n = e.readUnsignedInt()), 4294967296 * e.readUnsignedInt() + n;
    case 10:
      return parseFloat(this.readString(e, t));
    case 11:
      return '';
    case 12:
      return t[e.readUnsignedByte()];
    case 13:
      return t[e.readUnsignedShort()];
    case 14:
      return t[readAutoNumber(e, !1) + 65536];
    case 15:
      return [];
    case 17:
    case 18:
      for (
        var o = 18 == r, i = readAutoNumber(e, !1), a = new Array(i), s = 0;
        s < i;
        ++s
      )
        a[s] = readAutoNumber(e, o);
      return a;
    case 19:
      for (var l = readAutoNumber(e, !1), a = new Array(l), s = 0; s < l; ++s)
        a[s] = this.readString(e, t);
      return a;
    case 16:
      for (var c = readAutoNumber(e, !1), a = new Array(c), s = 0; s < c; ++s)
        a[s] = this.readJsonField(e, t);
      return a;
    case 20:
      return {};
    case 22:
    case 23:
      for (var o = 23 == r, u = {}, f = readAutoNumber(e, !1), s = 0; s < f; ++s) {
        var p = readAutoNumber(e, o),
          h = this.readJsonField(e, t);
        u[p] = h;
      }
      return u;
    case 21:
      for (f = readAutoNumber(e, !(u = {})), s = 0; s < f; ++s)
        (p = this.readString(e, t)), (h = this.readJsonField(e, t)), (u[p] = h);
      return u;
    case 24:
      return !0;
    case 25:
      return !1;
  }
};

module.exports = {
  BinJsonUtil,
  BinJsonStringPool,
  ByteArray,
  writeAutoNumber,
  readAutoNumber,
};
