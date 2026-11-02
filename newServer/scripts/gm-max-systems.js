/**
 * GM: 拉满 法相 / 法宝 / 转生 / 钓鱼
 * 用法: node scripts/gm-max-systems.js [玩家名]
 */
const mongoose = require('mongoose');
const cs = require('../src/services/ConfigService');

const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/lhs_s1001';
const NAME = process.argv[2] || 'admkk';

(async () => {
  await mongoose.connect(MONGO);
  const Player = require('../src/db/models/Player');
  const p = await Player.findOne({ name: NAME });
  if (!p) { console.error('玩家不存在'); process.exit(1); }

  const t = cs.loadAllTables();
  console.log('==== 拉满系统: ' + p.name + ' ====');
  console.log('');

  p.other_attr_info = p.other_attr_info && typeof p.other_attr_info === 'object' ? p.other_attr_info : {};

  // ================= 1. 法相 =================
  console.log('--- 1. 法相 specSpiritInfo ---');
  const sc = t['SpecSpiritConfig'];
  const bestByTag = {};
  Object.keys(sc).forEach(k => {
    const r = sc[k];
    if (!bestByTag[r.tag] || r.stage > bestByTag[r.tag].stage ||
        (r.stage === bestByTag[r.tag].stage && r.quality > bestByTag[r.tag].quality)) {
      bestByTag[r.tag] = r;
    }
  });

  const SLOT_TAGS = [101, 102, 103, 201, 202, 203];
  const maxLevel = 300;                        // SpecSpiritLevelConfig 上限
  const ss = {
    lv: maxLevel,
    exp: 0,
    score: 0,
    privilegeCount: 0,
    lastPrivilegeCheckTime: 0,
    rewardCount: 0,
    list: [],
    slots: {},
    slotLv: {},
    refineList: [1, 2, 3, 4, 5, 6, 7, 8],
    uidSeq: 1,
  };
  let uid = 1;
  SLOT_TAGS.forEach(tag => {
    const cfg = bestByTag[tag];
    if (!cfg) return;
    const spirit = {
      uid: uid,
      id: cfg.id,
      star: 8,              // SpecSpiritStarConfig 最大 stage=8
      suit: 0,
      exp: 0,
      lock: 0,
      entrys: [],
    };
    ss.list.push(spirit);
    ss.slots[tag] = uid;    // 槽位绑定
    ss.slotLv[tag] = 1;
    uid++;
  });
  ss.uidSeq = uid;
  p.other_attr_info.specSpiritInfo = ss;
  console.log('   ✓ 法相 lv=' + maxLevel + ', ' + ss.list.length + ' 个（各槽位最强，8 星）');
  ss.list.forEach(s => console.log('     uid=' + s.uid + ' id=' + s.id));

  // ================= 2. 法宝 =================
  console.log('');
  console.log('--- 2. 法宝 artifactInfo ---');
  const ac = t['ArtifactConfig'];
  const bestA = {};
  Object.keys(ac).forEach(k => {
    const r = ac[k];
    if (!bestA[r.type] || r.quality > bestA[r.type].quality) bestA[r.type] = r;
  });

  const art = {
    unlockSlots: [1, 2, 3, 4, 5, 6],
    list: [],
    equip: {},
    orb: {},
    uidSeq: 1,
  };
  let auid = 1;
  Object.keys(bestA).sort().forEach(ty => {
    const cfg = bestA[ty];
    art.list.push({
      uid: auid,
      id: cfg.id,
      level: 100,
      star: 10,
      attr: { level: 100, list: [] },
      bind: 0,
    });
    auid++;
  });
  art.uidSeq = auid;
  p.artifactInfo = art;
  console.log('   ✓ 法宝 ' + art.list.length + ' 个（各类型最强），槽位全开');
  art.list.forEach(a => console.log('     uid=' + a.uid + ' id=' + a.id));

  // ================= 3. 转生 =================
  console.log('');
  console.log('--- 3. 转生 rebornSimInfo ---');
  const rc = t['RebornSimChapterConfig'];
  const maxChapter = rc
    ? Math.max(...Object.keys(rc).map(Number).filter(n => !isNaN(n)))
    : 1;
  const rb = {
    open: 1,
    clearChapter: maxChapter,
    rewardChapter: maxChapter,
    bagMax: 7,
    oldData: [],
    dailyChapterReward: {},
    currentInit: null,
    currentData: null,
  };
  p.other_attr_info.rebornSimInfo = rb;
  console.log('   ✓ 转生 open=1, clearChapter=' + maxChapter + '(最高)');

  // ================= 4. 钓鱼 =================
  console.log('');
  console.log('--- 4. 钓鱼 fishInfo ---');
  const fc = t['FishConfig'];
  const fishList = Object.keys(fc).map(k => Number(k)).filter(n => !isNaN(n));
  const fi = {
    open: 1,
    level: 40,             // FishLevelConfig 40 级上限
    exp: 0,
    rodRank: 10,
    bait: {},
    list: fishList.slice(0, 50).map(id => ({ id: id, star: 5, count: 1 })),
    orderDone: [],
    score: 0,
  };
  p.fishInfo = fi;
  console.log('   ✓ 钓鱼 open=1, lv=40, 鱼获 ' + fi.list.length + ' 种, 鱼竿满级');

  p.markModified('other_attr_info');
  await p.save();

  console.log('');
  console.log('==== 完成，全部已保存 ====');
  await mongoose.disconnect();
})().catch(e => { console.error('失败:', e.message, e.stack); process.exit(1); });
