/* eslint-disable no-console */
/**
 * 从客户端 bin 配置里提取 物品ID+名称，生成 player.txt。
 *
 * 运行方式：
 *   cd newServer
 *   node scripts/dump-all-items.js
 *   node scripts/dump-all-items.js --config /www/wwwroot/game/update/resource/assets/excel --output /www/wwwroot/game/ht/gm/player.txt
 *
 * 输出格式（必须跟 getitems.php 兼容）：每行 `ID + 空格 + 名称`，ID 升序。
 * 第一行会额外合并 服务端硬编码货币映射（ID=1/2/6），保证 GM 下拉能正确覆盖 currencies 字段。
 */

const path = require('path');
const fs = require('fs');

// 解析命令行参数
function parseArgv(argv) {
  const args = {
    config: null,
    output: null,
    dumpTables: true,           // 默认开启：解包 bin 后把每张表写成单独 JSON（人工一眼可见）
    dumpTablesDir: null,        // 不指定就放 scripts/_tables_dump
    previewTables: 12,          // 控制台打印前 N 张"最大的表"首行完整 JSON
    sampleRows: 2,              // 每张预览表打印几行样例
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--config' || k === '-c') args.config = argv[++i];
    else if (k === '--output' || k === '-o') args.output = argv[++i];
    else if (k === '--dump-tables-dir') args.dumpTablesDir = argv[++i];
    else if (k === '--dump-tables' || k === '--dump') args.dumpTables = true;
    else if (k === '--no-dump-tables' || k === '--no-dump') args.dumpTables = false;
    else if (k === '--preview-tables') args.previewTables = Math.max(0, Number(argv[++i] || 0) || 0);
    else if (k === '--sample-rows') args.sampleRows = Math.max(0, Number(argv[++i] || 0) || 0);
    else if (k === '--help' || k === '-h') {
      console.log(
        '用法: node scripts/dump-all-items.js [选项]\n' +
        '  -c, --config <dir>                 指定客户端 excel 目录（config_*.bin 所在目录的父目录也行，会自动找）\n' +
        '  -o, --output <file>                指定生成的 player.txt 输出路径（默认：scripts/player.txt）\n' +
        '      --dump-tables-dir <dir>        把 bin 解出来的每张表写成 <dir>/表名.json，默认：scripts/_tables_dump\n' +
        '      --no-dump-tables               禁止落盘 JSON（只生成 player.txt）\n' +
        '      --preview-tables <N>           控制台预览前 N 张大表首行（默认 12）\n' +
        '      --sample-rows <N>              每张预览表打印 N 行样例（默认 2）\n'
      );
      process.exit(0);
    }
  }
  return args;
}

// 规范化 id：必须为 >0 的整数（字符串/数字都行）
function toPositiveId(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'bigint') return v > 0 ? Number(v) : 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 0;
  return n;
}

