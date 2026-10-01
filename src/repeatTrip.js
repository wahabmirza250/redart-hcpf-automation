'use strict';
const { portalDateDigits, isCorrectedClaim } = require('./claimSafety');
const { ClaimLedger } = require('./claimLedger');

// Called inside the account queue: the previous bill must finish before this decision.
function planRepeatTrip(record, history) {
  const clean = { ...record };
  delete clean.repeat_previous_claim_ids;
  delete clean.auto_repeat_modifier;
  if (isCorrectedClaim(record)) return clean; // Corrections retain their reviewed modifier plan.
  const member = record.medicaid_member_id || record.member_id;
  const day = portalDateDigits(record.trip_date || record.service_date);
  const tripId = ClaimLedger.tripIdFrom(record);
  if (!member || !day || !record.company_id || !record.provider_id) return clean;
  const others = history.filter(r => r.company_id === record.company_id && r.member_id === member &&
    portalDateDigits(r.service_date) === day && r.trip_id !== tripId &&
    ['submitted','already_on_file','uncertain'].includes(r.state));
  if (!others.length) return clean;
  const start = Date.parse(record.pickup_at);
  for (const prior of others) {
    const priorStart = Date.parse(prior.pickup_at);
    if (prior.state === 'uncertain' || !prior.claim_id || prior.provider_id !== record.provider_id ||
      !Number.isFinite(start) || !Number.isFinite(priorStart) || start === priorStart ||
      !record.medicaid_trip_id || !prior.trip_id) {
      throw new Error('BLOCKED_REPEAT_REVIEW: same-day bill needs review to confirm a separate trip and the same provider. Do not resubmit a duplicate.');
    }
  }
  return { ...clean, auto_repeat_modifier: '76',
    repeat_previous_claim_ids: [...new Set(others.map(r => String(r.claim_id)))],
    modifiers: [...new Set([...(Array.isArray(record.modifiers) ? record.modifiers : []), '76'])] };
}
module.exports = { planRepeatTrip };
