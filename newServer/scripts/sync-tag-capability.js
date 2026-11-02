#!/usr/bin/env node
const path = require('path');

const { syncTagCapabilityRegistry } = require('../src/capability/sync-tag-capability');

function main() {
  const serverRoot = path.join(__dirname, '..');
  const result = syncTagCapabilityRegistry({
    capabilityPath: path.join(serverRoot, 'src', 'capability', 'tag-capability.json'),
    indexPath: path.join(serverRoot, 'src', 'handlers', 'index.js'),
    verifiedAt: new Date().toISOString(),
  });

  console.log(
    `[sync-tag-capability] synced registered=${result.registeredCount}, changed=${result.changedCount}, total=${result.totalCount}`
  );
}

main();
