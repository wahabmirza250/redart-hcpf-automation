const test = require('node:test');
const assert = require('node:assert/strict');
const { planRepeatTrip } = require('../src/repeatTrip');
const { validateCorrectionModifierPlan, matchPortalClaimRow } = require('../src/claimSafety');
const trip = {id:'job-2',medicaid_trip_id:'return',company_id:'co',provider_id:'provider',member_id:'member',trip_date:'10/01/2026',pickup_at:'2026-10-01T16:00:00Z'};
const prior = {trip_id:'outbound',company_id:'co',provider_id:'provider',member_id:'member',service_date:'10/01/2026',pickup_at:'2026-10-01T09:00:00Z',state:'submitted',claim_id:'1234567890123'};
test('first trip has no automatic repeat modifier',()=>assert.equal(planRepeatTrip(trip,[]).auto_repeat_modifier,undefined));
test('separate same-day return gets 76 despite changing drivers',()=>{
  const result=planRepeatTrip({...trip,driver_id:'driver-b'},[{...prior,driver_id:'driver-a'}]);
  assert.equal(result.auto_repeat_modifier,'76');
  assert.deepEqual(result.repeat_previous_claim_ids,[prior.claim_id]);
  const plan=validateCorrectionModifierPlan(result,['A0120','S0215']);
  assert.equal(plan.required,true);
  assert.deepEqual(plan.modifiersByProcedure,{A0120:['76'],S0215:['76']});
});
test('same trip is never converted to a repeat service',()=>{
  assert.equal(planRepeatTrip(trip,[{...prior,trip_id:'return'}]).auto_repeat_modifier,undefined);
});
for(const [name,patch] of [['different company',{company_id:'elsewhere'}],['different member',{member_id:'other'}],['different day',{service_date:'09/30/2026'}]]) {
  test(name+' does not trigger 76',()=>assert.equal(planRepeatTrip(trip,[{...prior,...patch}]).auto_repeat_modifier,undefined));
}
for(const [name,patch] of [['different provider',{provider_id:'other'}],['missing provider',{provider_id:null}],['unconfirmed claim',{state:'uncertain'}],['missing claim ID',{claim_id:null}],['copied pickup time',{pickup_at:trip.pickup_at}],['missing pickup time',{pickup_at:null}]]) {
  test(name+' requires review instead of adding a modifier',()=>assert.throws(()=>planRepeatTrip(trip,[{...prior,...patch}]),/BLOCKED_REPEAT_REVIEW/));
}
test('earlier claim ID cannot be mistaken for the return-trip confirmation',()=>{
  const claim={tripDate:trip.trip_date,repeatPreviousClaimIds:[prior.claim_id]};
  assert.equal(matchPortalClaimRow({claim_id:prior.claim_id,service_date:trip.trip_date},claim),false);
  assert.equal(matchPortalClaimRow({claim_id:'9999999999999',service_date:trip.trip_date},claim),true);
});
test('corrections keep their reviewed modifier plan',()=>{
  const result=planRepeatTrip({...trip,resubmission_id:'correction',modifiers:['77']},[prior]);
  assert.equal(result.auto_repeat_modifier,undefined);
  assert.deepEqual(result.modifiers,['77']);
});
