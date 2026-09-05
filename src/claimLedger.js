'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Durable record of each trip's HCPF outcome.
 * In-memory job maps forget everything on Railway restart; this file does not.
 */
class ClaimLedger {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) this.#write({ version: 1, claims: {} });
  }

  static identityKey({ companyId, tripId, correctionId }) {
    const base = `${companyId || 'default'}::${tripId}`;
    return correctionId ? `${base}::correction::${correctionId}` : base;
  }

  static correctionIdFrom(tripRecord = {}) {
    return tripRecord.resubmission_id || tripRecord.correction_id || null;
  }

  all() {
    return this.#read().claims;
  }

  list(limit = 200) {
    return Object.values(this.all())
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, limit);
  }

  get(key) {
    if (!key) return null;
    return this.#read().claims[key] || null;
  }

  record(key, patch) {
    const data = this.#read();
    const prev = data.claims[key] || { key, state: 'none', history: [] };
    const next = {
      ...prev,
      ...patch,
      key,
      updated_at: new Date().toISOString(),
      history: [...(prev.history || []), {
        at: new Date().toISOString(),
        from: prev.state,
        to: patch.state || prev.state,
        note: patch.note || null,
        claim_id: patch.claim_id || prev.claim_id || null
      }].slice(-40)
    };
    data.claims[key] = next;
    this.#write(data);
    return next;
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.claims) return { version: 1, claims: {} };
      return parsed;
    } catch {
      return { version: 1, claims: {} };
    }
  }

  #write(data) {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

function ledgerStateFromOutcome(result, mode) {
  if (!result) return mode === 'confirm_submit' ? 'uncertain' : 'failed';
  if (result.status === 'SUBMITTED' && result.claim_id) return 'submitted';
  if (result.status === 'SUBMITTED' && !result.claim_id) return 'uncertain';
  if (result.status === 'SUBMITTED_UNVERIFIED') return 'uncertain';
  if (result.status === 'ALREADY_ON_FILE') return 'already_on_file';
  if (String(result.status || '').startsWith('BLOCKED')) return 'failed';
  if (mode === 'confirm_submit' && result.status && result.status !== 'SUBMITTED') return 'failed';
  return null;
}

function ledgerStateFromError(err, mode) {
  const msg = String(err && err.message || '');
  if (/PORTAL_BLOCKED/.test(msg)) return 'blocked';
  if (mode === 'confirm_submit' && /timeout|Confirm|Claim ID/i.test(msg)) return 'uncertain';
  return 'failed';
}

function shouldOpenSubmissionCircuit(mode, result, err) {
  if (mode !== 'confirm_submit') return false;
  if (err && /PORTAL_BLOCKED/.test(err.message || '')) return true;
  if (result && (result.status === 'SUBMITTED_UNVERIFIED' || (result.status === 'SUBMITTED' && !result.claim_id))) {
    return true;
  }
  return false;
}

module.exports = { ClaimLedger, ledgerStateFromOutcome, ledgerStateFromError, shouldOpenSubmissionCircuit };
