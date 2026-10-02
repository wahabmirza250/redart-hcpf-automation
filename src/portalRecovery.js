'use strict';

function isLoginControlTimeout(note) {
  return /page\.click: Timeout/.test(note || '') && /waiting for locator\('text=Log In'\)/.test(note || '') && /LoginCmnButton/.test(note || '');
}

function isPreFormTimeout(note, claimFormVerified) {
  if (isLoginControlTimeout(note)) return true;
  const text = String(note || '');
  if (claimFormVerified === true && /^BLOCKED_DIAGNOSIS_NOT_COMMITTED:/.test(text) && /Submit was not clicked\./.test(text)) return true;
  if (claimFormVerified === true && /page\.fill: Timeout/.test(text) &&
      /waiting for locator/.test(text) && /PatientNumberCmnTextBox_Control/.test(text) &&
      !/ConfirmCmnButton|SubmitClaimProf3|Confirm is about to|claim_id/i.test(text)) return true;
  return claimFormVerified === true && /locator\.click: Timeout/.test(text) &&
    /waiting for locator\('text=Submit Claim Prof'\)\.last\(\)/.test(text) &&
    /element is not visible/.test(text) &&
    !/ConfirmCmnButton|SubmitClaimProf3|Confirm is about to|claim_id/i.test(text);
}

function recoverLoginBlocks(ledger, { companyId, providerId, authenticated, claimFormVerified = false, tripIds, jobs }) {
  if (authenticated !== true || !companyId || !providerId) throw new Error('Verified company portal login required');
  const recovered = [];
  for (const row of Object.values(ledger.all())) {
    if (row.company_id !== companyId || row.provider_id !== providerId) continue;
    if (tripIds !== undefined && !tripIds.includes(row.trip_id)) continue;
    const loginTimeout = ['uncertain','failed'].includes(row.state) && isPreFormTimeout(row.note, claimFormVerified);
    const loginBlock = row.state === 'blocked' && /^PORTAL_BLOCKED: Portal lockout or access block detected/.test(row.note || '');
    const job = jobs?.get(row.job_id);
    // Only an explicitly scoped owner recovery can release a prior process's
    // job. Confirm is synchronously journaled as uncertain BEFORE the click;
    // a submitting ledger with no unsafe history has not crossed that boundary.
    const interruptedBeforeConfirm = Array.isArray(tripIds) && claimFormVerified === true &&
      row.state === 'submitting' && row.note === 'browser session started' &&
      job?.status === 'running' && job.interruptedByRestart === true && job.ledgerKey === row.key;
    if (row.claim_id || (!loginTimeout && !loginBlock && !interruptedBeforeConfirm)) continue;
    if ((row.history || []).some(h => h.claim_id || ['submitted', 'already_on_file'].includes(h.to) || (h.to === 'uncertain' && !isPreFormTimeout(h.note, claimFormVerified)))) continue;
    ledger.record(row.key, { state: 'failed', note: 'Portal access verified by owner recovery; proven pre-submit failure released. No claim submitted by recovery.' });
    if (interruptedBeforeConfirm) jobs.update(row.job_id, {status:'error',result:{error:'Owner verified interrupted job stopped before durable Confirm boundary; no receipt exists in its history.'},finishedAt:new Date().toISOString()});
    recovered.push({ key: row.key, job_id: row.job_id, trip_id: row.trip_id });
  }
  return recovered;
}
module.exports = { recoverLoginBlocks };
