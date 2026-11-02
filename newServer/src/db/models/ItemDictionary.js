const { Schema, model } = require('mongoose');

const itemDictionarySchema = new Schema(
  {
    itemId: { type: Number, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    desc: { type: String, default: '' },
    type: { type: Number, default: 0, index: true },
    typeName: { type: String, default: '', index: true },
    subType: { type: Number, default: 0, index: true },
    quality: { type: Number, default: 0, index: true },
    icon: { type: String, default: '' },
    ifShow: { type: Number, default: 0 },
    itemWay: { type: [Number], default: [] },
    sourceTable: { type: String, default: 'AssetsConfig', index: true },
    raw: { type: Schema.Types.Mixed, default: null },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'item_dictionaries' }
);

itemDictionarySchema.index({ name: 'text', desc: 'text', typeName: 'text' });

module.exports = model('ItemDictionary', itemDictionarySchema);
