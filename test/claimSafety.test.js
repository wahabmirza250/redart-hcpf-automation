'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeHcpfStatus,
  modifiersForProcedure,
  matchPortalClaimRow,
  portalDateDigits,
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

test('blocks round trips above 50 total miles', () => {
  assert.throws(() => validateMileagePlan({ leg_miles: [36, 36] }, 72, true), /50 miles per bill/);
});

test('reads the odometer_legs contract sent by RedArt', () => {
  const result = validateMileagePlan({
    odometer_legs: [
      { pickup_odometer: 100, dropoff_odometer: 125 },
      { pickup_odometer: 200, dropoff_odometer: 225 }
    ]
  }, 50, true);
  assert.deepEqual(result.legs, [25, 25]);
});

test('blocks an individual leg above 52 miles', () => {
  assert.throws(() => validateMileagePlan({ leg_miles: [53, 12] }, 65, true), /50 miles per bill/);
});

test('requires leg detail when a round-trip total exceeds one-leg maximum', () => {
  assert.throws(() => validateMileagePlan({}, 72, true), /BLOCKED_MILES_OUT_OF_RANGE/);
});

test('normalizes portal status without inferring from paid amount', () => {
  assert.equal(normalizeHcpfStatus('Paid'), 'paid');
  assert.equal(normalizeHcpfStatus('Denied'), 'denied');
  assert.equal(normalizeHcpfStatus('Error Submitted Data'), 'error_submitted_data');
  assert.equal(normalizeHcpfStatus('Suspended'), 'suspended');
});

test('writes ISO service dates as MMDDYYYY for the HCPF mask', () => {
  assert.equal(portalDateDigits('2026-07-01'), '07012026');
  assert.equal(portalDateDigits('07/01/2026'), '07012026');
  assert.equal(portalDateDigits('7/1/2026'), '07012026');
});

test('portal search will not treat another claim for the same member as a match', () => {
  const claim = { tripDate: '2026-07-01', memberId: 'M964077' };
  assert.equal(matchPortalClaimRow({ claim_id: '111', service_date: '06/15/2026' }, claim), false);
  assert.equal(matchPortalClaimRow({ claim_id: '222' }, claim), false);
  assert.equal(matchPortalClaimRow({ claim_id: '333', service_date: '07/01/2026' }, claim), true);
});

test('submission module loads with every exported compatibility route defined', () => {
  const submission = require('../src/submitClaim');
  assert.equal(typeof submission.run, 'function');
  assert.equal(typeof submission.searchClaims, 'function');
  assert.equal(typeof submission.discoverSearchClaims, 'function');
});
