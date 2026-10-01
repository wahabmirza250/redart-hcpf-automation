'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverLoginBlocks } = require('../src/portalRecovery');
const row = (patch = {}) => ({ key: 'c::t', company_id: 'c', provider_id: 'p', state: 'blocked', note: 'PORTAL_BLOCKED: Portal lockout or access block detected.', history: [], ...patch });
function mock(rows) { const writes = []; return { writes, all: () => rows, record: (key, patch) => writes.push({key, ...patch}) }; }
test('only a verified login releases matching pre-submit blocks', () => {
  const ledger = mock([row(), row({key:'other',company_id:'other'}), row({key:'provider',provider_id:'other'}), row({key:'receipt',claim_id:'123'}), row({key:'uncertain',state:'uncertain'}), row({key:'history',history:[{to:'uncertain'}]})]);
  assert.equal(recoverLoginBlocks(ledger, {companyId:'c',providerId:'p',authenticated:true}).length, 1);
  assert.equal(ledger.writes[0].state,'failed');
  assert.equal(ledger.writes[0].key,'c::t');
});
test('failed login never alters ledger', () => {
  const ledger = mock([row()]);
  assert.throws(() => recoverLoginBlocks(ledger,{companyId:'c',providerId:'p',authenticated:false}));
  assert.equal(ledger.writes.length,0);
});
