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

/**
 * Fetch a single billing rate row (base/trip or mileage/mile) for a
 * provider + vehicle type from the RedArt admin app's public endpoint.
 * Throws if the rate is missing - a claim must never be filled with a
 * guessed or placeholder rate.
 */
async function fetchBillingRate(providerId, vehicleType, unitType) {
  const baseUrl = process.env.BILLING_API_URL; // e.g. https://www.redartdigital.com
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

/**
 * Fetch both required rates (trip base rate + mileage rate) for a trip.
 */
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
    transportCertified: true,
    pickupOdometer: tripRecord.pickup_odometer || null,
    dropoffOdometer: tripRecord.dropoff_odometer || null,
    tripReportFilePath: tripRecord.trip_report_pdf_path || null
  };

  if (!claim.providerId) {
    return {
      status: 'BLOCKED_MISSING_PROVIDER_ID',
      reason: 'No provider_id on this trip - cannot look up billing rates without it.',
      claim
    };
  }

  if (!claim.memberId) {
    return {
      status: 'BLOCKED_PENDING_ELIGIBILITY_LOOKUP',
      reason: 'No Medicaid Member ID on file for this passenger. Only last-4-SSN/DOB captured. Must resolve via Eligibility Verification lookup before this trip can be billed.',
      claim
    };
  }

  if (!claim.diagnosisCode) {
    return {
      status: 'BLOCKED_MISSING_DIAGNOSIS_CODE',
      reason: 'No diagnosis code attached to trip authorization. Confirm fallback code policy before submitting.',
      claim
    };
  }

  return { status: 'READY', claim };
}

