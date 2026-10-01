'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverLoginBlocks } = require('../src/portalRecovery');
const { ledgerStateFromError } = require('../src/claimLedger');
test('login-stage timeout is never an uncertain claim submission', () => {
  assert.equal(ledgerStateFromError({message:'Timeout',portalStage:'login',submitReached:false},'confirm_submit'),'failed');
  assert.equal(ledgerStateFromError({message:'Timeout'},'confirm_submit'),'uncertain');
});
test('old login-control timeout is recoverable but confirm uncertainty is preserved', () => {
  const note = "page.click: Timeout 30000ms exceeded. waiting for locator('text=Log In') LoginCmnButton";
  const ledger = mock([row({state:'uncertain',note,history:[{to:'uncertain',note}]}),row({key:'confirm',state:'uncertain',note,history:[{to:'uncertain',note:'Confirm is about to be attempted'}]})]);
  assert.equal(recoverLoginBlocks(ledger,{companyId:'c',providerId:'p',authenticated:true}).length,1);
});
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
test('hidden Step 1 menu timeout requires verified form and never releases final-confirm history', () => {
  const note = "locator.click: Timeout 8000ms exceeded. waiting for locator('text=Submit Claim Prof').last() element is not visible";
  const rows = [row({state:'uncertain',note,history:[{to:'uncertain',note}]}), row({key:'final',state:'uncertain',note,history:[{to:'uncertain',note:'Confirm is about to be attempted'}]})];
  assert.equal(recoverLoginBlocks(mock(rows),{companyId:'c',providerId:'p',authenticated:true}).length,0);
  assert.equal(recoverLoginBlocks(mock(rows),{companyId:'c',providerId:'p',authenticated:true,claimFormVerified:true}).length,1);
  assert.equal(ledgerStateFromError({message:'Timeout',portalStage:'navigate',submitReached:false},'confirm_submit'),'failed');
});
