# CHANGELOG

## 2026-10-12 — 坐骑系统三个 Bug 修复

### 🐛 修复

#### 1. 挂机章节被主线进度覆盖（`newServer/src/handlers/raid.js`）

**现象**：挂机时去打其他章节的怪，回来发现挂机不显示了。

**根因**：`advanceLevel()` 在每章通关时无条件执行
```js
player.raidInfo.hangUpChapter = player.raidInfo.chapter;
```
把玩家自选的挂机章节强制改成主线章节。

**修复**：挂机章节改为独立状态，仅在非法值（<=0 或 > 总章节数）时兜底。

---

#### 2. 升星不升级词条（`newServer/src/handlers/mount.js`）

**现象**：坐骑吞噬升星后，词条（被动技能）等级没变化。

**根因**：`handleMountUpgrade`(tag 3204) 与 `handleMountSwallow`(tag 3205)
只更新 `level` / `star`，从未修改 `mount.skills[].level`。

**修复**：新增 `syncMountSkillLevels()`，按 `SwordConfig[id].skillConds` 阈值推导等级：

| 星级 | 3 | 8 | 13 | 18 | 23 | 28 | 33 | 38 |
|---|---|---|---|---|---|---|---|---|
| 词条等级 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |

（上限 10 级封顶）

**调用点**：`normalizeMountRow`（读档自动修正）/ `handleMountUpgrade` / `handleMountSwallow`。

---

#### 3. 坐骑属性计算错误（`newServer/src/handlers/mount.js`）

**现象**：装词条后属性不对，数值与配置表不符。

**根因**：`buildMountAttrs()` 使用硬编码假公式，且属性 key 用错
```js
return { 1: apply(900), 2: apply(120), 3: apply(55), 4: apply(18) };
```

**修复**：改为读配置表
```js
attrs = SwordLevelConfig[quality][level].attrs
      + SwordStarLevelConfig[quality][star].attrs
```

属性 key 真身是 `51 / 52 / 53`。

**注意**：词条属性与羁绊属性由 `services/BattleService.js` 的 `addMountAttrs()` 单独累加，
`buildMountAttrs` 只负责"等级 + 星级"两段，不可重复计算。

**效果**（玩家 zxhxx 坐骑 22501 q7 lv150 star35）：
```
修复前 attrs: {"1":112862,"2":15048,"3":6897,"4":2257}
修复后 attrs: {"51":14490,"52":14490,"53":14490}   （8990 等级 + 5500 星级）
```

---

### 🔧 其他

- `ecosystem.config.js` 改用环境变量注入敏感项，新增 `.env.example` 模板
- 新增 `README.md` / `CHANGELOG.md`
