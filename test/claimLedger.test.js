'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaimLedger, ledgerStateFromOutcome, ledgerStateFromError, shouldOpenSubmissionCircuit } = require('../src/claimLedger');
const { JobStore } = require('../src/runtime');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hcpf-ledger-')), name);
}

test('ledger remembers a submitted claim after a process restart', () => {
  const file = tmpFile('claim-ledger.json');
  const first = new ClaimLedger(file);
  const key = ClaimLedger.identityKey({ companyId: 'co-1', tripId: 'trip-9' });
  first.record(key, { state: 'submitted', claim_id: '9426213001270', trip_id: 'trip-9' });

  const restarted = new ClaimLedger(file);
  const row = restarted.get(key);
  assert.equal(row.state, 'submitted');
  assert.equal(row.claim_id, '9426213001270');
});

test('correction keys stay separate from the original trip', () => {
  const original = ClaimLedger.identityKey({ companyId: 'co', tripId: 't1' });
  const correction = ClaimLedger.identityKey({ companyId: 'co', tripId: 't1', correctionId: 'r-2' });
  assert.notEqual(original, correction);
});

test('outcome mapping never treats a missing claim id as submitted', () => {
  assert.equal(ledgerStateFromOutcome({ status: 'SUBMITTED', claim_id: '1' }, 'confirm_submit'), 'submitted');
  assert.equal(ledgerStateFromOutcome({ status: 'SUBMITTED' }, 'confirm_submit'), 'uncertain');
  assert.equal(ledgerStateFromOutcome({ status: 'SUBMITTED_UNVERIFIED' }, 'confirm_submit'), 'uncertain');
  assert.equal(ledgerStateFromOutcome({ status: 'ALREADY_ON_FILE', claim_id: '1' }, 'confirm_submit'), 'already_on_file');
});

test('portal lockout and confirm timeouts stay fail-closed', () => {
  assert.equal(ledgerStateFromError(new Error('PORTAL_BLOCKED: locked'), 'confirm_submit'), 'blocked');
  assert.equal(ledgerStateFromError(new Error('Internal timeout after 480s'), 'confirm_submit'), 'uncertain');
  assert.equal(ledgerStateFromError(new Error('Date Type dropdown did not select'), 'confirm_submit'), 'failed');
});

test('a bad date on one trip does not shut down all billing', () => {
  assert.equal(
    shouldOpenSubmissionCircuit('confirm_submit', null, new Error('Date Type dropdown did not select')),
    false
  );
  assert.equal(
    shouldOpenSubmissionCircuit('confirm_submit', { status: 'SUBMITTED_UNVERIFIED' }, null),
    true
  );
  assert.equal(
    shouldOpenSubmissionCircuit('confirm_submit', null, new Error('PORTAL_BLOCKED: locked')),
    true
  );
});

test('job store reloads running work after restart', () => {
  const file = tmpFile('jobs.json');
  const first = new JobStore({ persistPath: file, ttlMs: 60 * 60 * 1000 });
  first.create('job-1', { status: 'running', startedAt: new Date().toISOString() }, 'trip-1:confirm_submit');
  const restarted = new JobStore({ persistPath: file, ttlMs: 60 * 60 * 1000 });
  assert.equal(restarted.findByKey('trip-1:confirm_submit').jobId, 'job-1');
});
