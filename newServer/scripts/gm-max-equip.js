/**
 * GM: 拉满装备（直接用 collection.updateOne，绕开 Mongoose 脏检测）
 * 用法: node scripts/gm-max-equip.js [玩家名]
 */
const mongoose = require('mongoose');
const cs = require('../src/services/ConfigService');

const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/lhs_s1001';
const NAME = process.argv[2] || 'admkk';
const MAX_LEVEL = 1305;
const MAX_QUALITY = 45;

(async () => {
  await mongoose.connect(MONGO);
  const db = mongoose.connection.db;
  const Player = require('../src/db/models/Player');

  const p = await Player.findOne({ name: NAME });
  if (!p) { console.error('玩家不存在'); process.exit(1); }

  const t = cs.loadAllTables();
  const assets = t['AssetsConfig'] || {};
  console.log('==== 拉满装备: ' + p.name + ' ====');

  const info = p.equipInfo || {};
  const esm = info.equipSetMap || {};
  const planKey = Object.keys(esm)[0] || '0';
  const plan = esm[planKey] || {};

  const qm = 1 + (MAX_QUALITY - 1) * 0.3;   // 品质倍率

  const newPlan = {};
  for (let slot = 1; slot <= 12; slot++) {
    const cur = plan[slot] || {};
    const templateId = cur.id || (31100 + slot);
    const row = assets[templateId] || assets[String(templateId)] || {};

    // 属性（与源码公式一致）
    const raw = {
      1: Math.floor((150 + MAX_LEVEL * 25) * qm),
      2: Math.floor((20 + MAX_LEVEL * 8) * qm),
      3: Math.floor((10 + MAX_LEVEL * 3) * qm),
      4: Math.floor((5 + MAX_LEVEL * 2) * qm),
    };
    // 保留原有特殊属性
    Object.keys(cur.attrs || {}).forEach(k => {
      if (Number(k) > 100) raw[k] = Math.floor((30 + MAX_LEVEL * 4) * qm);
    });

    newPlan[slot] = {
      uid: cur.uid || (Date.now() % 100000000 + slot),
      id: templateId,
      type: cur.type || slot,
      quailty: MAX_QUALITY,
      lv: MAX_LEVEL,
      attrs: raw,
    };
    console.log('   槽' + slot + ': id=' + templateId + ' lv=' + MAX_LEVEL +
      ' 品质=' + MAX_QUALITY + ' 攻击=' + raw[1] + ' 生命=' + raw[2]);
  }

  // 直接用 collection 更新，避开 Mongoose 脏检测
  const r = await db.collection('players').updateOne(
    { _id: p._id },
    { $set: { ['equipInfo.equipSetMap.' + planKey]: newPlan } }
  );
  console.log('');
  console.log('   matched=' + r.matchedCount + ' modified=' + r.modifiedCount);

  // 验证
  const after = await db.collection('players').findOne({ _id: p._id });
  const ap = (after.equipInfo.equipSetMap || {})[planKey] || {};
  console.log('');
  console.log('  --- 写回验证 ---');
  Object.keys(ap).forEach(k => {
    const e = ap[k];
    console.log('   槽' + k + ': lv=' + e.lv + ' 品质=' + e.quailty);
  });

  console.log('');
  console.log('==== 完成 ====');
  await mongoose.disconnect();
})().catch(e => { console.error('失败:', e.message, e.stack); process.exit(1); });
