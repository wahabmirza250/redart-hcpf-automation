'use strict';

function firstPresent(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeModifierList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,|/]+/)
      : value
        ? [value]
        : [];
  return [...new Set(raw.map(item => String(item).trim().toUpperCase()).filter(Boolean))];
}

function normalizeServiceLines(tripRecord = {}) {
  const lines = firstPresent(
    tripRecord.service_lines,
    tripRecord.claim_service_lines,
    tripRecord.corrected_service_lines,
    tripRecord.resubmission_service_lines
  );
  return Array.isArray(lines) ? lines : [];
}

function lineProcedureCode(line = {}) {
  return String(firstPresent(line.procedure_code, line.procedureCode, line.code, '')).trim().toUpperCase();
}

function lineModifiers(line = {}) {
  return normalizeModifierList(firstPresent(
    line.modifiers,
    line.modifier_codes,
    line.modifier,
    line.modifier_1,
    line.modifier1
  ));
}

function topLevelModifiers(tripRecord = {}) {
  return normalizeModifierList(firstPresent(
    tripRecord.modifiers,
    tripRecord.modifier_codes,
    tripRecord.modifier,
    tripRecord.modifier_1,
    tripRecord.modifier1
  ));
}

function modifiersForProcedure(tripRecord, procedureCode) {
  const target = String(procedureCode || '').trim().toUpperCase();
  const matching = normalizeServiceLines(tripRecord)
    .filter(line => lineProcedureCode(line) === target)
    .flatMap(lineModifiers);
  return matching.length ? [...new Set(matching)] : topLevelModifiers(tripRecord);
}

function isCorrectedClaim(tripRecord = {}) {
  return Boolean(firstPresent(
    tripRecord.resubmission_id,
    tripRecord.correction_id,
    tripRecord.original_claim_number,
    tripRecord.previous_claim_icn,
    tripRecord.is_resubmission,
    tripRecord.is_corrected_claim,
    tripRecord.corrected_claim
  ));
}

function validateCorrectionModifierPlan(tripRecord, procedureCodes) {
  if (!isCorrectedClaim(tripRecord)) return { required: false, modifiersByProcedure: {} };

  const noModifierReviewed = tripRecord.modifier_reviewed === true && tripRecord.no_modifier_required === true;
  const modifiersByProcedure = Object.fromEntries(
    procedureCodes.map(code => [code, modifiersForProcedure(tripRecord, code)])
  );
  const missing = procedureCodes.filter(code => modifiersByProcedure[code].length === 0);

  if (missing.length && !noModifierReviewed) {
    throw new Error(
      `BLOCKED_MISSING_CORRECTION_MODIFIER: corrected claim is missing a reviewed modifier for ${missing.join(', ')}. ` +
      'The portal robot will not submit a corrected claim with a blank Mod column.'
    );
  }
  return { required: !noModifierReviewed, modifiersByProcedure };
}

function legMilesFromRecord(tripRecord = {}) {
  const explicit = firstPresent(tripRecord.leg_miles, tripRecord.miles_by_leg, tripRecord.loaded_miles_by_leg);
  if (Array.isArray(explicit)) return explicit.map(Number).filter(Number.isFinite);

  const legs = firstPresent(
    tripRecord.odometer_legs,
    tripRecord.legs,
    tripRecord.trip_legs,
    tripRecord.corrected_legs
  );
  if (!Array.isArray(legs)) return [];
  return legs.map(leg => {
    const explicitMiles = firstPresent(leg.loaded_miles, leg.miles, leg.mileage_units);
    if (explicitMiles !== undefined) return Number(explicitMiles);
    const start = Number(firstPresent(leg.pickup_odometer, leg.odometer_start, leg.start_odometer));
    const end = Number(firstPresent(leg.dropoff_odometer, leg.odometer_end, leg.end_odometer));
    return Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;
  }).filter(Number.isFinite);
}

function validateMileagePlan(tripRecord, totalMiles, isRoundTrip, maxPerLeg = 52) {
  const legs = legMilesFromRecord(tripRecord);
  if (legs.length) {
    const invalid = legs.findIndex(miles => !Number.isFinite(miles) || miles <= 0 || miles > maxPerLeg);
    if (invalid >= 0) {
      throw new Error(
        `BLOCKED_MILES_OUT_OF_RANGE: Leg ${invalid + 1} is ${legs[invalid]} miles; each leg must be 1-${maxPerLeg} miles.`
      );
    }
    const sum = legs.reduce((total, miles) => total + miles, 0);
    if (totalMiles !== null && totalMiles !== undefined && Math.abs(sum - Number(totalMiles)) > 0.01) {
      throw new Error(
        `BLOCKED_MILEAGE_MISMATCH: leg miles total ${sum} but claim mileage is ${totalMiles}. Review before submission.`
      );
    }
    return { legs, total: sum, maxPerLeg };
  }

  const total = Number(totalMiles);
  if (!Number.isFinite(total) || total <= 0) return { legs: [], total: null, maxPerLeg };
  const safeMax = isRoundTrip ? maxPerLeg * 2 : maxPerLeg;
  if (total > safeMax) {
    throw new Error(
      `BLOCKED_MILES_OUT_OF_RANGE: total mileage ${total} exceeds ${safeMax} for ${isRoundTrip ? 'a round trip' : 'a one-way trip'}.`
    );
  }
  if (isRoundTrip && total > maxPerLeg) {
    throw new Error(
      `BLOCKED_MISSING_LEG_MILES: round-trip total is ${total}; send each leg separately so the robot can prove no leg exceeds ${maxPerLeg}.`
    );
  }
  return { legs: [total], total, maxPerLeg };
}

function portalDateDigits(value) {
  const raw = String(value || '').trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}${iso[3]}${iso[1]}`;
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[1].padStart(2, '0')}${us[2].padStart(2, '0')}${us[3]}`;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 8 && /^20\d{2}/.test(digits)) {
    return `${digits.slice(4, 6)}${digits.slice(6, 8)}${digits.slice(0, 4)}`;
  }
  return digits;
}

function datesMatch(left, right) {
  const a = portalDateDigits(left);
  const b = portalDateDigits(right);
  return Boolean(a && b && a === b);
}

function matchPortalClaimRow(row, claim) {
  if (!row || !row.claim_id || !claim || !claim.tripDate) return false;
  if (!row.service_date) return false;
  return datesMatch(row.service_date, claim.tripDate);
}

function parseMoney(value) {
  const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHcpfStatus(rawStatus) {
  const raw = String(rawStatus || '').trim();
  if (/^paid$/i.test(raw)) return 'paid';
  if (/^denied$/i.test(raw)) return 'denied';
  if (/error\s+submitted\s+data/i.test(raw)) return 'error_submitted_data';
  if (/suspend/i.test(raw)) return 'suspended';
  if (/process|pending|review/i.test(raw)) return 'processing';
  if (/reject/i.test(raw)) return 'rejected';
  return raw ? 'unknown' : 'not_found';
}

module.exports = {
  datesMatch,
  isCorrectedClaim,
  legMilesFromRecord,
  lineModifiers,
  matchPortalClaimRow,
  modifiersForProcedure,
  normalizeHcpfStatus,
  normalizeModifierList,
  normalizeServiceLines,
  parseMoney,
  portalDateDigits,
  validateCorrectionModifierPlan,
  validateMileagePlan
};
