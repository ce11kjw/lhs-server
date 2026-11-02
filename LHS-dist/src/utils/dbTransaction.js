const mongoose = require('mongoose');

function isUnsupportedTransactionError(error) {
  const message = String(error && error.message).toLowerCase();
  return message.includes('transaction numbers are only allowed')
    || message.includes('transactions are not supported')
    || message.includes('replica set')
    || message.includes('mongos');
}

async function runInTransaction(work, { label = 'transaction' } = {}) {
  if (typeof work !== 'function') throw new TypeError(`${label}: work must be a function`);

  // The deployment uses a standalone MongoDB. An explicit 0 keeps the write
  // path usable while retaining transaction support when a replica set exists.
  if (process.env.DB_REQUIRE_TRANSACTIONS === '0') {
    return work(null);
  }

  let session;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    const allowFallback = process.env.DB_ALLOW_TRANSACTION_FALLBACK === '1'
      || isUnsupportedTransactionError(error);
    if (allowFallback) return work(null);
    throw error;
  } finally {
    if (session) await session.endSession();
  }
}

module.exports = { runInTransaction };
