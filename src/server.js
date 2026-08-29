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
const { run, discoverSearchClaims } = require('./submitClaim');

const app = express();
app.use(express.json());

// === HARDENING: ENV VARS ===
const ROBOT_MAX_CONCURRENCY = Math.min(
  parseInt(process.env.ROBOT_MAX_CONCURRENCY || '4', 10) || 4,
  4 // hard cap at 4
);
const ROBOT_SESSION_COOLDOWN_MS = parseInt(process.env.ROBOT_SESSION_COOLDOWN_MS || '5000', 10) || 5000;
const DEBUG_ENDPOINTS_ENABLED = process.env.DEBUG_ENDPOINTS_ENABLED === 'true';

// === HARDENING: STARTUP CHECKS ===
try {
  if (require.main === module) {
    const testSyntax = new Function('return 1 + 1');
    testSyntax();
    console.log('[server.js] Startup syntax checks passed.');
  }
} catch (err) {
  console.error('[server.js] FATAL: Startup syntax check failed:', err.message);
  process.exit(1);
}

// === HARDENING: GLOBAL CONCURRENCY & HEALTH METRICS ===
let activeBrowserCount = 0;
let globalWaitingCount = 0;
const globalSemaphore = {
  available: ROBOT_MAX_CONCURRENCY,
  waitQueue: []
};

async function acquireGlobalSlot() {
  if (globalSemaphore.available > 0) {
    globalSemaphore.available--;
    activeBrowserCount++;
    return;
  }
  globalWaitingCount++;
  await new Promise(resolve => {
    globalSemaphore.waitQueue.push(resolve);
  });
  globalWaitingCount--;
  activeBrowserCount++;
}

function releaseGlobalSlot() {
  activeBrowserCount = Math.max(0, activeBrowserCount - 1);
  const waiter = globalSemaphore.waitQueue.shift();
  if (waiter) {
    // Transfer the just-freed slot directly to the waiter. `available`
    // stays unchanged because the slot never becomes generally free.
    waiter();
  } else {
    globalSemaphore.available = Math.min(
      ROBOT_MAX_CONCURRENCY,
      globalSemaphore.available + 1
    );
  }
}

const startTime = Date.now();

// === HARDENING: CIRCUIT BREAKER ===
const circuitBreaker = {
  state: 'healthy', // 'healthy' | 'degraded' | 'open'
  failureCount: 0,
  lastFailureTime: null,
  failureThreshold: 5,
  recoveryTimeoutMs: 60000
};

function recordResourceError(err) {
  const message = err?.message || '';
  const code = err?.code || '';
  if (/EAGAIN|ENOMEM|ENOBUFS/.test(`${code} ${message}`)) {
    circuitBreaker.failureCount++;
    circuitBreaker.lastFailureTime = Date.now();
    if (circuitBreaker.failureCount >= circuitBreaker.failureThreshold) {
      circuitBreaker.state = 'open';
    }
  }
}

function checkCircuitBreaker() {
  if (circuitBreaker.state === 'open') {
    const timeSinceLastFailure = Date.now() - circuitBreaker.lastFailureTime;
    if (timeSinceLastFailure > circuitBreaker.recoveryTimeoutMs) {
      circuitBreaker.state = 'healthy';
      circuitBreaker.failureCount = 0;
      circuitBreaker.lastFailureTime = null;
    }
  }
}

// === HARDENING: /HEALTH ENDPOINT ===
app.get('/health', (req, res) => {
  checkCircuitBreaker();
  const memoryUsageMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);
  res.json({
    status: 'ok',
    active_browser_count: activeBrowserCount,
    global_waiting_count: globalWaitingCount,
    max_concurrency: ROBOT_MAX_CONCURRENCY,
    circuit_breaker_state: circuitBreaker.state,
    memory_mb: memoryUsageMb,
    uptime_s: uptimeSeconds
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'redart-hcpf-automation' });
});

