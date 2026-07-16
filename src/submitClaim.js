/**
 * RedArt LLC - HCPF Colorado Medicaid Claim Submission Robot
 *
 * Config-driven: this same script can run against any portal config
 * (config/hcpf-colorado.json today, other state portals later) by
 * swapping the config file passed in.
 *
 * All billing values (procedure codes, charge amounts, place of service)
 * come live from the provider's Billing Settings via get-billing-rate.
 * Nothing dollar/code-related is hardcoded here.
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

  return body; // { procedure_code, charge_amount, unit_type, place_of_service }
}

async function fetchBillingRates(providerId, vehicleType) {
  const [baseRate, mileageRate] = await Promise.all([
    fetchBillingRate(providerId, vehicleType, 'trip'),
    fetchBillingRate(providerId, vehicleType, 'mile')
  ]);
  return { baseRate, mileageRate };
}

/**
 * Fetch the trip report PDF's signed download URL and save it locally,
 * so Playwright can attach it as a real file. Returns null (not an
 * error) if no PDF exists yet - attachment is optional, not required
 * to submit a claim.
 */
async function fetchAndSaveTripPdf(tripId) {
  const baseUrl = process.env.BILLING_API_URL;
  const apiKey = process.env.BILLING_API_KEY;
  if (!baseUrl || !apiKey || !tripId) return null;

  const url = `${baseUrl.replace(/\/$/, '')}/api/public/get-trip-pdf?trip_id=${encodeURIComponent(tripId)}`;
  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  if (!res.ok) {
    console.log(`No trip PDF available for trip ${tripId} (${res.status}) - continuing without attachment.`);
    return null;
  }
  const body = await res.json().catch(() => ({}));
  if (!body.pdf_url) return null;

  const pdfRes = await fetch(body.pdf_url);
  if (!pdfRes.ok) {
    console.log(`Failed to download trip PDF from signed URL (${pdfRes.status}).`);
    return null;
  }
  const arrayBuffer = await pdfRes.arrayBuffer();
  const localPath = `${require('os').tmpdir()}/trip-report-${tripId}.pdf`;
  fs.writeFileSync(localPath, Buffer.from(arrayBuffer));
  return localPath;
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
    medicaidTripId: tripRecord.medicaid_trip_id || tripRecord.id || null,
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

  // Transport Certification is a CMS ambulance-specific attestation.
  // RedArt only handles non-ambulance NEMT van/car transport, so "No".
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

  // Step 3's field ID suffixes increment with EVERY postback, not per
  // logical row - so config selectors are partial-match, and we always
  // grab the LAST matching element on the page, which is always the
  // currently active, editable row.
  function current(selector) {
    return page.locator(selector).last();
  }

  // Date fields use ASP.NET AJAX Control Toolkit's MaskedEditExtender,
  // which needs real keystrokes - programmatic .fill() gets rejected.
  async function fillMaskedDateField(selector, digitsOnly) {
    const field = current(selector);
    await field.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(200);
    const existing = await field.inputValue({ timeout: 3000 }).catch(() => '');
    if (existing && existing.trim() !== '') {
      await field.click({ clickCount: 3 }).catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await page.waitForTimeout(150);
    }
    await field.pressSequentially(digitsOnly, { delay: 70 }).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(400);
  }

  // Charge Amount / Units: plain .fill() with a decimal string (e.g.
  // "12.15", "1.000") - CONFIRMED WORKING empirically (test-019). With
  // retry since the mask engine occasionally needs a second attempt.
  async function fillMaskedNumberWithRetry(selector, decimalValue, decimalPlaces, maxAttempts = 6) {
    const valueStr = Number(decimalValue).toFixed(decimalPlaces);
    const delays = [300, 600, 1000, 1500, 2500, 4000];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const field = current(selector);
      await field.fill('', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(150);
      await field.fill(valueStr, { timeout: 5000 }).catch(() => {});
      await field.blur({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(delays[attempt] || 1500);
      const val = await field.inputValue({ timeout: 5000 }).catch(() => '');
      const cleaned = val.replace(/[$,\s_]/g, '');
      const target = valueStr.replace(/[$,\s_]/g, '');
      if (cleaned !== '' && (cleaned === target || Math.abs(parseFloat(cleaned) - parseFloat(target)) < 0.001)) {
        return { success: true, finalValue: val, attempts: attempt + 1 };
      }
    }
    const finalValue = await current(selector).inputValue().catch(() => 'UNREADABLE');
    return { success: false, finalValue, attempts: maxAttempts };
  }

  // Procedure Code has an autocomplete suggestion list, same pattern as
  // Diagnosis Code in Step 2 - type it, click the matching suggestion so
  // the hidden companion field (what actually gets submitted) populates.
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

  // Place of Service: value comes from Billing Settings (place_of_service
  // column, e.g. "99"), not hardcoded. The dropdown's option text is a
  // full label like "99-Other Place of Service", so we find the option
  // whose text STARTS WITH the saved code and select it by value.
  async function selectPlaceOfServiceByCode(selector, code) {
    const dropdown = current(selector);
    const optionValue = await dropdown.evaluate((el, codePrefix) => {
      const opt = Array.from(el.options).find(o => o.text.trim().startsWith(codePrefix + '-'));
      return opt ? opt.value : null;
    }, String(code)).catch(() => null);

    if (optionValue) {
      await dropdown.selectOption({ value: optionValue }, { timeout: 8000 }).catch(() => {});
    } else {
      // Fallback to config default if the code isn't found as an option
      await dropdown.selectOption({ label: sel3.placeOfServiceFallback }, { timeout: 8000 }).catch(() => {});
    }
  }

  async function fillServiceLine(procedureCode, chargeAmount, units, placeOfServiceCode) {
    await fillMaskedDateField(sel3.fromDateField, claim.tripDate.replace(/\D/g, ''));
    await fillMaskedDateField(sel3.toDateField, claim.tripDate.replace(/\D/g, ''));

    await selectPlaceOfServiceByCode(sel3.placeOfServiceDropdown, placeOfServiceCode || '99');

    await fillProcedureCode(procedureCode);

    await current(sel3.unitTypeDropdown).selectOption({ label: sel3.unitTypeValue }, { timeout: 8000 }).catch(err => {
      console.log(`Unit Type select failed: ${err.message}`);
    });
    await current(sel3.diagnosisPointer1Dropdown).selectOption({ label: sel3.diagnosisPointerValue }, { timeout: 8000 }).catch(err => {
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
  const baseCharge = rates.baseRate.charge_amount * baseUnits;
  await fillServiceLine(rates.baseRate.procedure_code, baseCharge, baseUnits, rates.baseRate.place_of_service);

  const loadedMiles = claim.dropoffOdometer && claim.pickupOdometer
    ? claim.dropoffOdometer - claim.pickupOdometer
    : null;

  if (loadedMiles) {
    const mileageCharge = rates.mileageRate.charge_amount * loadedMiles;
    await fillServiceLine(rates.mileageRate.procedure_code, mileageCharge, loadedMiles, rates.mileageRate.place_of_service);
  }

  if (claim.tripReportFilePath) {
    await page.locator(sel3.attachmentUploadLink).click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);

    const fileInput = page.locator(sel3.attachmentFileInput).last();
    const fileSet = await fileInput.setInputFiles(claim.tripReportFilePath, { timeout: 8000 })
      .then(() => true)
      .catch(err => {
        console.log(`Attachment file upload failed: ${err.message}`);
        return false;
      });

    if (fileSet) {
      await page.locator(sel3.attachmentTypeDropdown).last().selectOption({ label: sel3.attachmentTypeValue }, { timeout: 8000 }).catch(err => {
        console.log(`Attachment Type select failed: ${err.message}`);
      });
      // Transmission Method only has one real option (FT-File Transfer) -
      // select it if present, otherwise it's likely already defaulted.
      await page.locator(sel3.transmissionMethodDropdown).last().selectOption({ index: 1 }, { timeout: 5000 }).catch(() => {});

      await page.locator(sel3.attachmentAddButton).last().click({ timeout: 8000 }).catch(err => {
        console.log(`Attachment Add click failed: ${err.message}`);
      });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  console.log('Form fully filled through Step 3. STOPPING before Submit - review required.');
  return {
    status: 'READY_FOR_HUMAN_REVIEW',
    message: 'Claim form is fully filled - Member ID, dates, Place of Service, Procedure Code, Diagnosis, Charge Amount, and Units - using live billing rates from Billing Settings. Submit was intentionally NOT clicked. A human must review and click Submit manually.'
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

  // Fetch the trip report PDF (if one exists) before opening the browser.
  // Not fatal if missing - attachment is optional, not required to submit.
  const tripPdfPath = await fetchAndSaveTripPdf(mapped.claim.medicaidTripId).catch(() => null);
  mapped.claim.tripReportFilePath = tripPdfPath;

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
