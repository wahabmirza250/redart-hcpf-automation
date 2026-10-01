'use strict';

function isLoginControlTimeout(note) {
  return /page\.click: Timeout/.test(note || '') && /waiting for locator\('text=Log In'\)/.test(note || '') && /LoginCmnButton/.test(note || '');
}

function recoverLoginBlocks(ledger, { companyId, providerId, authenticated }) {
  if (authenticated !== true || !companyId || !providerId) throw new Error('Verified company portal login required');
  const recovered = [];
  for (const row of Object.values(ledger.all())) {
    if (row.company_id !== companyId || row.provider_id !== providerId) continue;
    const loginTimeout = row.state === 'uncertain' && isLoginControlTimeout(row.note);
    const loginBlock = row.state === 'blocked' && /^PORTAL_BLOCKED: Portal lockout or access block detected/.test(row.note || '');
    if (row.claim_id || (!loginTimeout && !loginBlock)) continue;
    if ((row.history || []).some(h => h.claim_id || ['submitted', 'already_on_file'].includes(h.to) || (h.to === 'uncertain' && !isLoginControlTimeout(h.note)))) continue;
    ledger.record(row.key, { state: 'failed', note: 'Portal login verified by owner recovery; previous pre-submit login block released. No claim submitted by recovery.' });
    recovered.push({ key: row.key, job_id: row.job_id, trip_id: row.trip_id });
  }
  return recovered;
}
module.exports = { recoverLoginBlocks };
