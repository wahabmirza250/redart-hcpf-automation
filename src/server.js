/**
 * RedArt LLC - HCPF Automation Server
 *
 * This is the entry point Railway runs. It exposes one endpoint that
 * Supabase (or you, manually) can call with a trip record, and it
 * kicks off submitClaim.js against the HCPF portal.
 *
 * IMPORTANT: submitClaim.js stops before clicking the final Submit
 * button on purpose - see src/submitClaim.js for why. This server
 * does not change that behavior.
 */

const express = require('express');
const path = require('path');
const { run } = require('./submitClaim');

const app = express();
app.use(express.json());

// Simple health check - visit this URL to confirm the service is alive
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'redart-hcpf-automation' });
});

// View the screenshot from the most recent run (success or error) -
// since Railway has no display, this is how you check what the robot saw.
app.get('/last-run-screenshot', (req, res) => {
  const successPath = path.join(__dirname, '../last-run-success.png');
  const errorPath = path.join(__dirname, '../last-run-error.png');
  const fs = require('fs');
  if (fs.existsSync(errorPath)) {
    return res.sendFile(errorPath);
  }
  if (fs.existsSync(successPath)) {
    return res.sendFile(successPath);
  }
  res.status(404).json({ error: 'No screenshot yet - run /submit-claim first' });
});

// TEMPORARY DEBUG ENDPOINT - dumps all required-field IDs/labels on the
// Step 1 claim form so we can find selectors that are missing from config.
// Remove this once the robot is fully working.
app.get('/debug-step1-fields', async (req, res) => {
  const { chromium } = require('playwright');
  const fs = require('fs');
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

    if (req.query.member_id) {
      await page.fill(config.selectors.step1_claimHeader.memberIdField, req.query.member_id);
      await page.locator(config.selectors.step1_claimHeader.memberIdField).blur();
      await page.waitForTimeout(1500);
    }

    if (req.query.check_transport_yes === '1') {
      await page.check(config.selectors.step1_claimHeader.transportCertYesRadio).catch(() => {});
      await page.check(config.selectors.step1_claimHeader.certConditionYesRadio).catch(() => {});
      await page.waitForTimeout(1000);
    }

    const fields = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input, select').forEach(el => {
        const row = el.closest('tr') || el.closest('div') || el.parentElement;
        const label = row ? row.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
        const entry = {
          tag: el.tagName,
          type: el.type || null,
          id: el.id || null,
          name: el.name || null,
          visible: el.offsetParent !== null,
          nearbyText: label
        };
        if (el.tagName === 'SELECT') {
          entry.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text }));
        }
        results.push(entry);
      });
      return results;
    });

    const filterTerm = req.query.filter;
    const filtered = filterTerm
      ? fields.filter(f => (f.id || '').toLowerCase().includes(filterTerm.toLowerCase()))
      : fields;

    res.json({ fieldCount: filtered.length, fields: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

// TEMPORARY DEBUG ENDPOINT - reaches Step 2 (diagnosis codes) and dumps
// all button-like elements with their real IDs, so we can replace the
// too-generic "text=Add" selector that's matching the wrong element.
app.get('/debug-step2-buttons', async (req, res) => {
  const { chromium } = require('playwright');
  const fs = require('fs');
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
    await page.fill(sel.memberIdField, req.query.member_id || 'M964077');
    await page.locator(sel.memberIdField).blur();
    await page.waitForTimeout(1500);
    await page.fill(sel.patientNumberField, 'debug-test');
    await page.selectOption(sel.dateTypeDropdown, { label: sel.dateTypeValue }).catch(() => {});
    await page.fill(sel.dateOfCurrentField, req.query.trip_date || '07/01/2026').catch(() => {});
    await page.check(sel.transportCertNoRadio);
    await page.check(sel.signatureOnFileYesRadio);
    await page.click(sel.continueButton);
    await page.waitForLoadState('networkidle');

    const buttons = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input[type="button"], input[type="submit"], input[type="image"], button, a').forEach(el => {
        const text = (el.value || el.textContent || el.title || el.alt || '').trim();
        if (text.toLowerCase().includes('add') || text.toLowerCase().includes('reset')) {
          results.push({
            tag: el.tagName,
            type: el.type || null,
            id: el.id || null,
            text,
            visible: el.offsetParent !== null
          });
        }
      });
      return results;
    });

    res.json({ buttons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

// Main endpoint - POST a trip record here to run the robot against it
app.post('/submit-claim', async (req, res) => {
  const tripRecord = req.body;

  if (!tripRecord || !tripRecord.id) {
    return res.status(400).json({ error: 'Missing trip record or trip id in request body' });
  }

  try {
    const result = await run(tripRecord);
    res.json(result);
  } catch (err) {
    console.error('Error running claim submission:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RedArt HCPF automation server running on port ${PORT}`);
});
