function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function getClientBoxCountdownSec(finishTimeMs, nowMs = Date.now()) {
  const finishAt = Math.max(0, toSafeInt(finishTimeMs, 0));
  if (finishAt <= 0) return 0;

  const now = Math.max(0, toSafeInt(nowMs, Date.now()));
  const remainMs = Math.max(0, finishAt - now);
  return Math.ceil(remainMs / 1000);
}

function getClientBoxEndTimeSec(finishTimeMs, nowMs = Date.now()) {
  const finishAt = Math.max(0, toSafeInt(finishTimeMs, 0));
  if (finishAt <= 0) return 0;

  const now = Math.max(0, toSafeInt(nowMs, Date.now()));
  if (finishAt <= now) return 0;
  return Math.ceil(finishAt / 1000);
}

function buildClientBoxInfo(boxInfo = {}, nowMs = Date.now()) {
  const source = (
    boxInfo
    && typeof boxInfo === 'object'
    && !Array.isArray(boxInfo)
  ) ? boxInfo : {};

  return {
    ...source,
    level: Math.max(1, toSafeInt(source.level, 1)),
    exp: Math.max(0, toSafeInt(source.exp, 0)),
    tier: Math.max(1, toSafeInt(source.tier, 1)),
    tierExp: Math.max(0, toSafeInt(source.tierExp, 0)),
    summonExp: Math.max(0, toSafeInt(source.summonExp, 0)),
    summonCount: Math.max(0, toSafeInt(source.summonCount, 0)),
    summonFreeCount: Math.max(0, toSafeInt(source.summonFreeCount, 0)),
    upgradeFinishTime: getClientBoxEndTimeSec(source.upgradeFinishTime, nowMs),
    tierUpTime: getClientBoxEndTimeSec(source.tierUpTime, nowMs),
  };
}

function getBoxSkipUnitMs() {
  const raw = Number(process.env.BOX_UPGRADE_SKIP_UNIT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);

  // Client uses “每 300 秒可跳过 1 次” 的计数规则。
  return 300 * 1000;
}

module.exports = {
  buildClientBoxInfo,
  getBoxSkipUnitMs,
  getClientBoxCountdownSec,
  getClientBoxEndTimeSec,
};
