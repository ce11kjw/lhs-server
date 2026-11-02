/* eslint-disable no-console */
/**
 * 直接从 _tables_dump 里已经解好的 JSON 表（AssetsConfig.json + LanguageConfig.json）
 * 生成 player.txt，格式：每行 "ID;name"，ID 升序。
 *
 * 运行：
 *   cd newServer/scripts
 *   node build-player-from-dumped.js
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const DUMP_DIR = path.join(SCRIPT_DIR, '_tables_dump');
const ASSETS_JSON = path.join(DUMP_DIR, 'AssetsConfig.json');
const LANG_JSON = path.join(DUMP_DIR, 'LanguageConfig.json');
const OUT_TXT = path.join(SCRIPT_DIR, 'player.txt');

if (!fs.existsSync(ASSETS_JSON) || !fs.existsSync(LANG_JSON)) {
  console.error('[build-player] ❌  缺少必要 JSON，请先跑 dump-all-items.js 生成 _tables_dump：\n   - 需存在：' + ASSETS_JSON + '\n   - 需存在：' + LANG_JSON);
  process.exit(1);
}

function normalizeName(n) {
  if (n === null || n === undefined) return null;
  let s = typeof n === 'number' ? String(n) : String(n);
  s = s.replace(/[\r\n\t\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

// 1. 建语言 ID → 中文名的 map
const lang = JSON.parse(fs.readFileSync(LANG_JSON, 'utf8'));
const langData = lang.data || {};
const langMap = new Map();
for (const [idStr, row] of Object.entries(langData)) {
  const id = Number(idStr);
  if (!id || !row || typeof row !== 'object') continue;
  const cn = row.cn;
  const s = normalizeName(cn);
  if (s) langMap.set(id, s);
}
console.log(`[build-player] 📚  LanguageConfig：共 ${Object.keys(langData).length} 条，其中合法中文 ${langMap.size} 条`);

// 2. 服务端硬编码货币（优先级最高，避免语言表被覆盖/误改）
const HARDCODED = [
  [1, '钻石（元宝）'],
  [2, '银币'],
  [6, '金币（加速符）'],
];
const items = new Map(HARDCODED);

// 3. 扫 AssetsConfig 的每条记录，按 name 字段查语言表
const assets = JSON.parse(fs.readFileSync(ASSETS_JSON, 'utf8'));
const assetsData = assets.data || {};
let assetsCount = 0;
let missingCount = 0;
const missingSamples = [];
for (const [idStr, row] of Object.entries(assetsData)) {
  const id = Number(idStr);
  if (!id || !row || typeof row !== 'object') continue;
  assetsCount++;
  if (items.has(id)) continue; // 硬编码不覆盖
  const nameId = Number(row.name);
  let name = null;
  if (nameId > 0 && langMap.has(nameId)) {
    name = langMap.get(nameId);
  } else if (typeof row.name === 'string') {
    const s = normalizeName(row.name);
    if (s) name = s;
  }
  if (name) {
    items.set(id, name);
  } else {
    missingCount++;
    if (missingSamples.length < 15) {
      missingSamples.push({ id, nameId, rawName: row.name });
    }
  }
}
console.log(`[build-player] 📦  AssetsConfig：共 ${assetsCount} 个物品，成功关联 name 的 ${assetsCount - missingCount} 个，缺失 ${missingCount} 个`);
if (missingSamples.length) {
  console.log('[build-player] ⚠  缺失样例（前15）：', JSON.stringify(missingSamples, null, 2));
}

// 4. ID 升序写 player.txt
const ids = Array.from(items.keys()).sort((a, b) => a - b);
const lines = [];
for (const id of ids) {
  const n = String(items.get(id) || '').replace(/\s+/g, ' ').replace(/;/g, '；').trim();
  if (!n) continue;
  lines.push(`${id};${n}`);
}
fs.writeFileSync(OUT_TXT, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

console.log(`[build-player] ✅  共写出 ${lines.length} 行 → ${OUT_TXT}`);
console.log('[build-player] 🔍  样例（前 20 条）：');
lines.slice(0, 20).forEach((ln) => console.log('   ' + ln));
console.log('[build-player] 🔍  样例（最后 10 条，ID 最大）：');
lines.slice(-10).forEach((ln) => console.log('   ' + ln));

console.log('\n[build-player] 📋  同步到服务器 GM 目录：');
console.log('   cp -f "' + OUT_TXT + '" /data/lhs/ht/gm/player.txt');
console.log('   cp -f "' + OUT_TXT + '" /www/wwwroot/game/gm/player.txt');