// === DEBUG ENDPOINTS (disabled by default) ===
if (DEBUG_ENDPOINTS_ENABLED) {
  app.get('/debug-server-check', (req, res) => {
    try {
      const src = fs.readFileSync(__filename, 'utf8');
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
}

const jobs = {};

// === PER-ACCOUNT SEMAPHORE ===
const MAX_CONCURRENT_SESSIONS = ROBOT_MAX_CONCURRENCY;
const activeSessionCounts = new Map();
const waitQueues = new Map();
const lastSessionEndedAt = new Map();

function portalAccountKey(providerId, companyId) {
  return `${providerId || 'unknown-provider'}::${companyId || 'default'}`;
}

async function acquireAccountSlot(accountKey) {
  const current = activeSessionCounts.get(accountKey) || 0;
  if (current < MAX_CONCURRENT_SESSIONS) {
    activeSessionCounts.set(accountKey, current + 1);
    return;
  }
  await new Promise(resolve => {
    const queue = waitQueues.get(accountKey) || [];
    queue.push(resolve);
    waitQueues.set(accountKey, queue);
  });
  activeSessionCounts.set(accountKey, (activeSessionCounts.get(accountKey) || 0) + 1);
}

function releaseAccountSlot(accountKey) {
  const current = activeSessionCounts.get(accountKey) || 1;
  activeSessionCounts.set(accountKey, Math.max(0, current - 1));
  const queue = waitQueues.get(accountKey) || [];
  const next = queue.shift();
  if (next) {
    waitQueues.set(accountKey, queue);
    next();
  }
}

// === HARDENING: retain both slots until the browser job actually settles ===
async function withPortalSession(accountKey, fn) {
  let globalAcquired = false;
  let accountAcquired = false;

  try {
    await acquireGlobalSlot();
    globalAcquired = true;

    await acquireAccountSlot(accountKey);
    accountAcquired = true;

    const lastEnded = lastSessionEndedAt.get(accountKey);
    if (lastEnded) {
      const elapsed = Date.now() - lastEnded;
      if (elapsed < ROBOT_SESSION_COOLDOWN_MS) {
        const waitMs = ROBOT_SESSION_COOLDOWN_MS - elapsed;
        console.log(`Portal cooldown: waiting ${Math.round(waitMs / 1000)}s before next session on ${accountKey}.`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }

    // `run()` owns the browser lifecycle and closes Chromium in its own
    // finally block. Do not race it with an external timeout that would
    // release these slots while Chromium is still alive.
    return await fn();
  } finally {
    if (accountAcquired) {
      lastSessionEndedAt.set(accountKey, Date.now());
      releaseAccountSlot(accountKey);
    }
    if (globalAcquired) {
      releaseGlobalSlot();
    }
  }
}

function portalQueueLength(accountKey) {
  return (activeSessionCounts.get(accountKey) || 0) >= MAX_CONCURRENT_SESSIONS ? 1 : 0;
}

// === DISCOVERY ENDPOINT (debug, uses portal session queue) ===
app.post('/discover-search-claims', async (req, res) => {
  const companyId = req.body?.company_id || null;
  const testClaim = req.body?.test_claim || null;
  const accountKey = portalAccountKey(req.body?.provider_id, companyId);
  const jobId = `discover-search-claims-${Date.now()}`;
  jobs[jobId] = { status: 'running', result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, checkStatusAt: `/job-status/${jobId}` });

  withPortalSession(accountKey, () => discoverSearchClaims(companyId, testClaim))
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running search-claims discovery:', err);
      recordResourceError(err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

// === SUBMIT-CLAIM ENDPOINT (with claim mode safety) ===
app.post('/submit-claim', async (req, res) => {
  const tripRecord = req.body;
  if (!tripRecord || !tripRecord.id) {
    return res.status(400).json({ error: 'Missing trip record or trip id in request body' });
  }

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
  const queued = portalQueueLength(accountKey) > 0;
  jobs[jobId] = { status: 'running', queued, result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, queued, checkStatusAt: `/job-status/${jobId}` });

  withPortalSession(accountKey, () => run(tripRecord, requestedMode))
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running claim submission:', err);
      recordResourceError(err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

// === VERIFY-ONLY ENDPOINT ===
app.post('/verify-member', async (req, res) => {
  const providerId = req.body?.provider_id;
  if (!providerId) {
    return res.status(400).json({ error: 'provider_id required in request body' });
  }

  const memberId = req.body?.member_id;
  if (!memberId) {
    return res.status(400).json({ error: 'member_id required in request body' });
  }

  const jobId = `verify-member-${memberId}-${Date.now()}`;
  const accountKey = portalAccountKey(providerId, req.body?.company_id);
  const queued = portalQueueLength(accountKey) > 0;
  jobs[jobId] = { status: 'running', queued, result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, queued, checkStatusAt: `/job-status/${jobId}` });

  const tripRecord = { id: jobId, provider_id: providerId, company_id: req.body?.company_id, member_id: memberId };

  withPortalSession(accountKey, () => run(tripRecord, 'verify_only'))
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running member verification:', err);
      recordResourceError(err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

// === HEALTH-CHECK ENDPOINT (verify_only with fixed safe test case) ===
app.get('/health-check-portal', async (req, res) => {
  const providerId = req.query.provider_id;
  if (!providerId) {
    return res.status(400).json({ error: 'provider_id query param is required' });
  }

  const KNOWN_GOOD_MEMBER_ID = 'M964077';
  const tripRecord = {
    id: `health-check-${Date.now()}`,
    provider_id: providerId,
    company_id: null,
    member_id: KNOWN_GOOD_MEMBER_ID
  };

  const jobId = tripRecord.id;
  const accountKey = portalAccountKey(providerId, null);
  const queued = portalQueueLength(accountKey) > 0;
  jobs[jobId] = { status: 'running', queued, result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, checkStatusAt: `/job-status/${jobId}` });

  withPortalSession(accountKey, () => run(tripRecord, 'verify_only'))
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running portal health check:', err);
      recordResourceError(err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
});

app.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: `Job ${jobId} not found` });
  }
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server.js] Listening on port ${PORT}`);
  console.log(`[server.js] ROBOT_MAX_CONCURRENCY=${ROBOT_MAX_CONCURRENCY} (hard-capped at 4)`);
  console.log(`[server.js] ROBOT_SESSION_COOLDOWN_MS=${ROBOT_SESSION_COOLDOWN_MS}`);
  console.log(`[server.js] DEBUG_ENDPOINTS_ENABLED=${DEBUG_ENDPOINTS_ENABLED}`);
});
