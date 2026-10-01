const test = require('node:test');
const assert = require('node:assert/strict');
const {assertBillingLimits} = require('../src/billingLimits');
test('robot independently blocks quantities above whole-bill limits', () => {
  assert.doesNotThrow(() => assertBillingLimits({miles:50, trip_units:2}));
  for (const bill of [{miles:50.01},{trip_units:3},{miles:12,total_miles:51},
    {odometer_legs:[{pickup_odometer:100,dropoff_odometer:126},{pickup_odometer:200,dropoff_odometer:225}]}]) {
    assert.throws(() => assertBillingLimits(bill), /Billing blocked/);
  }
});
