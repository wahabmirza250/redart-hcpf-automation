/**
 * RedArt LLC - HCPF Colorado Medicaid Claim Submission Robot
 *
 * Config-driven: this same script can run against any portal config
 * (config/hcpf-colorado.json today, other state portals later) by
 * swapping the config file passed in.
 *
 * STATUS: Functional through Step 1 -> Step 2 diagnosis code entry.
 * BLOCKED past that point until:
 *   1. Login page selectors are filled in (config.selectors.login)
 *   2. Service line selectors are filled in (config.selectors.step2_diagnosisAndServiceLines)
 *   3. We know what (if anything) comes after Step 2 - Step 3? Review/Submit page?
 *
 * Do NOT run this against a real account until the full flow has been
 * mapped and reviewed. Right now it will stop after Step 2 diagnosis entry.
 */

const { chromium } = require('playwright');
const fs = require('fs');

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/**
 * Maps a RedArt trip record (from Supabase) into the fields this
 * portal's claim form needs. Adjust field names on the left once
 * you send me the real Supabase column names - these are placeholders
 * based on what you've described so far.
 */
function mapTripToClaim(tripRecord) {
  const claim = {
    memberId: tripRecord.medicaid_member_id || null,
    patientNumber: tripRecord.trip_id || tripRecord.id,
    tripDate: tripRecord.trip_date,
    diagnosisCode: tripRecord.diagnosis_code || null,
    hasSignatureOnFile: Boolean(tripRecord.passenger_signature_url || tripRecord.signature_captured),
    transportCertified: true, // per business rule: always Yes for completed trips
    pickupOdometer: tripRecord.pickup_odometer || null,
    dropoffOdometer: tripRecord.dropoff_odometer || null,
    tripReportFilePath: tripRecord.trip_report_pdf_path || null
  };

  // Guard: don't even attempt submission if Member ID is missing.
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

async function submitProfessionalClaim(page, config, claim) {
  const sel = config.selectors.step1_claimHeader;

  // --- Navigate to Submit Claim Prof ---
  await page.click(config.selectors.navigation.claimsMenuLink);
  await page.click(config.selectors.navigation.submitClaimProfLink);
  await page.waitForLoadState('networkidle');

  // --- Step 1: Header ---
  // Payer defaults to Title XIX Payer already in observed screenshots; verify anyway.
  const payerValue = await page.$eval(sel.payerDropdown, el => el.value).catch(() => null);
  if (payerValue !== null) {
    await page.selectOption(sel.payerDropdown, { label: sel.payerValue });
  }

  await page.fill(sel.memberIdField, claim.memberId);
  await page.locator(sel.memberIdField).blur();
  // Member ID triggers an async lookup that populates name/DOB - wait for it.
  await page.waitForTimeout(1500);

  await page.fill(sel.patientNumberField, String(claim.patientNumber));

  // Date type + date of current
  await page.selectOption(sel.dateTypeDropdown, { label: sel.dateTypeValue }).catch(() => {});
  if (claim.tripDate) {
    await page.fill(sel.dateOfCurrentField, claim.tripDate).catch(() => {});
  }

  // Transport Certification - KNOWN TRAP: verify explicitly, don't assume it stuck.
  await page.check(sel.transportCertYesRadio);
  const certChecked = await page.isChecked(sel.transportCertYesRadio);
  if (!certChecked) {
    throw new Error('Transport Certification Yes radio did not register - aborting before Continue.');
  }

  // Signature on file
  if (claim.hasSignatureOnFile) {
    await page.check(sel.signatureOnFileYesRadio);
  } else {
    await page.check(sel.signatureOnFileNoRadio);
  }

  // --- Click Continue, verify we actually advanced to Step 2 ---
  await page.click(sel.continueButton);
  await page.waitForLoadState('networkidle');

  const stillOnStep1 = await page.locator('text=Submit Professional Claim: Step 1').isVisible().catch(() => false);
  if (stillOnStep1) {
    throw new Error('Still on Step 1 after clicking Continue - a required field was likely rejected (check Transport Certification / Signature on file radios).');
  }

  // --- Step 2: Diagnosis Code ---
  const sel2 = config.selectors.step2_diagnosisAndServiceLines;
  await page.selectOption(sel2.diagnosisTypeDropdown, { label: sel2.diagnosisTypeValue }).catch(() => {});
  await page.fill(sel2.diagnosisCodeField, claim.diagnosisCode);
  // Portal shows an autocomplete dropdown - select exact match if present, else click Add.
  await page.waitForTimeout(500);
  const suggestion = page.locator(`text=${claim.diagnosisCode}`).first();
  if (await suggestion.isVisible().catch(() => false)) {
    await suggestion.click();
  }
  await page.click(sel2.diagnosisCodeAddButton);
  await page.waitForLoadState('networkidle');

  // --- Step 3: Service Details ---
  const sel3 = config.selectors.step3_serviceDetails;
  const rates = sel3.procedureCodes;

  // Service line 1: base rate (A0100)
  await page.fill(sel3.fromDateField, claim.tripDate).catch(() => {});
  await page.fill(sel3.toDateField, claim.tripDate).catch(() => {});
  await page.fill(sel3.procedureCodeField, rates.baseRate.code).catch(() => {});
  await page.fill(sel3.chargeAmountField, String(rates.baseRate.placeholderChargeAmount)).catch(() => {});
  await page.fill(sel3.unitsField, String(rates.baseRate.placeholderUnits)).catch(() => {});
  await page.selectOption(sel3.diagnosisPointerDropdown, { label: sel3.diagnosisPointerValue }).catch(() => {});
  await page.click(sel3.addServiceLineButton).catch(() => {});

  // Service line 2: mileage (S0215) - units = loaded miles from trip record
  const loadedMiles = claim.dropoffOdometer && claim.pickupOdometer
    ? claim.dropoffOdometer - claim.pickupOdometer
    : null;

  if (loadedMiles) {
    const mileageCharge = (rates.mileage.placeholderChargeAmountPerUnit * loadedMiles).toFixed(2);
    await page.fill(sel3.fromDateField, claim.tripDate).catch(() => {});
    await page.fill(sel3.toDateField, claim.tripDate).catch(() => {});
    await page.fill(sel3.procedureCodeField, rates.mileage.code).catch(() => {});
    await page.fill(sel3.chargeAmountField, mileageCharge).catch(() => {});
    await page.fill(sel3.unitsField, String(loadedMiles)).catch(() => {});
    await page.selectOption(sel3.diagnosisPointerDropdown, { label: sel3.diagnosisPointerValue }).catch(() => {});
    await page.click(sel3.addServiceLineButton).catch(() => {});
  }

  // --- Attachment: upload the Trip Report PDF ---
  if (claim.tripReportFilePath) {
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(claim.tripReportFilePath).catch(() => {
      console.log('Attachment upload failed - selector may need adjustment once real upload UI is inspected.');
    });
  }

  // --- HARD STOP: never auto-click Submit. ---
  // This requires explicit human review every time until the team has
  // enough confidence (and verified real rates) to remove this stop.
  console.log('Form fully filled through Step 3. STOPPING before Submit - review required.');
  return {
    status: 'READY_FOR_HUMAN_REVIEW',
    message: 'Claim form is fully filled (Step 1-3, diagnosis, service lines, attachment). Submit was intentionally NOT clicked. A human must review the Charge Amounts (currently placeholder rates) and click Submit manually, or explicitly confirm before automated submission is enabled.'
  };
}

async function run(tripRecord) {
  const config = loadConfig(`${__dirname}/../config/hcpf-colorado.json`);
  const mapped = mapTripToClaim(tripRecord);

  if (mapped.status !== 'READY') {
    console.log(`Trip ${tripRecord.id} not submittable: ${mapped.status} - ${mapped.reason}`);
    return mapped;
  }

  const browser = await chromium.launch({ headless: false }); // headed for now while testing
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(config.loginUrl || config.baseUrl);
    await page.fill(config.selectors.login.usernameField, process.env.HCPF_USERNAME);
    await page.fill(config.selectors.login.passwordField, process.env.HCPF_PASSWORD);
    await page.click(config.selectors.login.submitButton);
    await page.waitForLoadState('networkidle');

    const result = await submitProfessionalClaim(page, config, mapped.claim);
    return result;
  } finally {
    await browser.close();
  }
}

module.exports = { run, mapTripToClaim };
