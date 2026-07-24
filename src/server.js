/**
 * RedArt LLC - HCPF Automation Server
 *
 * Entry point Railway runs. Exposes an endpoint that kicks off
 * submitClaim.js against the HCPF portal. submitClaim.js stops before
 * clicking the final Submit button on purpose - a human always reviews
 * and submits manually.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { run } = require('./submitClaim');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'redart-hcpf-automation' });
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

// === ADDED === Per-account mutex around real HCPF portal sessions.
// The portal itself force-logs-out ALL sessions on an account when it
// detects concurrent logins ("A security access violation has been
// detected..."). This queues portal-touching work so only one browser
// session per account is ever open at a time, regardless of which
// endpoint (submit-claim, verify-member, future ones) triggered it.
const portalLocks = new Map(); // accountKey -> Promise chain tail

function portalAccountKey(providerId, companyId) {
  return `${providerId || 'unknown-provider'}::${companyId || 'default'}`;
}

async function withPortalSession(accountKey, fn) {
  const previous = portalLocks.get(accountKey) || Promise.resolve();

  let releaseNext;
  const thisJob = new Promise(resolve => { releaseNext = resolve; });
  portalLocks.set(accountKey, previous.then(() => thisJob).catch(() => thisJob));

  // Wait our turn (any prior job on this account finishing, success or fail)
  await previous.catch(() => {});

  const SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Portal session safety timeout after ${SAFETY_TIMEOUT_MS / 1000}s - releasing lock so the queue can proceed.`));
    }, SAFETY_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timeoutHandle);
    releaseNext(); // let the next queued job proceed
    if (portalLocks.get(accountKey) === thisJob) {
      portalLocks.delete(accountKey); // cleanup if nobody queued after us
    }
  }
}

function portalQueueLength(accountKey) {
  // Best-effort: we don't track exact queue depth per key, this is a
  // simple presence check for the "queued: true" response hint.
  return portalLocks.has(accountKey) ? 1 : 0;
}

app.post('/submit-claim', async (req, res) => {
  const tripRecord = req.body;
  if (!tripRecord || !tripRecord.id) {
    return res.status(400).json({ error: 'Missing trip record or trip id in request body' });
  }

  const jobId = `${tripRecord.id}-${Date.now()}`;
  const accountKey = portalAccountKey(tripRecord.provider_id, tripRecord.company_id);
  const queued = portalQueueLength(accountKey) > 0;
  jobs[jobId] = { status: 'running', queued, result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, queued, checkStatusAt: `/job-status/${jobId}` });

  const timeoutMs = 8 * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs / 1000}s.`)), timeoutMs)
  );

  // === CHANGED === portal work now runs inside withPortalSession, so it
  // waits its turn if another job (submit-claim OR verify-member) is
  // currently logged into the same HCPF account. Job creation/response
  // above is unchanged - still responds immediately with a jobId.
  Promise.race([
    withPortalSession(accountKey, () => run(tripRecord)),
    timeoutPromise
  ])
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RedArt HCPF automation server running on port ${PORT}`);
});
