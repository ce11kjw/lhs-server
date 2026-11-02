/**
 * Stub Handler - register explicit fallback tags.
 *
 * NOTE:
 * All currently triggered tags are implemented by concrete handlers.
 * This list remains for future targeted fallback needs, while unknown tags
 * are still protected by router-level fallback.
 */

const router = require('../router');

/**
 * Explicit stub tag list.
 */
const STUB_TAGS = [];

/**
 * Register all stub handlers.
 * @param {Set<number>} [registeredTags] already registered tags to avoid override
 * @returns {number} number of registered stubs
 */
function registerAllStubs(registeredTags) {
  let count = 0;
  for (const tag of STUB_TAGS) {
    if (registeredTags && registeredTags.has(tag)) continue;
    router.register(tag, function stubHandler(_params, _session, msgUid) {
      return { tag, msgUid, data: { result: 0 } };
    });
    count++;
  }
  return count;
}

module.exports = { registerAllStubs, STUB_TAGS };