// 规范化名称：去掉换行/tab 等控制字符，trim，空字符串返回 null
function normalizeName(n) {
  if (n === null || n === undefined) return null;
  let s = typeof n === 'number' ? String(n) : String(n);
  s = s.replace(/[\r\n\t\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

// 从 row 里尽量挖出 id/name
const NAME_KEYS = [
  // 常见命名
  'name', 'Name', 'NAME', 'itemName', 'ItemName', 'ITEM_NAME', 'item_name',
  'goodsName', 'GoodsName', 'goods_name', 'propName', 'PropName', 'prop_name',
  'heroName', 'HeroName', 'hero_name', 'equipName', 'EquipName', 'equip_name',
  'petName', 'PetName', 'pet_name', 'fashionName', 'FashionName', 'swordName',
  'skinName', 'mountName', 'avatarName', 'skillName', 'SkillName', 'skill_name',
  'copyName', 'dungeonName', 'chapterName', 'missionName', 'taskName', 'questName',
  'rewardName', 'bundleName', 'packName', 'giftName', 'boxName', 'title', 'Title',
  'desc', 'Desc', 'description', 'Description', 'tips', 'Tips', 'info', 'Info',
  // 短名 & 配置端常见
  'sName', 'SName', 's_name', 'cfgName', 'CfgName', 'cfg_name', 'configName', 'ConfigName',
  'config_name', 'displayName', 'DisplayName', 'display_name', 'showName', 'ShowName',
  'show_name', 'viewName', 'ViewName', 'strName', 'StrName', 'nameStr',
  'shortName', 'ShortName', 'fullName', 'FullName', 'full_name',
  'text', 'Text', 'label', 'Label', 'content', 'Content', 'cn', 'CN', 'zh', 'ZH',
  'name_cn', 'name_zh', 'NameCn', 'NameZh', 'desc_cn', 'desc_zh', 'DescCn', 'DescZh',
];
const ID_KEYS = [
  'id', 'Id', 'ID', 'itemId', 'ItemId', 'itemID', 'ITEM_ID', 'item_id',
  'goodsId', 'GoodsId', 'goods_id', 'propId', 'PropId', 'prop_id',
  'heroId', 'HeroId', 'hero_id', 'equipId', 'EquipId', 'equip_id',
  'petId', 'PetId', 'pet_id', 'configId', 'ConfigId', 'config_id',
  'cfgId', 'CfgId', 'cfg_id', 'rewardId', 'RewardId', 'reward_id',
  'packId', 'giftId', 'boxId', 'bundleId', 'copyId', 'chapterId', 'missionId',
  'taskId', 'questId', 'skillId', 'skinId', 'mountId', 'templateId', 'TplId',
  'tplId', 'tpid', 'tpId', 'tp_id', 'iid', 'IId', 'iidStr', 'key', 'Key',
];
function pickId(row, hintOuterKey) {
  if (Array.isArray(row)) {
    // 数组行：顺序列里，前 5 个位置里第一个合法正整数通常就是 id
    for (let i = 0; i < Math.min(row.length, 8); i++) {
      const n = toPositiveId(row[i]);
      if (n) return n;
    }
    return 0;
  }
  if (!row || typeof row !== 'object') {
    // 传入 hintOuterKey 是 { id: {...} } 这种对象的 key
    return toPositiveId(hintOuterKey);
  }
  for (const k of ID_KEYS) if (row[k] !== undefined) { const n = toPositiveId(row[k]); if (n) return n; }
  const hk = toPositiveId(hintOuterKey);
  if (hk) return hk;
  return 0;
}
// 判断是不是"纯数字串"，或者只是 id/数字编码（长度≥6、纯数字）——这种不要当 name
function looksLikeIdStr(s) {
  if (!s) return true;
  if (/^\d+$/.test(s)) return true;
  if (/^[-_]?\d+[-_]?\d*$/.test(s)) return true;
  if (/^[0-9a-fA-F]{8,}$/.test(s)) return true; // 纯16进制
  return false;
}
function looksLikePlainText(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length < 1 || s.length > 60) return false;
  if (/^\s+$/.test(s)) return false;
  if (/[<>{};]/.test(s)) return false; // 有这些奇怪符号一般不是名称
  // 至少带一个"中文字母"字符，才更像"名称"，而不是数值/编码
  const hasCN = /[\u4e00-\u9fa5]/.test(s);
  const hasEN = /[A-Za-z]/.test(s);
  if (!hasCN && !hasEN) return false;
  return true;
}
const LANG_ID_KEYS = [
  'nameId','NameId','NAME_ID','name_id','nameIdx','textId','TextId','text_id',
  'strId','StrId','str_id','langId','LangId','lang_id','titleId','TitleId','title_id',
  'labelId','LabelId','descId','DescId','desc_id','sId','sid','IDText','textKey',
  'TID','tid','Tid','locId','loc_id','i18nId','msgId','keyId','contentId','content_id',
];
function pickName(row, langMap) {
  // 情形 1：数组行（顺序列结构）。常见是 [id, name, type, quality, desc,...]
  if (Array.isArray(row)) {
    let best = null; let bestScore = -1;
    for (let i = 0; i < Math.min(row.length, 12); i++) {
      const s = normalizeName(row[i]);
      if (!s || s.length < 2 || s.length > 40 || looksLikeIdStr(s)) continue;
      let score = 0;
      if (/[\u4e00-\u9fa5]/.test(s)) score += 2;
      if (looksLikePlainText(s)) score += 1;
      if (i >= 1 && i <= 3) score += 1; // 第 2~4 列最像名称
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best && bestScore >= 1) return best;

    // 数组行兜底：里面某个元素是 langId，就去 langMap 查
    if (langMap && langMap.size) {
      for (let i = 0; i < Math.min(row.length, 12); i++) {
        const lid = toPositiveId(row[i]);
        if (!lid) continue;
        const s = langMap.get(lid);
        if (s && !looksLikeIdStr(s)) return s;
      }
    }
    return null;
  }

  if (!row || typeof row !== 'object') return null;

  // 情形 2：直接 name 字段命中
  for (const k of NAME_KEYS) {
    if (row[k] === undefined || row[k] === null) continue;
    const s = normalizeName(row[k]);
    if (!s) continue;
    if (looksLikeIdStr(s)) continue; // 过滤"字段名像 name 但值是 id"的假命中
    if (s.length >= 2) return s;
  }

  // 情形 3：nameId / textId 指向多语言表，去 langMap 查（很多项目 items 表里只有 nameId）
  if (langMap && langMap.size) {
    for (const k of LANG_ID_KEYS) {
      if (row[k] === undefined || row[k] === null) continue;
      const lid = toPositiveId(row[k]);
      if (!lid) continue;
      const s = langMap.get(lid);
      if (s && !looksLikeIdStr(s) && s.length >= 2) return s;
    }
    // 最后兜底：任何正整数字段去 langMap 里查到能当 name 的也接受
    const vals = Object.values(row);
    for (const v of vals) {
      const lid = toPositiveId(v);
      if (!lid) continue;
      const s = langMap.get(lid);
      if (s && !looksLikeIdStr(s) && s.length >= 2) return s;
    }
  }

  // 情形 4：兜底：扫所有字段，挑"最像名称"的那一个（非纯数字、长度 2~40、含中文/字母）
  let fallback = null;
  let fallbackScore = -1;
  const entries = Object.entries(row);
  for (const [k, v] of entries) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = normalizeName(v);
    if (!s || s.length < 2 || s.length > 40) continue;
    if (looksLikeIdStr(s)) continue;
    // 评分：包含中文 +2，长度 2~8 +2，9~20 +1；字段名里带 name/title/desc +2
    let score = 0;
    if (/[\u4e00-\u9fa5]/.test(s)) score += 2;
    if (/[A-Za-z\u4e00-\u9fa5]/.test(k)) {
      const kk = k.toLowerCase();
      if (/name|title|desc|tips|label|text|content|zh|cn/.test(kk)) score += 2;
    }
    if (s.length <= 20) score += 1;
    if (looksLikePlainText(s)) score += 1;
    if (score > fallbackScore) { fallbackScore = score; fallback = s; }
  }
  if (fallback && fallbackScore >= 1) return fallback;
  return null;
}

// 从任意结构里递归收集 { id, name }
function scanValue(v, out, langMap, ctx) {
  if (!ctx) ctx = {};
  ctx.depth = (ctx.depth || 0);
  if (ctx.depth > 12) return;
  if (v === null || v === undefined) return;

  // 数组：每个元素自己也可能是 row（尤其是数组行 [id,name,...] 这种）
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const el = v[i];
      if (el && typeof el === 'object') {
        const id = pickId(el, null);
        const name = pickName(el, langMap);
        if (id) {
          if (name && !out.has(id)) out.set(id, name);
          else if (ctx.missingSamples && ctx.missingSamples.length < 120 && !name) {
            ctx.missingSamples.push({ id, table: ctx.table || null, row: el });
          }
        }
      }
      scanValue(el, out, langMap, { depth: ctx.depth + 1, table: ctx.table, missingSamples: ctx.missingSamples });
    }
    return;
  }

  if (typeof v === 'object') {
    // A. 整对象本身是 row（key/value 命名表）
    const id1 = pickId(v, null);
    const name1 = pickName(v, langMap);
    if (id1) {
      if (name1 && !out.has(id1)) out.set(id1, name1);
      else if (ctx.missingSamples && ctx.missingSamples.length < 120 && !name1) {
        ctx.missingSamples.push({ id: id1, table: ctx.table || null, row: v });
      }
    }

    // B. 遍历子属性；如果外层 key 是正整数，说明结构可能是 { 30033746: {...} }，把外层 key 当 fallback id
    const ks = Object.keys(v);
    for (const k of ks) {
      const child = v[k];
      const outerId = toPositiveId(k);
      if (outerId && child && typeof child === 'object') {
        let cId = pickId(child, outerId);
        if (!cId) cId = outerId;
        const cName = pickName(child, langMap);
        if (cId) {
          if (cName && !out.has(cId)) out.set(cId, cName);
          else if (ctx.missingSamples && ctx.missingSamples.length < 120 && !cName) {
            ctx.missingSamples.push({ id: cId, table: ctx.table || null, row: child, objectKeyAsId: true });
          }
        }
      }
      scanValue(child, out, langMap, { depth: ctx.depth + 1, table: ctx.table, missingSamples: ctx.missingSamples });
    }
  }
}

