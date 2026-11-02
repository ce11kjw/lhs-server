#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function toSafeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const serverRoot = path.join(__dirname, '..');
  const triggeredPath = path.join(serverRoot, 'reports', 'triggered-tags.json');
  const capabilityPath = path.join(serverRoot, 'src', 'capability', 'tag-capability.json');

  const triggered = readJson(triggeredPath);
  const capability = readJson(capabilityPath);

  const map = new Map();
  const capabilityTags = Array.isArray(capability.tags) ? capability.tags : [];
  capabilityTags.forEach((row) => {
    const tag = toSafeInt(row.tag);
    if (tag > 0) map.set(tag, row.status || 'fallback');
  });

  const bad = [];
  const rows = Array.isArray(triggered.tags) ? triggered.tags : [];
  rows.forEach((row) => {
    const tag = toSafeInt(row.tag);
    if (tag <= 0) return;
    const status = map.get(tag) || 'fallback';
    if (status === 'fallback') {
      bad.push({ tag, status, count: toSafeInt(row.count) });
    }
  });

  if (bad.length > 0) {
    console.error('[check-triggered-no-fallback] failed, triggered tags still fallback:');
    bad
      .sort((a, b) => b.count - a.count)
      .slice(0, 50)
      .forEach((row) => {
        console.error(`- tag=${row.tag} status=${row.status} count=${row.count}`);
      });
    process.exit(1);
  }

  console.log('[check-triggered-no-fallback] passed');
}

main();
