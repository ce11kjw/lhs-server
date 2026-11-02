const fs = require('fs');
const path = require('path');

const REPORT_DIR = path.join(__dirname, '..', '..', 'reports');

function toSafeTag(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.floor(num);
}

function toSafeDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}

function formatDateKey(value) {
  const date = toSafeDate(value);
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

class TagMetricsService {
  constructor(options = {}) {
    this.enabled = String(options.enabled ?? process.env.TAG_METRICS_ENABLED ?? '1') !== '0';
    this.reportDir = options.reportDir || REPORT_DIR;
    this.startedAt = Date.now();
    this.tags = new Map();
  }

  _ensureTag(tag) {
    const safeTag = toSafeTag(tag);
    if (safeTag <= 0) return null;

    const exists = this.tags.get(safeTag);
    if (exists) return exists;

    const row = {
      tag: safeTag,
      requests: 0,
      success: 0,
      fail: 0,
      fallbackHit: 0,
      lastSeenAt: null,
    };
    this.tags.set(safeTag, row);
    return row;
  }

  _touch(row) {
    if (!row) return;
    row.lastSeenAt = new Date().toISOString();
  }

  _record(tag, patch = {}) {
    if (!this.enabled) return;
    const row = this._ensureTag(tag);
    if (!row) return;

    row.requests += Number(patch.requests || 0);
    row.success += Number(patch.success || 0);
    row.fail += Number(patch.fail || 0);
    row.fallbackHit += Number(patch.fallbackHit || 0);
    this._touch(row);
  }

  recordRequest(tag) {
    this._record(tag, { requests: 1 });
  }

  recordSuccess(tag, options = {}) {
    this._record(tag, {
      success: 1,
      fallbackHit: options.fallbackHit ? 1 : 0,
    });
  }

  recordFail(tag, options = {}) {
    this._record(tag, {
      fail: 1,
      fallbackHit: options.fallbackHit ? 1 : 0,
    });
  }

  snapshot(now = Date.now()) {
    const nowDate = toSafeDate(now);
    const elapsedSeconds = Math.max(1, Math.floor((nowDate.getTime() - this.startedAt) / 1000));

    const tags = Array.from(this.tags.values())
      .map((item) => ({
        tag: item.tag,
        requests: item.requests,
        success: item.success,
        fail: item.fail,
        fallbackHit: item.fallbackHit,
        qps: Number((item.requests / elapsedSeconds).toFixed(4)),
        lastSeenAt: item.lastSeenAt,
      }))
      .sort((a, b) => b.requests - a.requests || a.tag - b.tag);

    const totals = tags.reduce((acc, item) => {
      acc.requests += item.requests;
      acc.success += item.success;
      acc.fail += item.fail;
      acc.fallbackHit += item.fallbackHit;
      return acc;
    }, {
      requests: 0,
      success: 0,
      fail: 0,
      fallbackHit: 0,
    });

    return {
      generatedAt: nowDate.toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      elapsedSeconds,
      totals: {
        ...totals,
        qps: Number((totals.requests / elapsedSeconds).toFixed(4)),
      },
      tags,
    };
  }

  writeDailyReport(date = Date.now()) {
    if (!this.enabled) {
      return { enabled: false, filePath: null, report: null };
    }

    const safeDate = toSafeDate(date);
    if (!fs.existsSync(this.reportDir)) {
      fs.mkdirSync(this.reportDir, { recursive: true });
    }

    const filePath = path.join(this.reportDir, `tag-metrics-${formatDateKey(safeDate)}.json`);
    const report = this.snapshot(safeDate);
    fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { enabled: true, filePath, report };
  }
}

module.exports = new TagMetricsService();
module.exports.TagMetricsService = TagMetricsService;
module.exports.formatDateKey = formatDateKey;