// ===== 建立多语言/字符串表 id→文案 的 map（items 表里常只存 nameId，这里先把所有"像语言表"的都收一下）=====
function buildLangMap(tables) {
  const lang = new Map();
  if (!tables || typeof tables !== 'object') return lang;

  // 1) 表名本身像语言/字符串表：按整张表结构分别处理
  const nameHints = /language|lang|string|text|i18n|loc|local|localization|translate|word|dict|speech|tip|tips|notice|message|msg/i;
  for (const tableName of Object.keys(tables)) {
    const t = tables[tableName];
    if (!t || typeof t !== 'object') continue;
    const nameLike = nameHints.test(tableName);

    // 1A. { 123: '中文文案' } 这种纯 id→string 的 Map
    if (!Array.isArray(t)) {
      const entries = Object.entries(t);
      let good = 0;
      let bad = 0;
      let allScalar = true;
      const bucket = new Map();
      for (const [k, val] of entries) {
        const id = toPositiveId(k);
        if (!id) { allScalar = false; break; }
        if (val === null || val === undefined) { bad++; continue; }
        if (typeof val === 'string' || typeof val === 'number') {
          const s = normalizeName(val);
          if (s && !looksLikeIdStr(s) && s.length >= 2 && s.length <= 60) {
            bucket.set(id, s);
            good++;
          } else {
            bad++;
          }
        } else {
          allScalar = false;
          break;
        }
      }
      if (allScalar && (nameLike || (good >= 100 && good >= bad * 2))) {
        for (const [id, s] of bucket) if (!lang.has(id)) lang.set(id, s);
        continue;
      }

      // 1B. { 123: {id:123, cn:'xxx', en:'xxx'} } 这种对象 Map
      const subEntries = entries.slice(0, Math.min(entries.length, 500));
      let score = 0;
      const bucket2 = new Map();
      for (const [k, val] of subEntries) {
        if (!val || typeof val !== 'object') continue;
        const id = toPositiveId(k) || pickId(val, null);
        if (!id) continue;
        // 优先中文列
        let s = null;
        for (const col of ['cn','zh','zh_CN','zhCN','zh-cn','chs','sc','simplified','Chinese','chinese','CN','ZH','cnName','zhName','cn_text','zh_text','text_cn','text_zh','Content','content','Text','text','Label','label','name','Name','desc','Desc','title','Title']) {
          if (val[col] !== undefined) {
            const t = normalizeName(val[col]);
            if (t && !looksLikeIdStr(t) && t.length >= 2 && t.length <= 60) { s = t; break; }
          }
        }
        if (s) {
          bucket2.set(id, s);
          score += 1;
        }
      }
      if (nameLike || score >= 30) {
        for (const [id, s] of bucket2) if (!lang.has(id)) lang.set(id, s);
      }
      continue;
    }

    // 1C. 数组型表（每列一个语言）[{id:1, zh:'xx', en:'yy'}, ...]
    if (Array.isArray(t) && t.length) {
      let score = 0;
      const bucket3 = new Map();
      const cols = new Set();
      const first = t.find((e) => e && typeof e === 'object' && !Array.isArray(e));
      if (first) for (const k of Object.keys(first)) cols.add(k);
      const sample = t.slice(0, Math.min(t.length, 500));
      for (const row of sample) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const id = pickId(row, null);
        if (!id) continue;
        let s = null;
        for (const col of ['cn','zh','zh_CN','zhCN','zh-cn','chs','sc','Chinese','chinese','CN','ZH','cnName','zhName','cn_text','zh_text','text_cn','text_zh','Content','content','Text','text','Label','label','name','Name','desc','Desc','title','Title','tips','msg']) {
          if (row[col] !== undefined) {
            const t2 = normalizeName(row[col]);
            if (t2 && !looksLikeIdStr(t2) && t2.length >= 2 && t2.length <= 60) { s = t2; break; }
          }
        }
        if (s) { bucket3.set(id, s); score += 1; }
      }
      if (nameLike || (score >= 30 && score >= sample.length * 0.2)) {
        for (const [id, s] of bucket3) if (!lang.has(id)) lang.set(id, s);
      }
    }
  }

  return lang;
}

