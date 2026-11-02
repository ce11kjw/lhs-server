const { Schema, model } = require('mongoose');

const distCallbackTaskSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['bindInvite', 'rechargeCallback'],
      required: true,
      index: true,
    },
    dedupeKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    playerId: {
      type: String,
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      default: '',
      index: true,
    },
    inviteCode: {
      type: String,
      default: '',
    },
    payload: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
    status: {
      type: String,
      enum: ['pending', 'retrying', 'resolved'],
      default: 'pending',
      index: true,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: '',
    },
    lastTriedAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

distCallbackTaskSchema.index({ status: 1, updatedAt: -1 });

distCallbackTaskSchema.statics.recordFailure = async function recordFailure(task) {
  const dedupeKey = String(task.dedupeKey || '').trim();
  if (!dedupeKey) {
    throw new Error('DIST_CALLBACK_DEDUPE_KEY_REQUIRED');
  }

  return this.findOneAndUpdate(
    { dedupeKey },
    {
      $set: {
        type: task.type,
        playerId: task.playerId,
        orderId: task.orderId || '',
        inviteCode: task.inviteCode || '',
        payload: task.payload || {},
        status: 'retrying',
        lastError: String(task.lastError || ''),
        lastTriedAt: new Date(),
      },
      $inc: { retryCount: 1 },
      $setOnInsert: {
        resolvedAt: null,
      },
    },
    {
      upsert: true,
      new: true,
    }
  );
};

distCallbackTaskSchema.statics.markResolved = async function markResolved(dedupeKey) {
  const normalizedKey = String(dedupeKey || '').trim();
  if (!normalizedKey) {
    return null;
  }

  return this.findOneAndUpdate(
    { dedupeKey: normalizedKey },
    {
      $set: {
        status: 'resolved',
        lastError: '',
        resolvedAt: new Date(),
        lastTriedAt: new Date(),
      },
    },
    { new: true }
  );
};

module.exports = model('DistCallbackTask', distCallbackTaskSchema);
