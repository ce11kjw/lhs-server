const fs = require('fs');
const path = require('path');

function toSafeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function formatDateKey(input) {
  const date = input instanceof Date ? input : new Date(input || Date.now());
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function readJsonIfExists(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw || '{}');
}

function parseDateArg() {
  const dateArg = process.argv.find((arg) => arg.startsWith('--date='));
  if (!dateArg) return formatDateKey(new Date());
  const key = String(dateArg.split('=')[1] || '').trim();
  if (/^\d{8}$/.test(key)) return key;
  throw new Error(`invalid --date value: ${key}`);
}

function makeStatusMap(capability) {
  const map = new Map();
  const rows = Array.isArray(capability.tags) ? capability.tags : [];
  rows.forEach((row) => {
    const tag = toSafeInt(row.tag);
    if (tag > 0) {
      map.set(tag, row.status || 'fallback');
    }
  });
  return map;
}

function makeTriggeredMap(triggered) {
  const map = new Map();
  const rows = Array.isArray(triggered.tags) ? triggered.tags : [];
  rows.forEach((row) => {
    const tag = toSafeInt(row.tag);
    if (tag > 0) {
      map.set(tag, toSafeInt(row.count));
    }
  });
  return map;
}

function main() {
  const serverRoot = path.join(__dirname, '..');
  const reportsDir = path.join(serverRoot, 'reports');
  const dateKey = parseDateArg();

  const metricsPath = path.join(reportsDir, `tag-metrics-${dateKey}.json`);
  const outputPath = path.join(reportsDir, `tag-daily-report-${dateKey}.md`);
  const capabilityPath = path.join(serverRoot, 'src', 'capability', 'tag-capability.json');
  const triggeredPath = path.join(reportsDir, 'triggered-tags.json');

  if (!fs.existsSync(metricsPath)) {
    throw new Error(`missing metrics file: ${metricsPath}`);
  }

  const metrics = readJsonIfExists(metricsPath, {});
  const capability = readJsonIfExists(capabilityPath, { tags: [] });
  const triggered = readJsonIfExists(triggeredPath, { tags: [] });

  const statusMap = makeStatusMap(capability);
  const triggeredMap = makeTriggeredMap(triggered);

  const rows = Array.isArray(metrics.tags) ? metrics.tags : [];
  const topRows = rows
    .slice()
    .sort((a, b) => toSafeInt(b.requests) - toSafeInt(a.requests))
    .slice(0, 30)
    .map((row) => {
      const tag = toSafeInt(row.tag);
      return {
        tag,
        requests: toSafeInt(row.requests),
        success: toSafeInt(row.success),
        fail: toSafeInt(row.fail),
        fallbackHit: toSafeInt(row.fallbackHit),
        qps: Number(row.qps || 0),
        status: statusMap.get(tag) || 'unknown',
        triggeredCount: triggeredMap.get(tag) || 0,
      };
    });

  const fallbackRows = topRows.filter((row) => row.status === 'fallback' || row.fallbackHit > 0);

  const lines = [];
  lines.push(`# Tag Daily Report ${dateKey}`);
  lines.push('');
  lines.push(`- generatedAt: ${metrics.generatedAt || new Date().toISOString()}`);
  lines.push(`- startedAt: ${metrics.startedAt || 'n/a'}`);
  lines.push(`- elapsedSeconds: ${toSafeInt(metrics.elapsedSeconds)}`);

  const totals = metrics.totals || {};
  lines.push(`- totals.requests: ${toSafeInt(totals.requests)}`);
  lines.push(`- totals.success: ${toSafeInt(totals.success)}`);
  lines.push(`- totals.fail: ${toSafeInt(totals.fail)}`);
  lines.push(`- totals.fallbackHit: ${toSafeInt(totals.fallbackHit)}`);
  lines.push(`- totals.qps: ${Number(totals.qps || 0)}`);
  lines.push('');

  lines.push('## Top Tags (by requests)');
  lines.push('');
  lines.push('| tag | requests | success | fail | fallbackHit | qps | status | triggeredCount |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |');
  topRows.forEach((row) => {
    lines.push(`| ${row.tag} | ${row.requests} | ${row.success} | ${row.fail} | ${row.fallbackHit} | ${row.qps} | ${row.status} | ${row.triggeredCount} |`);
  });
  if (topRows.length === 0) {
    lines.push('| - | 0 | 0 | 0 | 0 | 0 | - | 0 |');
  }
  lines.push('');

  lines.push('## Fallback Focus');
  lines.push('');
  if (fallbackRows.length === 0) {
    lines.push('- none');
  } else {
    fallbackRows.forEach((row) => {
      lines.push(`- tag=${row.tag} requests=${row.requests} fail=${row.fail} fallbackHit=${row.fallbackHit} status=${row.status}`);
    });
  }
  lines.push('');

  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`[daily-tag-report] wrote ${outputPath}`);
}

main();