// ===== 主流程 =====
(async function main() {
  const args = parseArgv(process.argv);

  // === 默认输出：固定写在“脚本所在目录”下，满足“直接在当前js目录下生成提取后的物品表” ===
  //   不管你在哪个 cwd 下跑 node dump-all-items.js，player.txt 都会落在 newServer/scripts/player.txt
  const scriptDir = __dirname;
  const defaultOut = path.join(scriptDir, 'player.txt');
  const outFile = args.output ? path.resolve(args.output) : defaultOut;

  // === 默认 bin 目录：先按旧相对路径找，找不到就做一堆 fallback（适配服务器路径差异） ===
  const DEFAULT_BIN_CANDIDATES = [
    // ① Windows 开发机相对路径（原默认）
    path.resolve(__dirname, '..', '..', 'lhs_h5_mirror', 'update', 'resource', 'assets', 'excel'),
    // ② 你 cwd 下直接叫 excel / update/resource/assets/excel
    path.resolve(process.cwd(), 'excel'),
    path.resolve(process.cwd(), 'update', 'resource', 'assets', 'excel'),
    path.resolve(process.cwd(), '..', 'lhs_h5_mirror', 'update', 'resource', 'assets', 'excel'),
    // ③ 服务器上 Nginx 静态资源根 /www/wwwroot/game（最常见的生产目录）
    '/www/wwwroot/game/update/resource/assets/excel',
    '/www/wwwroot/game/resources/assets/excel',
    '/www/wwwroot/game/assets/excel',
    '/www/wwwroot/game/excel',
    // ④ /data/lhs 下放的前端资源
    '/data/lhs/game/update/resource/assets/excel',
    '/data/lhs/game/resources/assets/excel',
    '/data/lhs/update/resource/assets/excel',
  ];

  // 给候选做一下去重 + 过滤存在 + 确认里面真有 .bin（不是空目录）
  function hasBinFile(dir) {
    try {
      const names = fs.readdirSync(dir);
      return names && names.some((n) => n.endsWith('.bin'));
    } catch (_e) {
      return false;
    }
  }

  let binDir = null;
  if (args.config) {
    binDir = path.resolve(args.config);
    if (!fs.existsSync(binDir)) {
      console.error(`[dump-all-items] ❌  --config 指定的目录不存在：${binDir}`);
      process.exit(1);
    }
  } else {
    const uniqueCandidates = [];
    const seen = new Set();
    for (const p of DEFAULT_BIN_CANDIDATES) {
      const key = String(p).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueCandidates.push(p);
    }
    for (const p of uniqueCandidates) {
      if (fs.existsSync(p) && hasBinFile(p)) { binDir = p; break; }
    }
    // 最后兜底：在 /data/lhs 和 /www/wwwroot 下面深度搜索一下"存在 .bin 的 excel/assets/excel 目录"（最多查 6 层）
    if (!binDir) {
      const SEARCH_ROOTS = ['/data/lhs', '/www/wwwroot', '/www', process.cwd()];
      function walk(dir, depth) {
        if (depth > 6) return null;
        let names;
        try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return null; }
        const subDirs = [];
        let hasAnyBin = false;
        for (const e of names) {
          if (!e) continue;
          if (e.isFile() && String(e.name).endsWith('.bin')) hasAnyBin = true;
          else if (e.isDirectory()) subDirs.push(e.name);
        }
        const base = path.basename(dir).toLowerCase();
        const isLikeExcelDir = base === 'excel' || base === 'assets' || base.endsWith('config');
        if (hasAnyBin && (isLikeExcelDir || subDirs.length <= 20)) return dir;
        for (const s of subDirs) {
          const r = walk(path.join(dir, s), depth + 1);
          if (r) return r;
        }
        return null;
      }
      for (const root of SEARCH_ROOTS) {
        if (!fs.existsSync(root)) continue;
        const found = walk(root, 0);
        if (found) { binDir = found; break; }
      }
    }
    if (!binDir) {
      const pretty = uniqueCandidates.map((p) => `    - ${p}`).join('\n');
      console.error(
        '[dump-all-items] ❌  没有找到存放 config_*.bin 的 excel 目录。\n' +
        '  已按顺序尝试（且都不存在或目录内没有 .bin 文件）：\n' + pretty + '\n' +
        '  请使用:  node dump-all-items.js --config "/绝对路径/excel(里面要能看到 config_xxxx.bin)"  --output "/绝对路径/player.txt"'
      );
      process.exit(1);
    }
  }

  console.log('[dump-all-items] 运行目录  :', process.cwd());
  console.log('[dump-all-items] 脚本目录  :', scriptDir);
  console.log('[dump-all-items] bin 目录  :', binDir);

  // ===== 关键修复：ConfigService.loadAllTables(configPath) 需要的是“单个打包好的 .bin 文件路径”，
  //       而不是 .bin 所在目录。传目录会触发 fs.readFileSync(dir) → EISDIR 报错。
  //       这里在 binDir 下选 1 个真实存在、非空的 .bin 作为 configPath：
  //         优先级：config_*.bin(匹配生产命名) > 其它 *.bin
  // 递归 walk 收集 dir 下所有子目录里的 .bin（关键：lang_cn/ 这种子目录也会被扫到）
  function walkAllBinFiles(dir) {
    const out = [];
    function dfs(cur) {
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_e) { return; }
      const subs = [];
      for (const e of entries) {
        if (!e) continue;
        const full = path.join(cur, e.name);
        if (e.isFile() && String(e.name).toLowerCase().endsWith('.bin')) {
          let size = 0;
          try { size = fs.statSync(full).size; } catch (_e2) { /* ignore */ }
          if (size > 0) out.push({ name: e.name, path: full, size, dir: cur });
        } else if (e.isDirectory()) {
          subs.push(full);
        }
      }
      for (const s of subs) dfs(s);
    }
    dfs(dir);
    return out;
  }
  let allConfigs = walkAllBinFiles(binDir);
  // 如果直接选中的目录里递归也没 .bin（fallback walk 可能返回了上一层 assets），就再试常见子目录
  if (!allConfigs.length) {
    const commonSub = ['excel', 'resources', 'update/resource/assets/excel', 'assets/excel', 'assets/resources/excel'];
    for (const sub of commonSub) {
      const p = path.join(binDir, sub);
      const arr = walkAllBinFiles(p);
      if (arr.length) { binDir = p; allConfigs = arr; break; }
    }
  }
  if (!allConfigs.length) {
    console.error(`[dump-all-items] ❌  ${binDir} 及其所有子目录里没有找到任何非空 .bin 文件，无法继续`);
    process.exit(4);
  }
  function fileSize(p) { try { return fs.statSync(p).size; } catch (_e) { return 0; } }
  const CONFIG_PREFIX = 'config_';
  // config_*.bin 通常是"主表/主配置"，放前面先加载；其它（语言包/扩展包）放后面覆盖式合并
  const cfs = allConfigs.filter((f) => f.name.startsWith(CONFIG_PREFIX)).sort((a, b) => a.size - b.size);
  const others = allConfigs.filter((f) => !f.name.startsWith(CONFIG_PREFIX)).sort((a, b) => a.size - b.size);
  const orderedBinFiles = cfs.length ? [...cfs, ...others] : others;
  console.log(`[dump-all-items] 📦  共发现 ${orderedBinFiles.length} 个非空 .bin（递归包含 lang_* 子目录）：`);
  orderedBinFiles.forEach((f, i) => {
    const rel = path.relative(binDir, f.dir) || '.';
    console.log(`   #${String(i + 1).padStart(2, ' ')}  ${(f.size / 1024).toFixed(1).padStart(8, ' ')} KiB  ${rel}/${f.name}`);
  });
  console.log('[dump-all-items] 输出文件  :', outFile);

  // --- 1. 服务端硬编码货币映射（优先级最高，不能被客户端表覆盖）---
  const HARDCODED = new Map([
    [1, '钻石（diamond）'],
    [2, '银币（silver）'],
    [6, '金币（gold / 加速符）'],
  ]);
  const items = new Map(HARDCODED);

  // --- 2. 逐个 .bin 让 ConfigService 解析，并把所有同名表合并（后面的 bin 覆盖前面的）
  //       原因：主表（AssetsConfig 等）和语言表（Language/StringConfig 等）常常分开放在
  //       不同 bin 文件里（比如 lang_cn/config_lang_xxx.bin），只解析 1 个 bin 会缺语言包。
  delete require.cache[require.resolve('../src/services/ConfigService')];
  const ConfigService = require('../src/services/ConfigService');
  const tables = {};
  let succeeded = 0;
  for (const f of orderedBinFiles) {
    try {
      process.env.CONFIG_BIN_PATH = f.path;
      ConfigService.reload(f.path);
      const partial = ConfigService.loadAllTables(f.path);
      if (partial && typeof partial === 'object') {
        const pKeys = Object.keys(partial);
        for (const k of pKeys) tables[k] = partial[k];
        console.log(`[dump-all-items]  ✔  解析 ${f.name}  OK，新增/覆盖 ${pKeys.length} 张表`);
        succeeded++;
      } else {
        console.warn(`[dump-all-items]  ⚠  解析 ${f.name}  返回空对象，跳过`);
      }
    } catch (e) {
      console.warn(`[dump-all-items]  ⚠  解析 ${f.name}  失败：${e.message}（已跳过，不影响其它 bin）`);
    }
  }
  if (!succeeded) {
    console.error('[dump-all-items] ❌  所有 bin 都解析失败，ConfigService.loadAllTables 没有返回任何 tables');
    process.exit(3);
  }
  const keys = Object.keys(tables);
  console.log(`[dump-all-items] ✅  ConfigService 解出 ${keys.length} 张配置表：`);
  function oneLineKeys(v) {
    try {
      if (Array.isArray(v) && v.length) {
        const first = v.find((e) => e && typeof e === 'object' && !Array.isArray(e)) || v[0];
        if (first && typeof first === 'object') return Object.keys(first).slice(0, 20).join(',');
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const firstKey = Object.keys(v)[0];
        if (firstKey !== undefined) {
          const e = v[firstKey];
          if (e && typeof e === 'object' && !Array.isArray(e)) return Object.keys(e).slice(0, 20).join(',');
          if (Array.isArray(e)) {
            const first = e.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || e[0];
            if (first && typeof first === 'object') return Object.keys(first).slice(0, 20).join(',');
          }
        }
        return `(obj)[${Object.keys(v).slice(0, 5).join('|')}]`;
      }
      return typeof v;
    } catch (_e) {
      return '-';
    }
  }
  function sizeHint(v) {
    if (Array.isArray(v)) return v.length + '[]';
    if (v && typeof v === 'object') return Object.keys(v).length + '{}';
    return typeof v;
  }
  keys.slice(0, 40).forEach((k) => {
    const v = tables[k];
    console.log(`  - ${String(k).padEnd(40, ' ')} size=${String(sizeHint(v)).padEnd(10, ' ')} keys=${oneLineKeys(v)}`);
  });
  if (keys.length > 40) console.log(`  ... (其余 ${keys.length - 40} 张省略)`);

  // ===== 关键：直接"解包 bin → 每张表单独写成 JSON 文件"。 =====
  let dumpDir = null;
  if (args.dumpTables) {
    dumpDir = args.dumpTablesDir ? path.resolve(args.dumpTablesDir) : path.join(__dirname, '_tables_dump');
    if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
    function safeFileName(name) {
      let s = String(name || '').trim();
      if (!s) return `__unnamed_${Math.random().toString(36).slice(2, 8)}`;
      s = s.replace(/[\\/:*?"<>|\s]+/g, '_');
      if (s.length > 120) s = s.slice(0, 120);
      return s;
    }
    function countEntries(v) {
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === 'object') return Object.keys(v).length;
      return 0;
    }
    function sampleRows(v, maxRows) {
      const out = [];
      if (Array.isArray(v)) {
        for (let i = 0; i < Math.min(maxRows, v.length); i++) {
          const row = v[i];
          if (row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length <= 200) out.push(row);
          else if (Array.isArray(row) && row.length <= 200) out.push(row);
          else out.push(typeof row === 'string' || typeof row === 'number' ? row : '[truncated]');
        }
      } else if (v && typeof v === 'object') {
        const entries = Object.entries(v);
        for (let i = 0; i < Math.min(maxRows, entries.length); i++) {
          const [k2, val] = entries[i];
          if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length <= 200) out.push({ [k2]: val });
          else if (Array.isArray(val) && val.length <= 200) out.push({ [k2]: val });
          else out.push({ [k2]: typeof val === 'string' || typeof val === 'number' ? val : '[truncated]' });
        }
      }
      return out;
    }
    const index = [];
    let written = 0;
    for (const tableName of keys) {
      const data = tables[tableName];
      const entriesCount = countEntries(data);
      const firstKeys = oneLineKeys(data);
      const fn = `${safeFileName(tableName)}.json`;
      const full = path.join(dumpDir, fn);
      try {
        let payload = null;
        try {
          payload = JSON.stringify(
            {
              _table: tableName,
              _rows: entriesCount,
              _type: Array.isArray(data) ? 'array' : (data && typeof data === 'object' ? 'object' : typeof data),
              _firstKeys: firstKeys,
              _sample: sampleRows(data, 3),
              data,
            },
            (k2, v2) => (typeof v2 === 'bigint' ? Number(v2) : v2),
            2
          );
        } catch (_e) {
          // 某些包含循环/Buffer 的结构，换稳妥格式：去掉 data 本体只放 sample
          payload = JSON.stringify(
            {
              _table: tableName,
              _rows: entriesCount,
              _type: Array.isArray(data) ? 'array' : (data && typeof data === 'object' ? 'object' : typeof data),
              _firstKeys: firstKeys,
              _sample: sampleRows(data, 5),
              _note: '完整data 无法 JSON.stringify（可能含循环引用/Buffer），请调整代码单独导出',
            },
            (k2, v2) => (typeof v2 === 'bigint' ? Number(v2) : v2),
            2
          );
        }
        fs.writeFileSync(full, payload, 'utf8');
        index.push({
          table: tableName,
          file: fn,
          rows: entriesCount,
          type: Array.isArray(data) ? 'array' : (data && typeof data === 'object' ? 'object' : typeof data),
          firstKeys,
        });
        written++;
      } catch (e) {
        console.warn(`[dump-all-items] ⚠️  写出表 ${tableName} 到 ${fn} 失败：${e.message}`);
      }
    }
    fs.writeFileSync(path.join(dumpDir, 'tables-index.json'), JSON.stringify(index, null, 2), 'utf8');
    console.log(`[dump-all-items] 🗂️  bin 解包 JSON 目录: ${dumpDir}`);
    console.log(`[dump-all-items] ✅  共写出 ${written}/${keys.length} 张表 JSON + tables-index.json（清单）`);
    console.log('[dump-all-items] 📌  直接用 VSCode/记事本打开上面目录，按表名/行数大小找到物品表，复制其中任一行结构贴给我就能100%抓对 name。');
    console.log('[dump-all-items] 📌  快速入口：先看 tables-index.json，按 rows 排序定位最大的几张表，通常 Items/Goods/Hero 这种配置表行数都在前几名。');

    if (args.previewTables > 0) {
      // 按行数取前 N 大的表打印样例，方便不打开文件也能快速扫一眼
      const sorted = index.slice().sort((a, b) => b.rows - a.rows).slice(0, args.previewTables);
      const sr = Math.max(1, args.sampleRows || 1);
      console.log(`\n[dump-all-items] 🗒️  前 ${sorted.length} 张大表预览（每张表 ${sr} 行样例）：`);
      for (const meta of sorted) {
        try {
          const fp = path.join(dumpDir, meta.file);
          const raw = fs.readFileSync(fp, 'utf8');
          const obj = JSON.parse(raw);
          const samples = Array.isArray(obj && obj._sample) ? obj._sample.slice(0, sr) : [];
          console.log(`\n---- TABLE: ${meta.table}  rows=${meta.rows}  type=${meta.type}  file=${meta.file}  ----`);
          samples.forEach((s, i) => console.log(`  #${i + 1}: ${JSON.stringify(s, null, 2).split('\n').map((ln, j) => (j === 0 ? ln : '       ' + ln)).join('\n')}`));
        } catch (_e) { /* ignore */ }
      }
    }
  } else {
    console.log('[dump-all-items] ⏭️  已关闭 bin 解包落盘（--no-dump-tables），如需直接查看表结构请去掉该参数。');
  }

  // --- 2.5. 先扫描建立 多语言/字符串表 id→中文文案 的映射（很多项目 items 表里只存 nameId 不存中文名）---
  const langMap = buildLangMap(tables);
  console.log(`[dump-all-items] 📚  多语言/字符串表：命中 ${langMap.size} 条 id→文案`);
  if (langMap.size) {
    const sampleIds = Array.from(langMap.keys()).slice(0, 10);
    sampleIds.forEach((id) => {
      console.log(`    lang ID=${String(id).padStart(6, ' ')}  →  ${JSON.stringify(langMap.get(id))}`);
    });
  }

  // --- 3. 逐张表递归扫描 id/name（同时收集"拿到 id 但没拿到 name"的样本，最后打印帮你调字段）---
  const missingSamples = [];
  let scannedTables = 0;
  for (const k of keys) {
    try {
      scanValue(tables[k], items, langMap, { depth: 0, table: k, missingSamples });
      scannedTables++;
    } catch (e) {
      console.warn(`[dump-all-items] ⚠️  扫描表 ${k} 跳过：${e.message}`);
    }
  }
  console.log(`[dump-all-items] 扫描完成：共 ${scannedTables} 张表，合并后去重物品数 ${items.size}（含硬编码货币）`);

  // --- 3.5. 打印"有 id 但没 name"的前 5 条样本 JSON（按 id 去重），下次一看就知道字段结构 ---
  const uniqMissing = [];
  const seenMissing = new Set();
  for (const m of missingSamples) {
    const idK = String(m.id || '');
    if (!idK || seenMissing.has(idK)) continue;
    seenMissing.add(idK);
    uniqMissing.push(m);
    if (uniqMissing.length >= 5) break;
  }
  if (uniqMissing.length) {
    console.log('[dump-all-items] ⚠️  以下是 “拿到 id 但仍然没抓到 name”的样例（请把这一段整段贴给我就能补到字段）：');
    uniqMissing.forEach((m, idx) => {
      const line = JSON.stringify({
        sample: idx + 1,
        id: m.id,
        table: m.table || '(unknown)',
        objectKeyAsId: !!m.objectKeyAsId,
        row: m.row,
      }, null, 2);
      // 避免刷屏，如果太大就截断
      const truncated = line.length > 2400 ? line.slice(0, 2400) + '\n... (JSON过长已截断，请缩短后再贴)' : line;
      console.log(truncated);
    });
  } else {
    console.log('[dump-all-items] ✅  本次所有抓到 id 的记录都拿到了对应 name。');
  }

  // --- 4. ID 升序，逐行写 player.txt（格式严格：ID;名称，分号分隔，对齐 getitems.php 里 explode(';',$line,2)）---
  const ids = Array.from(items.keys()).sort((a, b) => a - b);
  const lines = [];
  for (const id of ids) {
    const name = String(items.get(id)).replace(/\s+/g, ' ').replace(/;/g, '；').trim();
    if (!name) continue;
    lines.push(`${id};${name}`);
  }
  const data = lines.join('\n') + (lines.length ? '\n' : '');
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, data, 'utf8');
  console.log(`[dump-all-items] ✅  已写出 ${lines.length} 行 → ${outFile}`);
  console.log('[dump-all-items] ⓘ  要同步到 GM 下拉常用目标，直接复制即可：');
  const GM_TARGETS = [
    '/www/wwwroot/game/gm/player.txt',
    '/www/wwwroot/game/player.txt',
    '/data/lhs/ht/gm/player.txt',
  ];
  for (const t of GM_TARGETS) {
    console.log(`      cp -f "${outFile}" "${t}"`);
  }

  // --- 5. 控制台底部打印几个样例，方便立刻对照 ---
  console.log('[dump-all-items] 样例：');
  const hardIds = [1, 2, 6];
  hardIds.forEach((id) => {
    console.log(`  ID=${String(id).padStart(5, ' ')}  ${items.get(id) || '(空)'}`);
  });
  console.log('[dump-all-items] 末尾几条（ID 最大）：');
  ids.slice(-5).forEach((id) => {
    console.log(`  ID=${String(id).padStart(5, ' ')}  ${items.get(id) || '(空)'}`);
  });
})().catch((e) => {
  console.error('[dump-all-items] ❌  未捕获异常：', e && e.stack ? e.stack : e);
  process.exit(9);
});
