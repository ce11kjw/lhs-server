const mongoose = require('mongoose');
const config = require('./index');

/**
 * 连接 MongoDB 数据库
 */
async function connectDB() {
  try {
    await mongoose.connect(config.mongodb.uri);
    console.log('MongoDB 连接成功');
  } catch (error) {
    console.error('MongoDB 连接失败:', error.message);
    process.exit(1);
  }
}

/**
 * 断开 MongoDB 连接
 */
async function disconnectDB() {
  try {
    await mongoose.disconnect();
    console.log('MongoDB 断开连接');
  } catch (error) {
    console.error('MongoDB 断开连接失败:', error.message);
  }
}

module.exports = { connectDB, disconnectDB };
