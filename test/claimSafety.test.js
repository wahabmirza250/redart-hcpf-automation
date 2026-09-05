'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeHcpfStatus,
  modifiersForProcedure,
  validateCorrectionModifierPlan,
  validateMileagePlan
} = require('../src/claimSafety');

test('preserves modifier 76 per corrected service line', () => {
  const claim = {
    resubmission_id: 'r-1',
    service_lines: [
      { procedure_code: 'A0120', modifiers: ['76'] },
      { procedure_code: 'S0215', modifier_1: '76' }
    ]
  };
  assert.deepEqual(modifiersForProcedure(claim, 'A0120'), ['76']);
  assert.deepEqual(modifiersForProcedure(claim, 'S0215'), ['76']);
  assert.doesNotThrow(() => validateCorrectionModifierPlan(claim, ['A0120', 'S0215']));
});

test('fails closed when a corrected claim would have a blank Mod column', () => {
  assert.throws(
    () => validateCorrectionModifierPlan({ resubmission_id: 'r-1', service_lines: [] }, ['A0120', 'S0215']),
    /BLOCKED_MISSING_CORRECTION_MODIFIER/
  );
});

test('validates 52-mile ceiling per leg, not across a round trip', () => {
  const result = validateMileagePlan({ leg_miles: [36, 36] }, 72, true);
  assert.deepEqual(result.legs, [36, 36]);
  assert.equal(result.total, 72);
});

test('reads the odometer_legs contract sent by RedArt', () => {
  const result = validateMileagePlan({
    odometer_legs: [
      { pickup_odometer: 100, dropoff_odometer: 136 },
      { pickup_odometer: 200, dropoff_odometer: 236 }
    ]
  }, 72, true);
  assert.deepEqual(result.legs, [36, 36]);
});

test('blocks an individual leg above 52 miles', () => {
  assert.throws(() => validateMileagePlan({ leg_miles: [53, 12] }, 65, true), /Leg 1 is 53 miles/);
});

test('requires leg detail when a round-trip total exceeds one-leg maximum', () => {
  assert.throws(() => validateMileagePlan({}, 72, true), /BLOCKED_MISSING_LEG_MILES/);
});

test('normalizes portal status without inferring from paid amount', () => {
  assert.equal(normalizeHcpfStatus('Paid'), 'paid');
  assert.equal(normalizeHcpfStatus('Denied'), 'denied');
  assert.equal(normalizeHcpfStatus('Error Submitted Data'), 'error_submitted_data');
  assert.equal(normalizeHcpfStatus('Suspended'), 'suspended');
});

test('submission module loads with every exported compatibility route defined', () => {
  const submission = require('../src/submitClaim');
  assert.equal(typeof submission.run, 'function');
  assert.equal(typeof submission.searchClaims, 'function');
  assert.equal(typeof submission.discoverSearchClaims, 'function');
});
