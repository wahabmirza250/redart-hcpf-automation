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
const crypto = require('crypto');
const { run, discoverSearchClaims, searchClaims } = require('./submitClaim');
const { JobStore, PortalScheduler } = require('./runtime');
const { ClaimLedger, ledgerStateFromOutcome, ledgerStateFromError, shouldOpenSubmissionCircuit } = require('./claimLedger');

const app = express();
app.use(express.json());

const startedAt = new Date().toISOString();
const jobs = new JobStore();
const portalScheduler = new PortalScheduler();
const ledger = new ClaimLedger(process.env.CLAIM_LEDGER_PATH || path.join(process.cwd(), 'data', 'claim-ledger.json'));
const debugPortalEnabled = () => String(process.env.DEBUG_PORTAL || '').toLowerCase() === 'true';

function requireDebugPortal(req, res, next) {
  if (!debugPortalEnabled()) {
    return res.status(404).json({
      error: 'DEBUG_PORTAL_DISABLED',
      detail: 'Live portal debug routes each create a fresh HCPF login. Set DEBUG_PORTAL=true only while diagnosing.'
    });
  }
  next();
}

const submissionsPaused = () => String(process.env.SUBMISSIONS_PAUSED || '').toLowerCase() === 'true';
let submissionCircuit = {
  open: false,
  opened_at: null,
  reason: null,
  job_id: null
};

function openSubmissionCircuit(reason, jobId = null) {
  submissionCircuit = {
    open: true,
    opened_at: new Date().toISOString(),
    reason: String(reason || 'unknown submission failure'),
    job_id: jobId
  };
  console.error('SUBMISSION_CIRCUIT_OPEN:', JSON.stringify(submissionCircuit));
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'redart-hcpf-automation',
    claim_search: true,
    denial_details: true,
    modifier_proof: true,
    mileage_limit_per_leg: 52,
    submissions_paused: submissionsPaused(),
    submission_circuit: submissionCircuit,
    runtime: portalScheduler.snapshot(),
    jobs_in_memory: jobs.count(),
    ledger_claims: ledger.list(1000).length,
    started_at: startedAt
  });
});

app.get('/app', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLedgerPage());
});

app.get('/ledger', (req, res) => {
  res.json({ ok: true, claims: ledger.list(500) });
});

app.get('/ledger/:key', (req, res) => {
  const row = ledger.get(req.params.key);
  if (!row) return res.status(404).json({ error: 'No ledger row for that key' });
  res.json(row);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'redart-hcpf-automation', started_at: startedAt });
});

app.get('/ready', (req, res) => {
  const runtime = portalScheduler.snapshot();
  res.json({ ok: true, accepting_jobs: !submissionsPaused(), runtime });
});

