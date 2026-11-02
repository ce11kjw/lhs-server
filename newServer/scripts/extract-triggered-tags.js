#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { PacketManager } = require('../src/protocol');

function toSafeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function collectFromRunLog(logPath, acc) {
  if (!fs.existsSync(logPath)) return;
  const content = fs.readFileSync(logPath, 'utf8');
  for (const match of content.matchAll(/C->S tag=(\d+)/g)) {
    const tag = toSafeInt(match[1]);
    if (tag <= 0) continue;
    acc[tag] = acc[tag] || { tag, count: 0, sources: {} };
    acc[tag].count += 1;
    acc[tag].sources.runLog = (acc[tag].sources.runLog || 0) + 1;
  }
}

function addDecodedMessage(decoded, acc, sourceName) {
  const stack = [decoded];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      cur.forEach((x) => stack.push(x));
      continue;
    }
    if (!cur || cur.tag == null) continue;
    const tag = toSafeInt(cur.tag);
    if (tag <= 0) continue;
    acc[tag] = acc[tag] || { tag, count: 0, sources: {} };
    acc[tag].count += 1;
    acc[tag].sources[sourceName] = (acc[tag].sources[sourceName] || 0) + 1;
  }
}

function collectFromHar(harPath, acc) {
  if (!fs.existsSync(harPath)) return;
  const raw = fs.readFileSync(harPath, 'utf8');
  const json = JSON.parse(raw);
  const entries = (((json || {}).log || {}).entries) || [];

  entries.forEach((entry) => {
    const wsMessages = entry._webSocketMessages || [];
    wsMessages.forEach((m) => {
      // flow=0: client -> server
      if (toSafeInt(m.flow) !== 0) return;
      const b64 = m && m.payload && m.payload.buffer;
      if (!b64 || typeof b64 !== 'string') return;
      let buf;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch (_e) {
        return;
      }
      if (!buf || buf.length < 12) return;
      try {
        const decoded = PacketManager.unpackClient(buf);
        addDecodedMessage(decoded, acc, path.basename(harPath));
      } catch (_e) {
        // ignore malformed frame
      }
    });
  });
}

function resolveHarCandidates(workspaceRoot) {
  if (!fs.existsSync(workspaceRoot)) return [];
  const names = fs.readdirSync(workspaceRoot);
  return names
    .filter((name) => name.toLowerCase().endsWith('.har'))
    .map((name) => path.join(workspaceRoot, name));
}

function buildComparableReport(report) {
  const safeInputs = report && report.inputs && typeof report.inputs === 'object' ? report.inputs : {};
  const tags = Array.isArray(report && report.tags) ? report.tags : [];
  return {
    inputs: {
      runLog: safeInputs.runLog || null,
      hars: Array.isArray(safeInputs.hars) ? safeInputs.hars : [],
    },
    totalTags: tags.length,
    tags,
  };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeReportIfChanged(outputPath, out) {
  const nextComparable = JSON.stringify(buildComparableReport(out));
  if (fs.existsSync(outputPath)) {
    const current = readJsonSafe(outputPath);
    if (current) {
      const currentComparable = JSON.stringify(buildComparableReport(current));
      if (currentComparable === nextComparable) {
        return { written: false, totalTags: out.totalTags };
      }
    }
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return { written: true, totalTags: out.totalTags };
}

function main() {
  const serverRoot = path.join(__dirname, '..');
  const workspaceRoot = path.join(serverRoot, '..');
  const reportsDir = path.join(serverRoot, 'reports');
  const runLogPath = path.join(serverRoot, 'run.log');
  const harCandidates = resolveHarCandidates(workspaceRoot);

  const acc = {};
  collectFromRunLog(runLogPath, acc);
  harCandidates.forEach((harPath) => collectFromHar(harPath, acc));

  const tags = Object.values(acc).sort((a, b) => b.count - a.count);
  const out = {
    generatedAt: new Date().toISOString(),
    inputs: {
      runLog: fs.existsSync(runLogPath) ? runLogPath : null,
      hars: harCandidates,
    },
    totalTags: tags.length,
    tags,
  };

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const outputPath = path.join(reportsDir, 'triggered-tags.json');
  const result = writeReportIfChanged(outputPath, out);
  if (result.written) {
    console.log(`[extract-triggered-tags] wrote ${result.totalTags} tags -> ${outputPath}`);
    return;
  }
  console.log(`[extract-triggered-tags] unchanged (${result.totalTags} tags) -> ${outputPath}`);
}

module.exports = {
  toSafeInt,
  collectFromRunLog,
  addDecodedMessage,
  collectFromHar,
  resolveHarCandidates,
  buildComparableReport,
  writeReportIfChanged,
  main,
};

if (require.main === module) {
  main();
}