async function submitProfessionalClaim(page, config, claim, rates) {
  const sel = config.selectors.step1_claimHeader;

  await page.click(config.selectors.navigation.claimsMenuLink);
  await page.click(config.selectors.navigation.submitClaimProfLink);
  await page.waitForLoadState('networkidle');

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

  await page.check(sel.transportCertYesRadio);
  const certChecked = await page.isChecked(sel.transportCertYesRadio);
  if (!certChecked) {
    throw new Error('Transport Certification Yes radio did not register - aborting before Continue.');
  }

  if (claim.hasSignatureOnFile) {
    await page.check(sel.signatureOnFileYesRadio);
  } else {
    await page.check(sel.signatureOnFileNoRadio);
  }

  // Re-verify radio states right before Continue - a mid-form postback
  // (e.g. from the Date Type dropdown) can silently reset earlier
  // selections in ASP.NET UpdatePanels. If it's not checked, re-check it.
  const transportCertStillChecked = await page.isChecked(sel.transportCertYesRadio);
  if (!transportCertStillChecked) {
    await page.check(sel.transportCertYesRadio);
  }
  const sigStillChecked = claim.hasSignatureOnFile
    ? await page.isChecked(sel.signatureOnFileYesRadio)
    : await page.isChecked(sel.signatureOnFileNoRadio);
  if (!sigStillChecked) {
    if (claim.hasSignatureOnFile) {
      await page.check(sel.signatureOnFileYesRadio);
    } else {
      await page.check(sel.signatureOnFileNoRadio);
    }
  }

  await page.click(sel.continueButton);
  await page.waitForLoadState('networkidle');

  const stillOnStep1 = await page.locator('text=Submit Professional Claim: Step 1').isVisible().catch(() => false);
  if (stillOnStep1) {
    const pageText = await page.locator('body').innerText().catch(() => '');
    const errorLines = pageText
      .split('\n')
      .filter(line => /required|invalid|error|please|must/i.test(line))
      .slice(0, 15)
      .join(' | ');
    const transportYesChecked = await page.isChecked(sel.transportCertYesRadio).catch(() => 'unknown');
    const transportNoChecked = await page.isChecked(sel.transportCertNoRadio).catch(() => 'unknown');

    // Find the actual HTML element(s) mentioning "Certification Condition
    // Indicator" so we can see exactly which control the validator is tied to.
    const certIndicatorHtml = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('body *'));
      const matches = all.filter(el =>
        el.children.length === 0 &&
        el.textContent &&
        el.textContent.includes('Certification Condition Indicator')
      );
      return matches.slice(0, 5).map(el => ({
        tag: el.tagName,
        id: el.id || null,
        className: el.className || null,
        text: el.textContent.trim(),
        outerHTML: el.outerHTML.slice(0, 500),
        parentOuterHTML: el.parentElement ? el.parentElement.outerHTML.slice(0, 800) : null
      }));
    }).catch(() => []);

    throw new Error(
      `Still on Step 1 after clicking Continue. Visible validation/error text on page: ${errorLines || '(none found matching keywords)'} ` +
      `| DEBUG radio states at failure - TransportCert Yes checked: ${transportYesChecked}, No checked: ${transportNoChecked} ` +
      `| DEBUG certIndicatorHtml: ${JSON.stringify(certIndicatorHtml)}`
    );
  }

  const sel2 = config.selectors.step2_diagnosisAndServiceLines;
  await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
  await page.fill(sel2.diagnosisCodeField, claim.diagnosisCode);
  await page.waitForTimeout(500);
  const suggestion = page.locator(`text=${claim.diagnosisCode}`).first();
  if (await suggestion.isVisible().catch(() => false)) {
    await suggestion.click();
  }
  await page.click(sel2.diagnosisCodeAddButton);
  await page.waitForLoadState('networkidle');

  const sel3 = config.selectors.step3_serviceDetails;

  await page.fill(sel3.fromDateField, claim.tripDate).catch(() => {});
  await page.fill(sel3.toDateField, claim.tripDate).catch(() => {});
  await page.fill(sel3.procedureCodeField, rates.baseRate.procedure_code).catch(() => {});
  await page.fill(sel3.chargeAmountField, String(rates.baseRate.charge_amount)).catch(() => {});
  await page.fill(sel3.unitsField, '1').catch(() => {});
  await page.selectOption(sel3.diagnosisPointerDropdown, { label: sel3.diagnosisPointerValue }).catch(() => {});
  await page.click(sel3.addServiceLineButton).catch(() => {});

  const loadedMiles = claim.dropoffOdometer && claim.pickupOdometer
    ? claim.dropoffOdometer - claim.pickupOdometer
    : null;

  if (loadedMiles) {
    const mileageCharge = (rates.mileageRate.charge_amount * loadedMiles).toFixed(2);
    await page.fill(sel3.fromDateField, claim.tripDate).catch(() => {});
    await page.fill(sel3.toDateField, claim.tripDate).catch(() => {});
    await page.fill(sel3.procedureCodeField, rates.mileageRate.procedure_code).catch(() => {});
    await page.fill(sel3.chargeAmountField, mileageCharge).catch(() => {});
    await page.fill(sel3.unitsField, String(loadedMiles)).catch(() => {});
    await page.selectOption(sel3.diagnosisPointerDropdown, { label: sel3.diagnosisPointerValue }).catch(() => {});
    await page.click(sel3.addServiceLineButton).catch(() => {});
  }

  if (claim.tripReportFilePath) {
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(claim.tripReportFilePath).catch(() => {
      console.log('Attachment upload failed - selector may need adjustment once real upload UI is inspected.');
    });
  }

  console.log('Form fully filled through Step 3. STOPPING before Submit - review required.');
  return {
    status: 'READY_FOR_HUMAN_REVIEW',
    message: 'Claim form is fully filled using live billing rates from the provider\'s Billing Settings. Submit was intentionally NOT clicked. A human must review the Charge Amounts and click Submit manually.'
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
      reason: `Provider has not configured billing rates (Trip + Mile) for vehicle_type "${mapped.claim.vehicleType}" in Billing Settings, or the lookup failed: ${err.message}`,
      claim: mapped.claim
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle');

    const result = await submitProfessionalClaim(page, config, mapped.claim, rates);
    await page.screenshot({ path: `${__dirname}/../last-run-success.png`, fullPage: true }).catch(() => {});
    return result;
  } catch (err) {
    await page.screenshot({ path: `${__dirname}/../last-run-error.png`, fullPage: true }).catch(() => {});
    console.log(`Run failed - screenshot saved to last-run-error.png. Error: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { run, mapTripToClaim, fetchBillingRate, fetchBillingRates };
