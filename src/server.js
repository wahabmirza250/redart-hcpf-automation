/**
 * RedArt LLC - HCPF Automation Server
 *
 * Entry point Railway runs. Exposes endpoints that run submitClaim.js
 * against the HCPF portal.
 *
 * Multiple modes are supported (see /submit-claim):
 * - "capture": fills the claim and stops before Submit - for review only.
 * - "confirm_submit" (with i_understand_this_is_real: true): a real,
 *   final submission - clicks the real Submit AND Confirm buttons on the
 *   real portal, proven working end-to-end on real paid claims. This is
 *   NOT a manual-review-only flow - it genuinely submits.
 * - "debug_confirm_page": clicks the real Submit button and reaches the
 *   real Confirm page for inspection, but deliberately stops there and
 *   never clicks Confirm - safe for testing against real data.
 * - "verify_only": checks a Medicaid ID against the portal, no billing.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { run, discoverSearchClaims, searchClaims } = require('./submitClaim');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'redart-hcpf-automation', claim_search: true });
});

// === ADDED (2026-08-14) === debug-source-check was discovered to only
// ever reflect submitClaim.js, regardless of query params - meaning
// every server.js deploy today (queue fixes, timeout fix, this very
// disable-removal) was never actually verifiable through it. This
// endpoint reads server.js's own real, currently-running file content
// directly, so deployment of THIS specific file can finally be checked
// with certainty.
app.get('/debug-server-check', (req, res) => {
  try {
    const src = fs.readFileSync(__filename, 'utf8');
    // === FIXED === Searching for the bare string "CONFIRM_SUBMIT_ENABLED"
    // always returned true, because THIS diagnostic code itself contains
    // that string (it has to, in order to search for it) - a
    // self-referential false positive. This regex instead matches only
    // the actual variable DECLARATION that creates the real disable
    // logic - something this diagnostic's own code does not contain.
    const hasActiveDisableFlag = /const\s+CONFIRM_SUBMIT_ENABLED\s*=\s*false/.test(src);
    res.json({
      file: __filename,
      lineCount: src.split('\n').length,
      fileLength: src.length,
      lastModified: fs.statSync(__filename).mtime,
      hasActiveDisableFlag,
      hasNormalSafetyFlagGate: src.includes('BLOCKED_MISSING_SAFETY_FLAG')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/last-run-screenshot', (req, res) => {
  const successPath = path.join(__dirname, '../last-run-success.png');
  const errorPath = path.join(__dirname, '../last-run-error.png');
  if (fs.existsSync(errorPath)) return res.sendFile(errorPath);
  if (fs.existsSync(successPath)) return res.sendFile(successPath);
  res.status(404).json({ error: 'No screenshot yet - run /submit-claim first' });
});

app.get('/debug-row2-fields', async (req, res) => {
  const { chromium } = require('playwright');
  const config = JSON.parse(fs.readFileSync(`${__dirname}/../config/hcpf-colorado.json`, 'utf-8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.click(config.selectors.navigation.claimsMenuLink);
    await page.click(config.selectors.navigation.submitClaimProfLink);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const sel = config.selectors.step1_claimHeader;
    const memberId = req.query.member_id || 'M964077';
    const tripDate = req.query.trip_date || '07/01/2026';
    await page.fill(sel.memberIdField, memberId);
    await page.locator(sel.memberIdField).blur();
    await page.waitForTimeout(1500);
    await page.fill(sel.patientNumberField, 'debug-test');
    await page.selectOption(sel.dateTypeDropdown, { label: sel.dateTypeValue }).catch(() => {});
    await page.fill(sel.dateOfCurrentField, tripDate).catch(() => {});
    await page.check(sel.transportCertNoRadio);
    await page.check(sel.signatureOnFileYesRadio);
    await page.click(sel.continueButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const sel2 = config.selectors.step2_diagnosisAndServiceLines;
    const diagCode = req.query.diagnosis_code || 'R688';
    await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
    await page.fill(sel2.diagnosisCodeField, diagCode);
    await page.waitForTimeout(500);
    const suggestion = page.locator(`text=${diagCode}`).first();
    if (await suggestion.isVisible().catch(() => false)) await suggestion.click();
    await page.click(sel2.diagnosisCodeAddButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.click(sel2.step2ContinueButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const sel3 = config.selectors.step3_serviceDetails;

    await page.locator(sel3.fromDateField).click({ timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Home').catch(() => {});
    await page.keyboard.press('Shift+End').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.type('07012026', { delay: 50 }).catch(() => {});
    await page.locator(sel3.toDateField).click({ timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Home').catch(() => {});
    await page.keyboard.press('Shift+End').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.type('07012026', { delay: 50 }).catch(() => {});
    await page.selectOption(sel3.placeOfServiceDropdown, { label: sel3.placeOfServiceValue }).catch(() => {});
    await page.fill(sel3.procedureCodeField, 'A0120').catch(() => {});
    await page.selectOption(sel3.unitTypeDropdown, { label: sel3.unitTypeValue }).catch(() => {});
    await page.selectOption(sel3.diagnosisPointer1Dropdown, { label: sel3.diagnosisPointerValue }).catch(() => {});
    await page.fill(sel3.chargeAmountField, '12.15').catch(() => {});
    await page.locator(sel3.chargeAmountField).blur().catch(() => {});
    await page.waitForTimeout(1000);
    await page.fill(sel3.unitsField, '1.000').catch(() => {});
    await page.locator(sel3.unitsField).blur().catch(() => {});
    await page.waitForTimeout(1000);

    await page.locator(sel3.addServiceLineButton).click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const fields = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input, select').forEach(el => {
        results.push({
          tag: el.tagName,
          type: el.type || null,
          id: el.id || null,
          visible: el.offsetParent !== null
        });
      });
      return results;
    });

    const serviceFields = fields.filter(f => f.id && f.id.includes('ServiceDetailsDataList'));

    res.json({ serviceFieldCount: serviceFields.length, serviceFields, currentUrl: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.get('/debug-capture-network', async (req, res) => {
  const { chromium } = require('playwright');
  const config = JSON.parse(fs.readFileSync(`${__dirname}/../config/hcpf-colorado.json`, 'utf-8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const capturedRequests = [];
  page.on('request', request => {
    if (request.method() === 'POST') {
      capturedRequests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData() ? request.postData().slice(0, 3000) : null
      });
    }
  });

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    res.json({
      note: 'Captured POST requests during login. Look for __VIEWSTATE, __EVENTVALIDATION, and other hidden fields in postData - these are session-specific tokens that would need to be scraped from the HTML fresh on every single request if replicating via raw HTTP.',
      requestCount: capturedRequests.length,
      requests: capturedRequests
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.get('/debug-attachment-fields', async (req, res) => {
  const { chromium } = require('playwright');
  const config = JSON.parse(fs.readFileSync(`${__dirname}/../config/hcpf-colorado.json`, 'utf-8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.click(config.selectors.navigation.claimsMenuLink);
    await page.click(config.selectors.navigation.submitClaimProfLink);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const sel = config.selectors.step1_claimHeader;
    await page.fill(sel.memberIdField, req.query.member_id || 'M964077');
    await page.locator(sel.memberIdField).blur();
    await page.waitForTimeout(1500);
    await page.fill(sel.patientNumberField, 'debug-test');
    await page.selectOption(sel.dateTypeDropdown, { label: sel.dateTypeValue }).catch(() => {});
    await page.fill(sel.dateOfCurrentField, req.query.trip_date || '07/01/2026').catch(() => {});
    await page.check(sel.transportCertNoRadio);
    await page.check(sel.signatureOnFileYesRadio);
    await page.click(sel.continueButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const sel2 = config.selectors.step2_diagnosisAndServiceLines;
    const diagCode = req.query.diagnosis_code || 'R688';
    await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
    await page.fill(sel2.diagnosisCodeField, diagCode);
    await page.waitForTimeout(500);
    const suggestion = page.locator(`text=${diagCode}`).first();
    if (await suggestion.isVisible().catch(() => false)) await suggestion.click();
    await page.locator(sel2.diagnosisCodeAddButton).last().click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.click(sel2.step2ContinueButton);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const sel3 = config.selectors.step3_serviceDetails;
    await page.locator(sel3.attachmentUploadLink).click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const attachmentFields = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input, select').forEach(el => {
        const idLower = (el.id || '').toLowerCase();
        if (idLower.includes('attach') || idLower.includes('transmission') || idLower.includes('control')) {
          const entry = {
            tag: el.tagName, type: el.type || null, id: el.id || null,
            visible: el.offsetParent !== null
          };
          if (el.tagName === 'SELECT') {
            entry.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text }));
          }
          results.push(entry);
        }
      });
      const links = [];
      document.querySelectorAll('a').forEach(a => {
        const idLower = (a.id || '').toLowerCase();
        const text = (a.textContent || '').trim();
        if (idLower.includes('attach') || text.toLowerCase().includes('add') || text.toLowerCase().includes('cancel')) {
          links.push({ id: a.id || null, text, visible: a.offsetParent !== null });
        }
      });
      return { attachmentFields: results, attachmentLinks: links };
    });

    res.json(attachmentFields);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.get('/debug-source-check', (req, res) => {
  try {
    const source = fs.readFileSync(`${__dirname}/submitClaim.js`, 'utf-8');
    res.json({
      hasNewMarker: source.includes('ATTACHMENT_V2_MARKER'),
      hasReExpandLogic: source.includes('re-expanding'),
      fileLength: source.length,
      lineCount: source.split('\n').length,
      lastModified: fs.statSync(`${__dirname}/submitClaim.js`).mtime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const jobs = {};

// === STABILITY HARDENING === One worker process may never own more than
// four live browser sessions total, even when several tenant accounts are
// active at once. Waiting requests hold no Chromium process.
const GLOBAL_MAX_CONCURRENT_SESSIONS = 4;
let globalActiveSessionCount = 0;
const globalWaitQueue = [];

async function acquireGlobalSlot() {
  if (globalActiveSessionCount < GLOBAL_MAX_CONCURRENT_SESSIONS) {
    globalActiveSessionCount += 1;
    return;
  }
  await new Promise(resolve => globalWaitQueue.push(resolve));
  // A released slot is transferred directly to this waiter, so the active
  // count deliberately stays unchanged while ownership changes hands.
}

function releaseGlobalSlot() {
  const next = globalWaitQueue.shift();
  if (next) {
    next();
    return;
  }
  globalActiveSessionCount = Math.max(0, globalActiveSessionCount - 1);
}

// === ADDED === Per-account mutex around real HCPF portal sessions.
// The portal itself force-logs-out ALL sessions on an account when it
// detects concurrent logins ("A security access violation has been
// detected..."). This queues portal-touching work so only one browser
// session per account is ever open at a time, regardless of which
// endpoint (submit-claim, verify-member, future ones) triggered it.
//
// === UPDATED (2026-08-28) === Hard-capped to the same 4-session ceiling as
// the worker-wide limit. This prevents one account or multiple tenants from
// creating more live Chromium sessions than the Railway worker can safely own.
const MAX_CONCURRENT_SESSIONS = GLOBAL_MAX_CONCURRENT_SESSIONS;
const activeSessionCounts = new Map(); // accountKey -> number of sessions currently running
const waitQueues = new Map(); // accountKey -> array of resolve functions waiting for a free slot
const lastSessionEndedAt = new Map(); // accountKey -> timestamp (ms) of last session close

function portalAccountKey(providerId, companyId) {
  return `${providerId || 'unknown-provider'}::${companyId || 'default'}`;
}

// Keep the effective production pacing that the old package.json runtime
// mutation produced, but make it explicit and auditable in source.
const MIN_SESSION_COOLDOWN_MS = 5000; // 5 seconds

async function acquireSlot(accountKey) {
  const current = activeSessionCounts.get(accountKey) || 0;
  if (current < MAX_CONCURRENT_SESSIONS) {
    activeSessionCounts.set(accountKey, current + 1);
    return;
  }
  // No free slot - wait in line until one opens up.
  await new Promise(resolve => {
    const queue = waitQueues.get(accountKey) || [];
    queue.push(resolve);
    waitQueues.set(accountKey, queue);
  });
  activeSessionCounts.set(accountKey, (activeSessionCounts.get(accountKey) || 0) + 1);
}

function releaseSlot(accountKey) {
  const current = activeSessionCounts.get(accountKey) || 1;
  activeSessionCounts.set(accountKey, Math.max(0, current - 1));
  const queue = waitQueues.get(accountKey) || [];
  const next = queue.shift();
  if (next) {
    waitQueues.set(accountKey, queue);
    next(); // wake the next waiter - they'll re-check the count and proceed
  }
}

async function withPortalSession(accountKey, fn) {
  let globalAcquired = false;
  let accountAcquired = false;

  try {
    await acquireGlobalSlot();
    globalAcquired = true;

    await acquireSlot(accountKey);
    accountAcquired = true;

    // Enforce cooldown since the last session actually ended - paced per
    // account, independent of how many slots are concurrently in use.
    const lastEnded = lastSessionEndedAt.get(accountKey);
    if (lastEnded) {
      const elapsed = Date.now() - lastEnded;
      if (elapsed < MIN_SESSION_COOLDOWN_MS) {
        const waitMs = MIN_SESSION_COOLDOWN_MS - elapsed;
        console.log(`Portal cooldown: waiting ${Math.round(waitMs / 1000)}s before next session on ${accountKey}.`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }

    // run()/discoverSearchClaims own their browser lifecycle. Never race
    // portal work with a wrapper timeout that would free a semaphore slot
    // while the underlying Chromium process is still alive.
    return await fn();
  } finally {
    if (accountAcquired) {
      lastSessionEndedAt.set(accountKey, Date.now());
      releaseSlot(accountKey);
    }
    if (globalAcquired) {
      releaseGlobalSlot();
    }
  }
}

function portalQueueLength(accountKey) {
  // Best-effort hint for the "queued: true" response - true if we're
  // currently at or above the concurrent-session limit for this account.
  return (activeSessionCounts.get(accountKey) || 0) >= MAX_CONCURRENT_SESSIONS ? 1 : 0;
}

// === ADDED (2026-08-19) === Read-only discovery endpoint for building the
// claim-status-check feature. Logs in and reports back the REAL Search
// Claims screen structure (or reports it couldn't find one) - never
// fills a form, never clicks Submit/Confirm. Uses the same portal
// session queue as everything else, so it can never run concurrently
// with a real submission on the same account.
app.post('/discover-search-claims', async (req, res) => {
  const companyId = req.body?.company_id || null;
  const testClaim = req.body?.test_claim || null;
  const accountKey = portalAccountKey(req.body?.provider_id, companyId);
  const jobId = `discover-search-claims-${Date.now()}`;
  jobs[jobId] = { status: 'running', result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, checkStatusAt: `/job-status/${jobId}` });

  const timeoutMs = 3 * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Discovery timed out after ${timeoutMs / 1000}s.`)), timeoutMs)
  );

  Promise.race([
    withPortalSession(accountKey, () => discoverSearchClaims(companyId, testClaim)),
    timeoutPromise
  ])
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running search-claims discovery:', err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

app.post('/submit-claim', async (req, res) => {
  const tripRecord = req.body;
  if (!tripRecord || !tripRecord.id) {
    return res.status(400).json({ error: 'Missing trip record or trip id in request body' });
  }

  // === ADDED === This route previously never passed any mode through to
  // run(), so a Pass-1 "capture" request silently ran the normal full
  // fill-and-stop flow instead. Normalize whichever flag shape the
  // caller sends into a single mode value.
  const requestedMode = tripRecord.mode === 'capture'
    || tripRecord.capture_only === true
    || tripRecord.return_captured_data === true
    ? 'capture'
    : tripRecord.mode === 'debug_confirm_page'
      ? 'debug_confirm_page'
      : tripRecord.mode === 'confirm_submit' && tripRecord.i_understand_this_is_real === true
        ? 'confirm_submit'
        : tripRecord.mode === 'confirm_submit'
          ? 'BLOCKED_MISSING_SAFETY_FLAG'
          : undefined;

  if (requestedMode === 'BLOCKED_MISSING_SAFETY_FLAG') {
    return res.status(400).json({
      error: 'confirm_submit requires i_understand_this_is_real: true in the request body. This is a real, final, irreversible claim submission - this flag exists so it can never be triggered accidentally.'
    });
  }

  const jobId = `${tripRecord.id}-${Date.now()}`;
  const accountKey = portalAccountKey(tripRecord.provider_id, tripRecord.company_id);
  const queued = portalQueueLength(accountKey) > 0 || globalActiveSessionCount >= GLOBAL_MAX_CONCURRENT_SESSIONS;
  jobs[jobId] = { status: 'running', queued, result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, queued, checkStatusAt: `/job-status/${jobId}` });

  // withPortalSession now keeps both worker/account slots until run()
  // genuinely completes and its browser finally block has closed Chromium.
  withPortalSession(accountKey, () => run(tripRecord, requestedMode))
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running claim submission:', err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

// === ADDED === dedicated verify-only endpoint. Completely separate
// route from /submit-claim above - a request here can never trigger the
// full submit path, since it always calls run() with mode explicitly
// set to 'verify_only'.
// === ADDED (risk hardening) === Lightweight daily health-check. Runs
// the exact same verify_only flow as /verify-member (real login, reads
// back a known-good member's name, closes session - never touches
// billing) but with a fixed safe test case, so this can be called by
// an external daily scheduler to catch an account deactivation within
// hours instead of discovering it accidentally during real billing work.
app.get('/health-check-portal', async (req, res) => {
  const providerId = req.query.provider_id;
  if (!providerId) {
    return res.status(400).json({ error: 'provider_id query param is required' });
  }

  const KNOWN_GOOD_MEMBER_ID = 'M964077';
  const KNOWN_GOOD_MEMBER_NAME = 'Jesus Casillas';

  const tripRecord = {
    id: `health-check-${Date.now()}`,
    provider_id: providerId,
    vehicle_type: 'ambulatory',
    medicaid_member_id: KNOWN_GOOD_MEMBER_ID,
    trip_date: new Date().toLocaleDateString('en-US'),
    signature_captured: true,
    expected_name: KNOWN_GOOD_MEMBER_NAME
  };

  try {
    const accountKey = portalAccountKey(providerId, tripRecord.company_id);
    const result = await withPortalSession(accountKey, () => run(tripRecord, 'verify_only'));
    const accountActive = result && result.matched !== undefined;
    res.json({
      account_active: accountActive,
      checked_at: new Date().toISOString(),
      detail: result
    });
  } catch (err) {
    // A deactivation or portal error surfaces here - this IS the signal
    // this endpoint exists to catch.
    res.json({
      account_active: false,
      checked_at: new Date().toISOString(),
      error: err.message
    });
  }
});

app.post('/verify-member', async (req, res) => {
  const { member_id, ssn, dob, expected_name, provider_id, company_id } = req.body || {};

  if (!expected_name) {
    return res.status(400).json({ ok: false, error: 'input_invalid', detail: 'expected_name is required' });
  }
  if (!member_id && !(ssn && dob)) {
    return res.status(400).json({ ok: false, error: 'input_invalid', detail: 'Provide either member_id, or both ssn and dob' });
  }
  if (member_id && (ssn || dob)) {
    return res.status(400).json({ ok: false, error: 'input_invalid', detail: 'Provide member_id OR ssn+dob, not both' });
  }

  // NOTE: ssn+dob path is not yet implemented in submitClaim.js - that
  // requires the separate Eligibility Verification portal screen, which
  // is a different flow than Member ID entry on the claim form. This
  // endpoint currently only supports the member_id path end-to-end.
  if (ssn && dob) {
    return res.status(501).json({
      ok: false,
      error: 'not_implemented',
      detail: 'ssn+dob verification requires the Eligibility Verification portal flow, which is not yet built. Use member_id for now.'
    });
  }

  // Build a minimal fake tripRecord - just enough for mapTripToClaim to
  // pass validation. provider_id is required for portal credential
  // lookup; a placeholder id is fine since verify_only never reaches
  // any code that uses trip id for billing.
  const tripRecord = {
    id: `verify-${Date.now()}`,
    provider_id: provider_id || null,
    medicaid_member_id: member_id,
    passenger_name: expected_name,
    trip_date: new Date().toISOString().slice(0, 10),
    company_id: company_id || null
  };

  if (!tripRecord.provider_id) {
    return res.status(400).json({ ok: false, error: 'input_invalid', detail: 'provider_id is required' });
  }

  try {
    // === CHANGED === wrapped in withPortalSession using the same
    // accountKey scheme as submit-claim, so a verify-member call can
    // never open a second concurrent session on the same HCPF account.
    const accountKey = portalAccountKey(tripRecord.provider_id, tripRecord.company_id);
    const result = await withPortalSession(accountKey, () => run(tripRecord, 'verify_only'));

    if (result.status === 'VERIFY_ONLY_COMPLETE') {
      return res.json({
        ok: true,
        portal_name: result.portal_name,
        matched: result.matched,
        match_confidence: result.match_confidence
      });
    }

    // mapTripToClaim rejected it before the browser even opened
    // (e.g. BLOCKED_MISSING_PORTAL_CREDENTIALS, BLOCKED_MISSING_PROVIDER_ID)
    return res.status(422).json({
      ok: false,
      error: result.status || 'verification_failed',
      detail: result.reason || 'Verification did not complete'
    });
  } catch (err) {
    console.error('Error running member verification:', err.message);
    return res.status(500).json({ ok: false, error: 'portal_unavailable', detail: err.message });
  }
});

app.get('/job-status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'No job found with that ID' });
  res.json(job);
});

app.post('/search-claims', async (req, res) => {
  const { member_id, service_date, claim_id, billing_id, provider_id, company_id } = req.body || {};

  if (!member_id && !claim_id && !billing_id) {
    return res.status(400).json({
      ok: false,
      error: 'input_invalid',
      detail: 'At least one of member_id, claim_id, or billing_id must be provided'
    });
  }

  if (!provider_id) {
    return res.status(400).json({ ok: false, error: 'input_invalid', detail: 'provider_id is required' });
  }

  const jobId = `search-claims-${Date.now()}`;
  const accountKey = portalAccountKey(provider_id, company_id);
  const queued = portalQueueLength(accountKey) > 0 || globalActiveSessionCount >= GLOBAL_MAX_CONCURRENT_SESSIONS;
  jobs[jobId] = { status: 'running', queued, result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, queued, checkStatusAt: `/job-status/${jobId}` });

  const timeoutMs = 3 * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Search timed out after ${timeoutMs / 1000}s.`)), timeoutMs)
  );

  Promise.race([
    withPortalSession(accountKey, () => searchClaims(company_id, member_id, service_date, claim_id, billing_id)),
    timeoutPromise
  ])
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running claim search:', err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RedArt HCPF automation server running on port ${PORT}`);
});
