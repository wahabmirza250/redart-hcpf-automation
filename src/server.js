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

app.get('/debug-step3-fields', async (req, res) => {
  const { chromium } = require('playwright');
  const config = JSON.parse(fs.readFileSync(`${__dirname}/../config/hcpf-colorado.json`, 'utf-8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle');
    await page.click(config.selectors.navigation.claimsMenuLink);
    await page.click(config.selectors.navigation.submitClaimProfLink);
    await page.waitForLoadState('networkidle');

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
    await page.waitForLoadState('networkidle');

    const sel2 = config.selectors.step2_diagnosisAndServiceLines;
    const diagCode = req.query.diagnosis_code || 'R688';
    await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
    await page.fill(sel2.diagnosisCodeField, diagCode);
    await page.waitForTimeout(500);
    const suggestion = page.locator(`text=${diagCode}`).first();
    if (await suggestion.isVisible().catch(() => false)) await suggestion.click();
    await page.click(sel2.diagnosisCodeAddButton);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click(sel2.step2ContinueButton);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const fields = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input, select').forEach(el => {
        const row = el.closest('tr') || el.closest('div') || el.parentElement;
        const entry = {
          tag: el.tagName, type: el.type || null, id: el.id || null, name: el.name || null,
          visible: el.offsetParent !== null,
          nearbyText: row ? row.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
        };
        if (el.tagName === 'SELECT') entry.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text }));
        if (el.id && el.id.includes('MaskExtender')) entry.maskValue = el.value;
        results.push(entry);
      });
      document.querySelectorAll('a, button').forEach(el => {
        const text = (el.textContent || '').trim();
        if (text) {
          results.push({ tag: el.tagName, type: 'link-or-button', id: el.id || null, name: null, visible: el.offsetParent !== null, nearbyText: text });
        }
      });
      return results;
    });

    const filterTerm = req.query.filter;
    const filtered = filterTerm ? fields.filter(f => (f.id || '').toLowerCase().includes(filterTerm.toLowerCase())) : fields;

    res.json({ fieldCount: filtered.length, fields: filtered, currentUrl: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.get('/debug-mask-config', async (req, res) => {
  const { chromium } = require('playwright');
  const config = JSON.parse(fs.readFileSync(`${__dirname}/../config/hcpf-colorado.json`, 'utf-8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle');
    await page.click(config.selectors.navigation.claimsMenuLink);
    await page.click(config.selectors.navigation.submitClaimProfLink);
    await page.waitForLoadState('networkidle');

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
    await page.waitForLoadState('networkidle');

    const sel2 = config.selectors.step2_diagnosisAndServiceLines;
    const diagCode = req.query.diagnosis_code || 'R688';
    await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
    await page.fill(sel2.diagnosisCodeField, diagCode);
    await page.waitForTimeout(500);
    const suggestion = page.locator(`text=${diagCode}`).first();
    if (await suggestion.isVisible().catch(() => false)) await suggestion.click();
    await page.click(sel2.diagnosisCodeAddButton);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click(sel2.step2ContinueButton);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const html = await page.content();
    const relevantChunks = [];
    const lines = html.split('\n');
    lines.forEach(line => {
      if ((line.includes('ChargeAmount') || line.includes('ToDate')) &&
          (line.includes('Mask') || line.includes('mask'))) {
        relevantChunks.push(line.trim().slice(0, 2000));
      }
    });

    const scriptBlocks = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      return scripts
        .map(s => s.textContent)
        .filter(t => t && (t.includes('ChargeAmount') || t.includes('ToDate')))
        .map(t => t.slice(0, 3000));
    });

    res.json({ relevantChunks, scriptBlocks, currentUrl: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.get('/debug-test-add-click', async (req, res) => {
  const { chromium } = require('playwright');
  const config = JSON.parse(fs.readFileSync(`${__dirname}/../config/hcpf-colorado.json`, 'utf-8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle');
    await page.click(config.selectors.navigation.claimsMenuLink);
    await page.click(config.selectors.navigation.submitClaimProfLink);
    await page.waitForLoadState('networkidle');

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
    await page.waitForLoadState('networkidle');

    const sel2 = config.selectors.step2_diagnosisAndServiceLines;
    const diagCode = req.query.diagnosis_code || 'R688';
    await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
    await page.fill(sel2.diagnosisCodeField, diagCode);
    await page.waitForTimeout(500);
    const suggestion = page.locator(`text=${diagCode}`).first();
    if (await suggestion.isVisible().catch(() => false)) await suggestion.click();
    await page.click(sel2.diagnosisCodeAddButton);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.click(sel2.step2ContinueButton);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const sel3 = config.selectors.step3_serviceDetails;

    const addButtonExists = await page.locator(sel3.addServiceLineButton).count();

    await page.locator(sel3.fromDateField).click().catch(() => {});
    await page.keyboard.press('Home').catch(() => {});
    await page.keyboard.type('07012026', { delay: 50 }).catch(() => {});
    await page.locator(sel3.toDateField).click().catch(() => {});
    await page.keyboard.press('Home').catch(() => {});
    await page.keyboard.type('07012026', { delay: 50 }).catch(() => {});
    await page.selectOption(sel3.placeOfServiceDropdown, { label: sel3.placeOfServiceValue }).catch(() => {});
    await page.fill(sel3.procedureCodeField, 'A0100').catch(() => {});
    await page.locator(sel3.chargeAmountField).click().catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    await page.keyboard.type('2500', { delay: 70 }).catch(() => {});
    await page.fill(sel3.unitsField, '1').catch(() => {});
    await page.selectOption(sel3.unitTypeDropdown, { label: sel3.unitTypeValue }).catch(() => {});
    await page.selectOption(sel3.diagnosisPointer1Dropdown, { label: sel3.diagnosisPointerValue }).catch(() => {});

    const beforeClickValues = {
      fromDate: await page.inputValue(sel3.fromDateField).catch(() => 'ERROR'),
      toDate: await page.inputValue(sel3.toDateField).catch(() => 'ERROR'),
      chargeAmount: await page.inputValue(sel3.chargeAmountField).catch(() => 'ERROR')
    };

    let clickError = null;
    try {
      await page.locator(sel3.addServiceLineButton).click({ timeout: 8000 });
    } catch (err) {
      clickError = err.message;
    }
    await page.waitForTimeout(1500);

    const afterClickState = await page.evaluate(() => {
      const tableRows = Array.from(document.querySelectorAll('table tr')).map(tr => tr.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 300);
      return { tableRowsSample: tableRows.slice(0, 40) };
    });

    const afterClickValues = {
      fromDate: await page.inputValue(sel3.fromDateField).catch(() => 'FIELD_NOT_FOUND'),
      toDate: await page.inputValue(sel3.toDateField).catch(() => 'FIELD_NOT_FOUND'),
      chargeAmount: await page.inputValue(sel3.chargeAmountField).catch(() => 'FIELD_NOT_FOUND')
    };

    res.json({
      addButtonExists,
      addButtonSelector: sel3.addServiceLineButton,
      beforeClickValues,
      clickError,
      afterClickValues,
      afterClickState,
      currentUrl: page.url()
    });
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

  const timeoutMs = 5 * 60 * 1000;
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
