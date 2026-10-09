const test = require('node:test');
const assert = require('node:assert/strict');
const { fillPortalModifiers, modifierLabelPattern } = require('../src/portalModifiers');
const { verifySavedPortalModifiers } = require('../src/portalModifiers');

function portal({ label = '76 - Repeat procedure', clickFails = false, clearOnBlur = false } = {}) {
  let value = '', selected = false;
  const suggestion = { isVisible: async () => true, click: async () => {
    if (clickFails) throw new Error('selection failed');
    selected = true;
  } };
  const field = {
    count: async () => 1, isVisible: async () => true,
    evaluate: async fn => fn({ tagName: 'INPUT' }),
    fill: async v => { value = v; }, pressSequentially: async v => { value += v; },
    inputValue: async () => value,
    blur: async () => { if (clearOnBlur || !selected) value = ''; }
  };
  return {
    current: () => field,
    page: { getByText: pattern => ({ all: async () => pattern.test(label) ? [suggestion] : [] }), waitForTimeout: async () => {} },
    selectors: ['modifier'], modifiers: ['76'], procedureCode: 'A0120'
  };
}

test('selects a modifier suggestion with a description, not merely typed text', async () => {
  assert.deepEqual(await fillPortalModifiers(portal()), ['76']);
});
test('also accepts a code-only suggestion', async () => {
  assert.deepEqual(await fillPortalModifiers(portal({ label: '76' })), ['76']);
});
test('failed suggestion selection stops the claim', async () => {
  await assert.rejects(fillPortalModifiers(portal({ clickFails: true })), /selection failed/);
});
test('detects a modifier cleared by a field refresh', async () => {
  await assert.rejects(fillPortalModifiers(portal({ clearOnBlur: true })), /BLOCKED_MODIFIER_NOT_ACCEPTED/);
});
test('does not select a different code or money containing 76', async () => {
  for (const label of ['176', '760', '76.00', '$76.00', 'A0120 76']) assert.equal(modifierLabelPattern('76').test(label), false);
  await assert.rejects(fillPortalModifiers(portal({ label: '760' })), /BLOCKED_MODIFIER_NOT_ACCEPTED/);
});
test('empty plan does not touch portal modifier fields', async () => {
  assert.deepEqual(await fillPortalModifiers({ modifiers: [] }), []);
});

function savedPortal(savedModifier) {
  let opened = false;
  const clicks = [];
  const field = value => ({tagName:'INPUT',type:'text',value,getClientRects:()=>[{}]});
  const cancel = {id:'cancel-saved',textContent:'Cancel',getClientRects:()=>[{}]};
  const editor = {querySelectorAll: selector => !opened ? [] : selector==='procedure' ? [field('A0120-NONER TRANSPORT MINI-BUS')] : selector==='mod1' ? [field(savedModifier)] : [cancel]};
  const savedRow = {cells:[{textContent:'1',querySelector:()=>({id:'service-1',textContent:'1'})},...['01/16/2026','01/16/2026','41-Ambulance','A0120-NONER TRANSPORT MINI-BUS','$72.80','2'].map(textContent=>({textContent}))],nextElementSibling:editor};
  const blankRow = {cells:[{textContent:'2'},...Array.from({length:6},()=>({textContent:''}))],nextElementSibling:{querySelectorAll:()=>[field('')]}};
  const document = {querySelectorAll:()=>[savedRow,blankRow]};
  const page = {
    evaluate: async (fn,args) => require('node:vm').runInNewContext('('+fn.toString()+')(args)',{document,args}),
    locator: selector => ({
      click: async () => {opened=selector.includes('service-1');clicks.push(opened?1:2)},
      waitFor: async () => {assert.equal(opened,false)}
    }),
    waitForTimeout: async () => {}
  };
  return {args:{page,selectors:{procedure:'procedure',modifiers:['mod1']},rowNumber:1,procedureCode:'A0120',modifiers:['76']},clicks};
}
test('verifies the saved editor then restores the blank next line without Add', async () => {
  const {args,clicks}=savedPortal('76');
  await verifySavedPortalModifiers(args);
  assert.deepEqual(clicks,[1,2]);
});
test('a blank saved modifier still blocks even though input was entered earlier', async () => {
  const {args,clicks}=savedPortal('');
  await assert.rejects(verifySavedPortalModifiers(args),/BLOCKED_MODIFIER_COMMIT_UNVERIFIED/);
  assert.deepEqual(clicks,[1]);
});
test('a different saved modifier blocks submission', async () => {
  await assert.rejects(verifySavedPortalModifiers(savedPortal('77').args),/BLOCKED_MODIFIER_COMMIT_UNVERIFIED/);
});
