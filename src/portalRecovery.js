'use strict';

function recoverLoginBlocks(ledger, { companyId, providerId, authenticated }) {
  if (authenticated !== true || !companyId || !providerId) throw new Error('Verified company portal login required');
  const recovered = [];
  for (const row of Object.values(ledger.all())) {
    if (row.company_id !== companyId || row.provider_id !== providerId || row.state !== 'blocked') continue;
    if (row.claim_id || !/^PORTAL_BLOCKED: Portal lockout or access block detected/.test(row.note || '')) continue;
    if ((row.history || []).some(h => h.claim_id || ['uncertain', 'submitted', 'already_on_file'].includes(h.to))) continue;
    ledger.record(row.key, { state: 'failed', note: 'Portal login verified by owner recovery; previous pre-submit login block released. No claim submitted by recovery.' });
    recovered.push({ key: row.key, job_id: row.job_id });
  }
  return recovered;
}
module.exports = { recoverLoginBlocks };
