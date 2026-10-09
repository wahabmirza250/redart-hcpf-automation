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
  let active = 2;
  const clicks = [];
  const page = {
    evaluate: async (_fn, {number}) => `service-${number}`,
    locator: selector => ({ click: async () => {
      active = selector.includes('service-1') ? 1 : 2;
      clicks.push(active);
    } }),
    waitForLoadState: async () => {}, waitForTimeout: async () => {}
  };
  const current = selector => ({
    waitFor: async () => {},
    inputValue: async () => active === 1 ? 'A0120' : '',
    evaluate: async fn => fn({ tagName: 'INPUT', value: active === 1 ? savedModifier : '' })
  });
  return { args: {page,current,selectors:{procedure:'procedure',modifiers:['mod1']},rowNumber:1,procedureCode:'A0120',modifiers:['76']},clicks };
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