app.get('/safety-status', (req, res) => {
  res.json({
    submissions_paused: submissionsPaused(),
    submission_circuit: submissionCircuit,
    safeguards: {
      modifier_readback_required: true,
      committed_modifier_proof_required: true,
      mileage_limit_per_leg: 52,
      corrected_claims_fail_closed_without_modifier_review: true,
      denial_reason_capture: true,
      durable_claim_ledger: true,
      uncertain_never_auto_retries: true,
      portal_session_reuse: true
    }
  });
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

app.get('/debug-row2-fields', requireDebugPortal, async (req, res) => {
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

app.get('/debug-capture-network', requireDebugPortal, async (req, res) => {
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

app.get('/debug-attachment-fields', requireDebugPortal, async (req, res) => {
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

function portalAccountKey(providerId, companyId) {
  return `${providerId || 'unknown-provider'}::${companyId || 'default'}`;
}

const withPortalSession = (accountKey, fn) => portalScheduler.run(accountKey, fn);

function portalQueueLength(accountKey) {
  return portalScheduler.queued(accountKey) ? 1 : 0;
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
  jobs.create(jobId, { status: 'running', result: null, startedAt: new Date().toISOString() });
  res.json({ status: 'started', jobId, checkStatusAt: `/job-status/${jobId}` });

  const timeoutMs = 3 * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Discovery timed out after ${timeoutMs / 1000}s.`)), timeoutMs)
  );

  Promise.race([
    withPortalSession(accountKey, () => discoverSearchClaims(companyId, { ...testClaim, provider_id: req.body?.provider_id })),
    timeoutPromise
  ])
    .then(result => {
      jobs.update(jobId, { status: 'done', result, finishedAt: new Date().toISOString() });
    })
    .catch(err => {
      console.error('Error running search-claims discovery:', err);
      jobs.update(jobId, { status: 'error', result: { error: err.message }, finishedAt: new Date().toISOString() });
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

  if (requestedMode === 'debug_confirm_page' && !debugPortalEnabled()) {
    return res.status(403).json({
      error: 'DEBUG_PORTAL_DISABLED',
      detail: 'debug_confirm_page clicks the real HCPF Submit button. Enable DEBUG_PORTAL=true only while diagnosing.'
    });
  }

  if (requestedMode === 'BLOCKED_MISSING_SAFETY_FLAG') {
    return res.status(400).json({
      error: 'confirm_submit requires i_understand_this_is_real: true in the request body. This is a real, final, irreversible claim submission - this flag exists so it can never be triggered accidentally.'
    });
  }

  if (requestedMode === 'confirm_submit' && submissionsPaused()) {
    return res.status(503).json({
      error: 'SUBMISSIONS_PAUSED',
      detail: 'Real HCPF submissions are temporarily paused for production stabilization. Capture and claim-status searches remain available.'
    });
  }

  if (requestedMode === 'confirm_submit' && submissionCircuit.open) {
    return res.status(503).json({
      error: 'SUBMISSION_CIRCUIT_OPEN',
      detail: submissionCircuit.reason,
      opened_at: submissionCircuit.opened_at,
      job_id: submissionCircuit.job_id
    });
  }

  const jobId = `${tripRecord.id}-${Date.now()}`;
  const accountKey = portalAccountKey(tripRecord.provider_id, tripRecord.company_id);
  // The payload fingerprint blocks accidental double-clicks while still
  // allowing a genuinely corrected version of the same bill to run later.
  const payloadFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(tripRecord))
    .digest('hex')
    .slice(0, 20);
  const stableModeKey = requestedMode === 'confirm_submit'
    ? `${tripRecord.company_id || 'default'}:${tripRecord.id}:${requestedMode}:${ClaimLedger.correctionIdFrom(tripRecord) || 'original'}`
    : `${tripRecord.company_id || 'default'}:${tripRecord.id}:${requestedMode || 'default'}:${payloadFingerprint}`;
  const idempotencyKey = stableModeKey;
  const ledgerKey = requestedMode === 'confirm_submit'
    ? ClaimLedger.identityKey({
      companyId: tripRecord.company_id,
      tripId: tripRecord.id,
      correctionId: ClaimLedger.correctionIdFrom(tripRecord)
    })
    : null;

  if (ledgerKey) {
    const prior = ledger.get(ledgerKey);
    if (prior && (prior.state === 'submitted' || prior.state === 'already_on_file')) {
      return res.json({
        status: 'done',
        duplicate: true,
        jobId: prior.job_id || null,
        result: {
          status: 'ALREADY_ON_FILE',
          claim_id: prior.claim_id || null,
          message: `This trip is already on the claim ledger${prior.claim_id ? ` as Claim ID ${prior.claim_id}` : ''}. Submit will not run again.`
        },
        ledger: prior
      });
    }
    if (prior && prior.state === 'uncertain') {
      return res.status(409).json({
        error: 'CLAIM_UNCERTAIN',
        detail: 'A previous submit may have reached HCPF, but no Claim ID was captured. POST /reconcile-claim (search only) before sending again. Do not resubmit blindly.',
        ledger: prior
      });
    }
    if (prior && prior.state === 'submitting') {
      const age = Date.now() - Date.parse(prior.updated_at || '');
      if (Number.isFinite(age) && age < 15 * 60 * 1000) {
        return res.status(409).json({
          error: 'CLAIM_IN_PROGRESS',
          detail: 'This trip is already being submitted. Wait for that job to finish.',
          ledger: prior
        });
      }
      ledger.record(ledgerKey, {
        state: 'uncertain',
        note: 'stale submitting lease after restart or timeout; search the portal before retrying'
      });
      return res.status(409).json({
        error: 'CLAIM_UNCERTAIN',
        detail: 'A previous attempt was interrupted. Search the portal before sending again.',
        ledger: ledger.get(ledgerKey)
      });
    }
    if (prior && prior.state === 'blocked') {
      return res.status(503).json({
        error: 'PORTAL_BLOCKED',
        detail: prior.note || 'This account was previously blocked by the portal. A human must confirm the login works before billing resumes.',
        ledger: prior
      });
    }
  }

  const existing = jobs.findByKey(idempotencyKey);
  if (existing && (existing.status === 'running' || existing.status === 'done')) {
    return res.json({ status: existing.status, jobId: existing.jobId, queued: existing.queued, duplicate: true, checkStatusAt: `/job-status/${existing.jobId}` });
  }
  const queued = portalQueueLength(accountKey) > 0;
  jobs.create(jobId, { status: 'running', queued, result: null, startedAt: new Date().toISOString(), ledgerKey }, idempotencyKey);
  if (ledgerKey) {
    ledger.record(ledgerKey, {
      state: 'submitting',
      job_id: jobId,
      trip_id: tripRecord.id,
      company_id: tripRecord.company_id || null,
      member_id: tripRecord.medicaid_member_id || tripRecord.member_id || null,
      service_date: tripRecord.trip_date || tripRecord.service_date || null,
      note: 'browser session started'
    });
  }
  res.json({ status: 'started', jobId, queued, checkStatusAt: `/job-status/${jobId}`, ledgerKey });

  withPortalSession(accountKey, () => run(tripRecord, requestedMode))
    .then(result => {
      jobs.update(jobId, { status: 'done', result, finishedAt: new Date().toISOString() });
      if (ledgerKey) {
        const state = ledgerStateFromOutcome(result, requestedMode) || 'failed';
        ledger.record(ledgerKey, {
          state,
          job_id: jobId,
          claim_id: result?.claim_id || null,
          note: result?.message || result?.status || null
        });
      }
      if (shouldOpenSubmissionCircuit(requestedMode, result, null)) {
        openSubmissionCircuit(result.message || result.status, jobId);
      }
    })
    .catch(err => {
      console.error('Error running claim submission:', err);
      jobs.update(jobId, { status: 'error', result: { error: err.message }, finishedAt: new Date().toISOString() });
      if (ledgerKey) {
        ledger.record(ledgerKey, {
          state: ledgerStateFromError(err, requestedMode),
          job_id: jobId,
          note: err.message
        });
      }
      if (shouldOpenSubmissionCircuit(requestedMode, null, err)) openSubmissionCircuit(err.message, jobId);
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
  const job = jobs.get(req.params.jobId);
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
  const queued = portalQueueLength(accountKey) > 0;
  jobs.create(jobId, { status: 'running', queued, result: null, startedAt: new Date().toISOString() });
  res.json({ status: 'started', jobId, queued, checkStatusAt: `/job-status/${jobId}` });

  const timeoutMs = 3 * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Search timed out after ${timeoutMs / 1000}s.`)), timeoutMs)
  );

  Promise.race([
    withPortalSession(accountKey, () => searchClaims(company_id, member_id, service_date, claim_id, billing_id, provider_id)),
    timeoutPromise
  ])
    .then(result => {
      jobs.update(jobId, { status: 'done', result, finishedAt: new Date().toISOString() });
    })
    .catch(err => {
      console.error('Error running claim search:', err);
      jobs.update(jobId, { status: 'error', result: { error: err.message }, finishedAt: new Date().toISOString() });
    });
});

app.post('/reconcile-claim', async (req, res) => {
  const { trip_id, member_id, service_date, claim_id, billing_id, provider_id, company_id, mark_failed_if_missing } = req.body || {};
  if (!provider_id) {
    return res.status(400).json({ ok: false, error: 'input_invalid', detail: 'provider_id is required' });
  }
  if (!member_id && !claim_id && !billing_id) {
    return res.status(400).json({ ok: false, error: 'input_invalid', detail: 'member_id, claim_id, or billing_id is required' });
  }

  const ledgerKey = trip_id
    ? ClaimLedger.identityKey({ companyId: company_id, tripId: trip_id, correctionId: ClaimLedger.correctionIdFrom(req.body) })
    : null;

  try {
    const accountKey = portalAccountKey(provider_id, company_id);
    const result = await withPortalSession(accountKey, () =>
      searchClaims(company_id, member_id, service_date, claim_id, billing_id, provider_id)
    );
    const hits = result?.results?.claims || [];
    const match = hits[0] || null;
    if (ledgerKey && match?.claim_id) {
      ledger.record(ledgerKey, {
        state: 'already_on_file',
        claim_id: match.claim_id,
        note: 'reconciled from portal search; submit will not run again'
      });
    } else if (ledgerKey && !match && mark_failed_if_missing === true) {
      ledger.record(ledgerKey, {
        state: 'failed',
        note: 'portal search found no claim; human approved a later retry'
      });
    }
    res.json({
      ok: true,
      found: Boolean(match),
      match,
      result,
      ledger: ledgerKey ? ledger.get(ledgerKey) : null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'reconcile_failed', detail: err.message });
  }
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLedgerPage() {
  const rows = ledger.list(200);
  const body = rows.length
    ? rows.map(row => `
      <tr>
        <td>${escapeHtml(row.state)}</td>
        <td>${escapeHtml(row.trip_id)}</td>
        <td>${escapeHtml(row.claim_id)}</td>
        <td>${escapeHtml(row.member_id)}</td>
        <td>${escapeHtml(row.service_date)}</td>
        <td>${escapeHtml(row.updated_at)}</td>
        <td>${escapeHtml(row.note)}</td>
      </tr>`).join('')
    : '<tr><td colspan="7">No claims recorded yet. After a submit or search, they show up here and survive restarts.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RedArt HCPF claim ledger</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f6f1e8; color: #1d1a16; }
    header { padding: 28px 20px 12px; max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 1.7rem; margin: 0 0 8px; }
    p { line-height: 1.45; max-width: 70ch; }
    main { max-width: 1100px; margin: 0 auto 48px; padding: 0 20px; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #ddd2c0; font-size: 0.92rem; vertical-align: top; }
    th { font-size: 0.78rem; letter-spacing: 0.04em; text-transform: uppercase; color: #5c5348; }
    .state { font-weight: 700; }
    .note { color: #5c5348; }
    @media (max-width: 720px) {
      table, thead, tbody, th, td, tr { display: block; }
      th { display: none; }
      td { border-bottom: 0; }
      tr { background: #fff; margin: 0 0 12px; padding: 10px; border: 1px solid #ddd2c0; }
    }
  </style>
</head>
<body>
  <header>
    <h1>HCPF claim ledger</h1>
    <p>This robot remembers every trip it has tried to bill. <strong>submitted</strong> and <strong>already on file</strong> will never be sent again. <strong>uncertain</strong> means Confirm may have fired — search the portal, do not guess.</p>
  </header>
  <main>
    <table>
      <thead>
        <tr>
          <th>State</th><th>Trip</th><th>Claim ID</th><th>Member</th><th>Service date</th><th>Updated</th><th>Note</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </main>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RedArt HCPF automation server running on port ${PORT}`);
});
