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

const jobs = {};

app.post('/submit-claim', async (req, res) => {
  const tripRecord = req.body;
  if (!tripRecord || !tripRecord.id) {
    return res.status(400).json({ error: 'Missing trip record or trip id in request body' });
  }

  const jobId = `${tripRecord.id}-${Date.now()}`;
  jobs[jobId] = { status: 'running', result: null, startedAt: new Date().toISOString() };
  res.json({ status: 'started', jobId, checkStatusAt: `/job-status/${jobId}` });

  const timeoutMs = 8 * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs / 1000}s.`)), timeoutMs)
  );

  Promise.race([run(tripRecord), timeoutPromise])
    .then(result => {
      jobs[jobId] = { status: 'done', result, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    })
    .catch(err => {
      console.error('Error running claim submission:', err);
      jobs[jobId] = { status: 'error', result: { error: err.message }, startedAt: jobs[jobId].startedAt, finishedAt: new Date().toISOString() };
    });
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
