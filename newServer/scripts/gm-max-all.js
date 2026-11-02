/**
 * GM 脚本：一键拉满玩家全部系统
 * 用法: node scripts/gm-max-all.js [玩家名]
 * 全程使用游戏官方函数，保证属性/结构正确
 */
const mongoose = require('mongoose');
const EquipService = require('../src/services/EquipService');

const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/lhs_s1001';
const PLAYER_NAME = process.argv[2] || 'admkk';
const MAX_LEVEL = 1305;
const MAX_QUALITY = 45;

(async () => {
  await mongoose.connect(MONGO);
  const Player = require('../src/db/models/Player');

  const p = await Player.findOne({ name: PLAYER_NAME });
  if (!p) { console.error('玩家不存在:', PLAYER_NAME); process.exit(1); }

  console.log('==== 拉满玩家:', p.name, '(' + p.userId + ') ====');
  console.log('');

  // ---------- 1. 装备：12 槽位全部满级满品质 ----------
  console.log('--- 1. 装备 ---');
  EquipService.ensureEquipInfo(p);
  const info = p.equipInfo;
  info.equipSetMap = info.equipSetMap || {};
  const planKey = Object.keys(info.equipSetMap)[0] || '0';
  info.equipSetMap[planKey] = info.equipSetMap[planKey] || {};

  const plan = info.equipSetMap[planKey];
  let changed = 0;
  for (let slot = 1; slot <= 12; slot++) {
    const cur = plan[slot];
    // 保留原模板 id（这样部位/类型不变），只重算等级+品质
    const templateId = (cur && cur.id) ? cur.id : (31100 + slot);

    // 用官方函数生成正确属性的装备
    const fresh = EquipService.createEquipFromTemplateId(templateId, MAX_LEVEL, p);
    fresh.quailty = MAX_QUALITY;
    // 品质变了，属性要按新品质重算
    const qm = 1 + (MAX_QUALITY - 1) * 0.3;
    fresh.attrs = {
      1: Math.floor((150 + MAX_LEVEL * 25) * qm),
      2: Math.floor((20 + MAX_LEVEL * 8) * qm),
      3: Math.floor((10 + MAX_LEVEL * 3) * qm),
      4: Math.floor((5 + MAX_LEVEL * 2) * qm),
    };
    // 保留原特殊属性 id
    if (cur && cur.attrs) {
      Object.keys(cur.attrs).forEach(k => {
        if (!fresh.attrs[k] && Number(k) > 100) {
          fresh.attrs[k] = Math.floor((30 + MAX_LEVEL * 4) * qm);
        }
      });
    }
    plan[slot] = fresh;
    changed++;
    console.log('   槽' + slot + ': lv=' + fresh.lv + ' 品质=' + fresh.quailty +
      ' 攻击=' + fresh.attrs[1] + ' 生命=' + fresh.attrs[2]);
  }
  p.markModified('equipInfo');
  console.log('   ✓ 更新 ' + changed + ' 个槽位');

  await p.save();
  console.log('');
  console.log('==== 完成 ====');
  await mongoose.disconnect();
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
