/**
 * RedArt LLC - HCPF Colorado Medicaid Claim Submission Robot
 *
 * Config-driven: this same script can run against any portal config
 * (config/hcpf-colorado.json today, other state portals later) by
 * swapping the config file passed in.
 */

const { chromium } = require('playwright');
const fs = require('fs');

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

async function fetchBillingRate(providerId, vehicleType, unitType) {
  const baseUrl = process.env.BILLING_API_URL;
  const apiKey = process.env.BILLING_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error('BILLING_API_URL / BILLING_API_KEY env vars are not set.');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/public/get-billing-rate` +
    `?provider_id=${encodeURIComponent(providerId)}` +
    `&vehicle_type=${encodeURIComponent(vehicleType)}` +
    `&unit_type=${encodeURIComponent(unitType)}`;

  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `Billing rate lookup failed (${res.status}) for provider=${providerId} ` +
      `vehicle_type=${vehicleType} unit_type=${unitType}: ${body.error || 'unknown error'}`
    );
  }

  return body;
}

async function fetchBillingRates(providerId, vehicleType) {
  const [baseRate, mileageRate] = await Promise.all([
    fetchBillingRate(providerId, vehicleType, 'trip'),
    fetchBillingRate(providerId, vehicleType, 'mile')
  ]);
  return { baseRate, mileageRate };
}

function mapTripToClaim(tripRecord) {
  const claim = {
    providerId: tripRecord.provider_id || null,
    vehicleType: tripRecord.vehicle_type || 'ambulatory',
    memberId: tripRecord.medicaid_member_id || null,
    patientNumber: tripRecord.trip_id || tripRecord.id,
    tripDate: tripRecord.trip_date,
    diagnosisCode: tripRecord.diagnosis_code || null,
    hasSignatureOnFile: Boolean(tripRecord.passenger_signature_url || tripRecord.signature_captured),
    isRoundTrip: tripRecord.trip_type === 'round_trip' || tripRecord.is_round_trip === true,
    pickupOdometer: tripRecord.pickup_odometer || null,
    dropoffOdometer: tripRecord.dropoff_odometer || null,
    tripReportFilePath: tripRecord.trip_report_pdf_path || null
  };

  if (!claim.providerId) {
    return { status: 'BLOCKED_MISSING_PROVIDER_ID', reason: 'No provider_id on this trip.', claim };
  }
  if (!claim.memberId) {
    return {
      status: 'BLOCKED_PENDING_ELIGIBILITY_LOOKUP',
      reason: 'No Medicaid Member ID on file for this passenger.',
      claim
    };
  }
  if (!claim.diagnosisCode) {
    return { status: 'BLOCKED_MISSING_DIAGNOSIS_CODE', reason: 'No diagnosis code attached to trip.', claim };
  }

  return { status: 'READY', claim };
}

async function submitProfessionalClaim(page, config, claim, rates) {
  const sel = config.selectors.step1_claimHeader;

  await page.click(config.selectors.navigation.claimsMenuLink);
  await page.click(config.selectors.navigation.submitClaimProfLink);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const payerValue = await page.$eval(sel.payerDropdown, el => el.value).catch(() => null);
  if (payerValue !== null) {
    await page.selectOption(sel.payerDropdown, { label: sel.payerValue });
  }

  await page.fill(sel.memberIdField, claim.memberId);
  await page.locator(sel.memberIdField).blur();
  await page.waitForTimeout(1500);

  await page.fill(sel.patientNumberField, String(claim.patientNumber));

  await page.selectOption(sel.dateTypeDropdown, { label: sel.dateTypeValue }).catch(() => {});
  if (claim.tripDate) {
    await page.fill(sel.dateOfCurrentField, claim.tripDate).catch(() => {});
  }

  await page.check(sel.transportCertNoRadio);
  if (!(await page.isChecked(sel.transportCertNoRadio))) {
    throw new Error('Transport Certification No radio did not register.');
  }

  if (claim.hasSignatureOnFile) {
    await page.check(sel.signatureOnFileYesRadio);
  } else {
    await page.check(sel.signatureOnFileNoRadio);
  }

  if (!(await page.isChecked(sel.transportCertNoRadio))) {
    await page.check(sel.transportCertNoRadio);
  }
  const sigOk = claim.hasSignatureOnFile
    ? await page.isChecked(sel.signatureOnFileYesRadio)
    : await page.isChecked(sel.signatureOnFileNoRadio);
  if (!sigOk) {
    await page.check(claim.hasSignatureOnFile ? sel.signatureOnFileYesRadio : sel.signatureOnFileNoRadio);
  }

  await page.click(sel.continueButton);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const stillOnStep1 = await page.locator('text=Submit Professional Claim: Step 1').isVisible().catch(() => false);
  if (stillOnStep1) {
    const pageText = await page.locator('body').innerText().catch(() => '');
    const errorLines = pageText.split('\n').filter(l => /required|invalid|error|please|must/i.test(l)).slice(0, 15).join(' | ');
    throw new Error(`Still on Step 1 after clicking Continue. Errors: ${errorLines || '(none found)'}`);
  }

  const sel2 = config.selectors.step2_diagnosisAndServiceLines;
  await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
  await page.fill(sel2.diagnosisCodeField, claim.diagnosisCode);
  await page.waitForTimeout(500);
  const suggestion = page.locator(`text=${claim.diagnosisCode}`).first();
  if (await suggestion.isVisible().catch(() => false)) {
    await suggestion.click();
  }
  await page.locator(sel2.diagnosisCodeAddButton).last().click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  await page.click(sel2.step2ContinueButton);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const sel3 = config.selectors.step3_serviceDetails;

  // Step 3's field ID suffixes increment with every postback (not per
  // logical row), so selectors are partial-match in config and we always
  // grab the LAST matching element - that's always the currently active,
  // editable row.
  function current(selector) {
    return page.locator(selector).last();
  }

  // Date and money/quantity fields use ASP.NET AJAX Control Toolkit's
  // MaskedEditExtender, which intercepts real key events. Programmatic
  // .fill() gets silently rejected or garbled - real keystrokes required.
  async function fillMaskedField(selector, text) {
    const field = current(selector);
    await field.click({ clickCount: 3, timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await field.pressSequentially(text, { delay: 60 }).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(400);
  }

  // Money/quantity masks RESET when they see a literal "." keystroke,
  // discarding everything typed before it (confirmed: typing "12.15"
  // produced "15.00" - only digits after the "." survived). Fix: type
  // raw digits only (no decimal point) matching the field's own decimal
  // precision, and let the mask auto-position the decimal itself -
  // exactly like a calculator/ATM display.
  async function fillMaskedNumberWithRetry(selector, decimalValue, decimalPlaces, maxAttempts = 5) {
    const rawDigits = Math.round(Number(decimalValue) * Math.pow(10, decimalPlaces)).toString();
    const target = Number(decimalValue);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await fillMaskedField(selector, rawDigits);
      await page.waitForTimeout(300 + attempt * 400);
      const val = await current(selector).inputValue({ timeout: 5000 }).catch(() => '');
      const cleaned = val.replace(/[$,\s_]/g, '');
      const parsed = parseFloat(cleaned);
      if (cleaned !== '' && !isNaN(parsed) && Math.abs(parsed - target) < 0.001) {
        return { success: true, finalValue: val, attempts: attempt + 1 };
      }
    }
    const finalValue = await current(selector).inputValue().catch(() => 'UNREADABLE');
    return { success: false, finalValue, attempts: maxAttempts };
  }

  // Procedure Code has an autocomplete suggestion list, same pattern as
  // Diagnosis Code in Step 2 - type it, then click the matching suggestion
  // so the hidden companion field (what actually gets submitted) populates.
  async function fillProcedureCode(code) {
    const field = current(sel3.procedureCodeField);
    await field.click({ timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await field.pressSequentially(code, { delay: 70 }).catch(() => {});
    await page.waitForTimeout(700);
    const suggestion = page.locator(`text=${code}`).first();
    if (await suggestion.isVisible().catch(() => false)) {
      await suggestion.click().catch(() => {});
    } else {
      await page.keyboard.press('Tab').catch(() => {});
    }
    await page.waitForTimeout(400);
  }

  async function fillServiceLine(procedureCode, chargeAmount, units) {
    await fillMaskedField(sel3.fromDateField, claim.tripDate.replace(/\D/g, ''));
    await fillMaskedField(sel3.toDateField, claim.tripDate.replace(/\D/g, ''));

    await page.selectOption(current(sel3.placeOfServiceDropdown), { label: sel3.placeOfServiceValue }, { timeout: 8000 }).catch(err => {
      console.log(`Place of Service select failed: ${err.message}`);
    });

    await fillProcedureCode(procedureCode);

    await page.selectOption(current(sel3.unitTypeDropdown), { label: sel3.unitTypeValue }, { timeout: 8000 }).catch(err => {
      console.log(`Unit Type select failed: ${err.message}`);
    });
    await page.selectOption(current(sel3.diagnosisPointer1Dropdown), { label: sel3.diagnosisPointerValue }, { timeout: 8000 }).catch(err => {
      console.log(`Diagnosis Pointer select failed: ${err.message}`);
    });

    const chargeResult = await fillMaskedNumberWithRetry(sel3.chargeAmountField, chargeAmount, 2);
    if (!chargeResult.success) {
      throw new Error(`Charge Amount would not accept value "${chargeAmount}" after ${chargeResult.attempts} attempts - field shows "${chargeResult.finalValue}".`);
    }

    const unitsResult = await fillMaskedNumberWithRetry(sel3.unitsField, units, 3);
    if (!unitsResult.success) {
      throw new Error(`Units would not accept value "${units}" after ${unitsResult.attempts} attempts - field shows "${unitsResult.finalValue}".`);
    }

    await current(sel3.addServiceLineButton).click({ timeout: 8000 }).catch(err => {
      console.log(`Add service line click failed (non-fatal): ${err.message}`);
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  const baseUnits = claim.isRoundTrip ? 2 : 1;
  const baseCharge = (rates.baseRate.charge_amount * baseUnits).toFixed(2);
  await fillServiceLine(rates.baseRate.procedure_code, baseCharge, baseUnits);

  const loadedMiles = claim.dropoffOdometer && claim.pickupOdometer
    ? claim.dropoffOdometer - claim.pickupOdometer
    : null;

  if (loadedMiles) {
    const mileageCharge = (rates.mileageRate.charge_amount * loadedMiles).toFixed(2);
    await fillServiceLine(rates.mileageRate.procedure_code, mileageCharge, loadedMiles);
  }

  if (claim.tripReportFilePath) {
    await page.locator('input[type="file"]').last().setInputFiles(claim.tripReportFilePath).catch(() => {
      console.log('Attachment upload failed - selector may need adjustment.');
    });
  }

  console.log('Form fully filled through Step 3. STOPPING before Submit - review required.');
  return {
    status: 'READY_FOR_HUMAN_REVIEW',
    message: 'Claim form is fully filled, including Charge Amount and Units, using live billing rates. Submit was intentionally NOT clicked. A human must review and click Submit manually.'
  };
}

async function run(tripRecord) {
  const config = loadConfig(`${__dirname}/../config/hcpf-colorado.json`);
  const mapped = mapTripToClaim(tripRecord);

  if (mapped.status !== 'READY') {
    console.log(`Trip ${tripRecord.id} not submittable: ${mapped.status} - ${mapped.reason}`);
    return mapped;
  }

  let rates;
  try {
    rates = await fetchBillingRates(mapped.claim.providerId, mapped.claim.vehicleType);
  } catch (err) {
    console.log(`Trip ${tripRecord.id} blocked: could not fetch billing rates - ${err.message}`);
    return {
      status: 'BLOCKED_MISSING_BILLING_RATES',
      reason: `Provider has not configured billing rates for vehicle_type "${mapped.claim.vehicleType}": ${err.message}`,
      claim: mapped.claim
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const INTERNAL_TIMEOUT_MS = 6 * 60 * 1000;
  const internalTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Internal timeout after ${INTERNAL_TIMEOUT_MS / 1000}s - aborting and closing browser.`)), INTERNAL_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([
      (async () => {
        await page.goto(config.loginUrl || config.baseUrl);
        await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
        await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
        await page.click(config.selectors.login.submitButton);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

        const claimResult = await submitProfessionalClaim(page, config, mapped.claim, rates);
        await page.screenshot({ path: `${__dirname}/../last-run-success.png`, fullPage: true }).catch(() => {});
        return claimResult;
      })(),
      internalTimeout
    ]);
    return result;
  } catch (err) {
    await page.screenshot({ path: `${__dirname}/../last-run-error.png`, fullPage: true }).catch(() => {});
    console.log(`Run failed: ${err.message}`);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { run, mapTripToClaim, fetchBillingRate, fetchBillingRates };
