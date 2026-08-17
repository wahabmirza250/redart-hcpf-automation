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

// === ADDED === Picks the first genuinely-provided finite number out of a
// list of aliases, so the robot can accept whichever field name the caller
// actually sent instead of silently ignoring all of them.
function firstFiniteNumber(candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (c !== undefined && c !== null && c !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

// === ADDED (risk hardening) === Fixed-interval waits look robotic.
// This adds small random variation (±20%) to a base wait time, so the
// automation's pacing doesn't look mechanically identical every run.
function jitteredWait(baseMs) {
  const variance = baseMs * 0.2;
  return Math.round(baseMs - variance + Math.random() * variance * 2);
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
 * Fetch this provider's own HCPF portal login from the app's secure
 * credential store, instead of using a single shared Railway env var.
 * This is what lets different companies each use their own portal login
 * with the same robot.
 */
async function fetchPortalCredentials(portalId, companyId) {
  const baseUrl = process.env.BILLING_API_URL;
  const apiKey = process.env.BILLING_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('BILLING_API_URL / BILLING_API_KEY env vars are not set.');
  }

  let url = `${baseUrl.replace(/\/$/, '')}/api/public/get-portal-credential?portal_id=${encodeURIComponent(portalId)}`;
  if (companyId) {
    url += `&company_id=${encodeURIComponent(companyId)}`;
  }

  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `Portal credential lookup failed (${res.status}) for portal_id=${portalId}: ${body.error || body.message || 'unknown error'}`
    );
  }

  if (!body.login_email || !body.login_password) {
    throw new Error(`Portal credential response missing login_email/login_password for portal_id=${portalId}.`);
  }

  return { username: body.login_email, password: body.login_password };
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
    memberId: tripRecord.medicaid_member_id || tripRecord.member_id || tripRecord.medicaid_id || null,
    patientNumber: tripRecord.patient_number || tripRecord.trip_id || tripRecord.id,
    tripDate: tripRecord.trip_date || tripRecord.service_date || tripRecord.date_of_service || tripRecord.from_date,
    diagnosisCode: tripRecord.diagnosis_code || tripRecord.diagnosis || tripRecord.primary_diagnosis
      || tripRecord.dx_code || tripRecord.icd_code || tripRecord.icd10_code
      || (Array.isArray(tripRecord.diagnosis_codes) ? tripRecord.diagnosis_codes[0] : null) || null,
    hasSignatureOnFile: Boolean(tripRecord.passenger_signature_url || tripRecord.signature_captured),
    isRoundTrip: tripRecord.trip_type === 'round_trip' || tripRecord.is_round_trip === true,
    medicaidTripId: tripRecord.medicaid_trip_id || tripRecord.id || null,
    pickupOdometer: tripRecord.pickup_odometer || null,
    dropoffOdometer: tripRecord.dropoff_odometer || null,
    tripReportFilePath: tripRecord.trip_report_pdf_path || null,
    expectedName: tripRecord.passenger_name || tripRecord.expected_name || null,
    // === ADDED === Explicit authoritative values from the app, so this
    // robot stops silently re-deriving numbers the app already computed
    // correctly. Falls back to the old derivation only when genuinely
    // absent - never overrides a real provided value.
    explicitTripUnits: firstFiniteNumber([
      tripRecord.trip_units, tripRecord.units, tripRecord.trip_unit_count, tripRecord.base_units
    ]),
    explicitMiles: firstFiniteNumber([
      tripRecord.miles, tripRecord.mileage_units, tripRecord.total_miles
    ])
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
  // Diagnosis code is no longer required here - it comes from the
  // provider's Billing Settings (default_diagnosis_code), fetched after
  // this mapping step. An explicit tripRecord.diagnosis_code, if
  // provided, still overrides the Billing Settings default.

  return { status: 'READY', claim };
}

async function submitProfessionalClaim(page, config, claim, rates, mode) {
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

  // === ADDED (capture mode name fix) === The member name fields only
  // exist on Step 1. Reading them at the end of the function (after
  // navigating through Step 2/3) always returns empty because those
  // fields are no longer on the page by then. Capture the name HERE,
  // right after Member ID resolves, same timing verify_only already
  // uses successfully - then carry it forward via claim.resolvedMemberName
  // for use in the capture-mode return at the end.
  if (mode === 'capture') {
    async function readMemberFieldEarly(idSubstring) {
      const selector = `input[id*='${idSubstring}']`;
      for (let attempt = 0; attempt < 6; attempt++) {
        const val = await page.locator(selector).first().inputValue({ timeout: 2000 }).catch(() => '');
        if (val && val.trim()) return val.trim();
        await page.waitForTimeout(300);
      }
      return '';
    }
    const earlyLastName = await readMemberFieldEarly('MemberLastNameCmnTextBox');
    const earlyFirstName = await readMemberFieldEarly('MemberFirstNameCmnTextBox');
    claim.resolvedMemberName = `${earlyFirstName} ${earlyLastName}`.trim();
  }

  // === verify_only early exit ===
  // Runs ONLY when mode === 'verify_only'. Normal submit runs never
  // enter this block and are completely unaffected by it.
  if (mode === 'verify_only') {
    // === FIXED (v3) === v2's text-traversal strategies were too broad -
    // one matched an ancestor row wrapping the ENTIRE Step 1 form,
    // returning hundreds of characters of unrelated page text instead
    // of just the name. Use the actual field IDs instead - we found
    // these in earlier debugging of this exact page:
    // MemberLastNameCmnTextBox / MemberFirstNameCmnTextBox. These are
    // real input fields that get auto-populated after Member ID blur,
    // so .inputValue() reads them directly and precisely - no guessing
    // about page structure required.
    async function readLabeledValue(labelText) {
      const idGuess = labelText === 'Last Name'
        ? "input[id*='MemberLastNameCmnTextBox']"
        : labelText === 'First Name'
          ? "input[id*='MemberFirstNameCmnTextBox']"
          : null;

      if (idGuess) {
        try {
          // Poll briefly instead of reading once - confirmed via
          // diagnostic that the field ID is correct, but the portal's
          // autofill can still be populating it a moment after the
          // 1500ms post-blur wait (First Name read a beat later than
          // Last Name and came back populated; Last Name read first
          // and was still empty at that exact instant).
          for (let attempt = 0; attempt < 6; attempt++) {
            const val = await page.locator(idGuess).first().inputValue({ timeout: 2000 }).catch(() => '');
            if (val && val.trim()) return val.trim();
            await page.waitForTimeout(400);
          }
        } catch (err) { /* fall through to text-based strategies below */ }
      }

      const label = page.locator(`text=${labelText}`).first();

      // Fallback Strategy: immediate next sibling element's text only
      // (tightly scoped - NOT a whole row/table, which was the bug)
      try {
        const sibling = label.locator('xpath=following-sibling::*[1]');
        const siblingText = await sibling.innerText({ timeout: 3000 });
        // Guard against grabbing too much - a real name is short
        if (siblingText && siblingText.trim() && siblingText.trim().length < 40) {
          return siblingText.trim();
        }
      } catch (err) { /* fall through */ }

      return '';
    }

    const lastName = await readLabeledValue('Last Name');
    const firstName = await readLabeledValue('First Name');
    const portalName = `${firstName} ${lastName}`.trim();

    // === TEMP DIAGNOSTIC === if Last Name still came back empty, dump
    // every input field whose ID contains "Member" so we can see the
    // real field ID in Railway logs - runs in the SAME already-open,
    // already-locked session (no new browser/login, no mutex risk).
    if (!lastName) {
      try {
        const memberFields = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input, span'))
            .filter(el => el.id && el.id.toLowerCase().includes('member'))
            .map(el => ({ tag: el.tagName, id: el.id, value: el.value || el.textContent || '' }))
            .slice(0, 30);
        });
        console.log('VERIFY_ONLY_DIAGNOSTIC: Member-related fields on page:', JSON.stringify(memberFields));
      } catch (diagErr) {
        console.log('VERIFY_ONLY_DIAGNOSTIC: field dump failed:', diagErr.message);
      }
    }

    const normalize = (s) => (s || '')
      .toUpperCase()
      .replace(/[^A-Z\s]/g, '')
      .replace(/\b(JR|SR|II|III|IV)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const portalNorm = normalize(portalName);
    const expectedNorm = normalize(claim.expectedName);
    const portalTokens = portalNorm.split(' ').filter(Boolean).sort();
    const expectedTokens = expectedNorm.split(' ').filter(Boolean).sort();

    let matchConfidence = 'none';
    if (portalNorm && portalNorm === expectedNorm) {
      matchConfidence = 'exact';
    } else if (portalTokens.length && portalTokens.join(',') === expectedTokens.join(',')) {
      matchConfidence = 'fuzzy';
    }

    console.log(`VERIFY_ONLY: portal name = "${portalName}" (first="${firstName}", last="${lastName}"), expected = "${claim.expectedName}", confidence = ${matchConfidence}`);
    console.log('VERIFY_ONLY: stopping here. Step 2/3/Submit will NOT be touched.');

    // Hard stop. Does not proceed to patientNumberField, dates,
    // Transport Certification, Step 2, Step 3, or Submit - ever.
    return {
      status: 'VERIFY_ONLY_COMPLETE',
      ok: true,
      portal_name: portalName,
      portal_first_name: firstName,
      portal_last_name: lastName,
      matched: matchConfidence !== 'none',
      match_confidence: matchConfidence
    };
  }
  // === END verify_only block ===

  await page.fill(sel.patientNumberField, String(claim.patientNumber));

  // === FIXED (2026-08-15) === This was silently swallowed with
  // .catch(() => {}) - confirmed on real submitted claims that "Date
  // Type" ended up blank instead of "Illness" because a failure here
  // was never surfaced. Now verifies the selection actually landed and
  // fails loudly if not, matching the reliable pattern already used for
  // other required fields.
  // === FIXED (2026-08-15, round 2) === The first attempt at this fix
  // used a raw page.locator() instead of current() (which resolves to
  // .last() to handle this portal's ID-suffix-increments-per-postback
  // behavior, documented above and used everywhere else in this file).
  // That meant the select/verify/dump calls could be targeting a stale
  // or non-existent element - confirmed by a real "could not read
  // options" diagnostic, which only happens when the located element
  // genuinely isn't there. Now uses current() throughout, like every
  // other reliable field in this function.
  await current(sel.dateTypeDropdown).selectOption({ label: sel.dateTypeValue }).catch(err => {
    console.log(`Date Type dropdown select failed: ${err.message}`);
  });
  const dateTypeSelected = await current(sel.dateTypeDropdown).inputValue({ timeout: 3000 }).catch(() => '');
  if (!dateTypeSelected || dateTypeSelected === '0' || dateTypeSelected.trim() === '') {
    // === FIXED (2026-08-17, round 3) === Two prior guesses at this
    // selector both matched ZERO elements - a hardcoded page-instance
    // prefix, then a suffix guess. Rather than guess a THIRD time,
    // comprehensively dump every <select> element on the page (id,
    // visible label text nearby, and its real options), so the correct
    // one can be identified with certainty instead of guessed.
    const allSelectsDump = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map(el => {
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        // Also check nearby text (previous sibling / parent text) in case
        // there's no <label for>, common on this portal's older ASP.NET
        // markup.
        const nearbyText = el.closest('tr, td, div')?.textContent?.trim().slice(0, 80) || null;
        return {
          id: el.id,
          name: el.name,
          labelText: label ? label.textContent?.trim() : null,
          nearbyText,
          options: Array.from(el.options).map(o => o.textContent?.trim()).slice(0, 10)
        };
      });
    }).catch(err => `dump failed: ${err.message}`);
    console.log('ALL <select> elements on page:', JSON.stringify(allSelectsDump));
    throw new Error(`Date Type dropdown did not select "${sel.dateTypeValue}" - could not find it via the configured selector. Full dump of every <select> element actually on this page (id/label/nearby text/options): ${JSON.stringify(allSelectsDump)}. Stopping rather than submit an incomplete claim.`);
  }
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
  // === ADDED === Capture the real, page-verified state HERE, on Step 1,
  // while these radios still exist - not later on Step 3, where they're
  // gone from the DOM. Re-check after any correction above so this
  // reflects the true final state.
  claim.resolvedSignatureOnFileChecked = claim.hasSignatureOnFile
    ? await page.isChecked(sel.signatureOnFileYesRadio).catch(() => null)
    : (await page.isChecked(sel.signatureOnFileNoRadio).catch(() => null)) === true ? false : null;

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
  // === FIXED === Previously this had zero verification and every step
  // was wrapped in a silent .catch() that just moved on regardless of
  // outcome - confirmed via real portal screenshots to be the exact
  // cause of the mileage line's "From Date" ending up blank (a required
  // field), which silently failed Add validation. Now uses the same
  // proven read-back-and-retry pattern already working reliably for the
  // Charge Amount / Units fields (fillMaskedNumberWithRetry below).
  async function fillMaskedDateField(selector, digitsOnly) {
    const delays = [300, 600, 1000, 1500, 2500];
    for (let attempt = 0; attempt < delays.length + 1; attempt++) {
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

      const finalValue = await field.inputValue({ timeout: 3000 }).catch(() => '');
      const finalDigits = finalValue.replace(/\D/g, '');
      if (finalDigits === digitsOnly) {
        return { success: true, attempts: attempt + 1 };
      }

      console.log(`Date field did not register correctly (attempt ${attempt + 1}): expected "${digitsOnly}", field shows "${finalValue}".`);
      if (attempt < delays.length) {
        await page.waitForTimeout(delays[attempt]);
      }
    }
    return { success: false, attempts: delays.length + 1 };
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

  const capturedServiceLines = [];

  async function fillServiceLine(procedureCode, chargeAmount, units, placeOfServiceCode) {
    const fromDateResult = await fillMaskedDateField(sel3.fromDateField, claim.tripDate.replace(/\D/g, ''));
    if (!fromDateResult.success) {
      throw new Error(`From Date for ${procedureCode} would not accept the trip date after ${fromDateResult.attempts} attempts - this is a required field and would fail Add validation.`);
    }
    const toDateResult = await fillMaskedDateField(sel3.toDateField, claim.tripDate.replace(/\D/g, ''));
    if (!toDateResult.success) {
      throw new Error(`To Date for ${procedureCode} would not accept the trip date after ${toDateResult.attempts} attempts - this is a required field and would fail Add validation.`);
    }

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

    // Record exactly what we filled - this becomes the expected running
    // total used for real verification below.
    capturedServiceLines.push({
      procedure_code: procedureCode,
      place_of_service: placeOfServiceCode || '99',
      charge_amount: Number(chargeAmount).toFixed(2),
      units: Number(units).toFixed(3)
    });
    const expectedRunningTotal = capturedServiceLines
      .reduce((sum, line) => sum + parseFloat(line.charge_amount), 0);

    // === FIXED === Previously: Add click failures were swallowed
    // (.catch() logged and continued) - meaning a genuinely failed click
    // could silently drop an entire service line from a real claim. The
    // click itself is now fatal if it doesn't fire at all.
    await current(sel3.addServiceLineButton).click({ timeout: 8000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // === REAL COMMIT VERIFICATION (2026-08-13) === Confirmed via direct
    // DOM inspection: the portal's "Total Charged Amount" field is
    // labeled by an element whose id ends in
    // "TotalChargedAmountCmnTextBox_Label", pointing (via its `for`
    // attribute, i.e. standard HTML label semantics) at the actual value
    // control ending in "TotalChargedAmountCmnTextBox_Control". This
    // field has been directly observed across multiple real screenshots
    // today to always equal the sum of genuinely committed lines -
    // $0.00 with nothing committed, and the correct running total after
    // each real Add. A suffix selector is used since the DNN
    // module-instance number (e.g. "ctr724") is not stable across
    // deployments. This replaces an earlier row-counting attempt that
    // was proven (via real screenshot) to produce false negatives.
    const readPortalTotal = async () => {
      const raw = await page.locator('[id$="TotalChargedAmountCmnTextBox_Control"]')
        .first().inputValue({ timeout: 3000 }).catch(() => null);
      if (raw === null) return null;
      const parsed = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    };

    const verifyCommitted = async () => {
      const portalTotal = await readPortalTotal();
      // If the field genuinely can't be read, don't fail the claim over a
      // diagnostic-field problem - fall through as unverified rather than
      // block a possibly-good submission on a selector issue.
      if (portalTotal === null) return { verified: null, portalTotal: null };
      const matches = Math.abs(portalTotal - expectedRunningTotal) < 0.01;
      return { verified: matches, portalTotal };
    };

    // === IMPROVED (2026-08-14) === Previously only retried once with a
    // fixed 2.5s wait - real evidence today showed this isn't always
    // enough when the portal itself is just being slow, not genuinely
    // broken (the exact same code succeeded fully on an earlier
    // identical test the same day). Now retries up to 4 additional
    // times with progressively longer waits, giving a slow-but-working
    // portal response a real chance to catch up before giving up.
    let check = await verifyCommitted();
    const retryWaits = [3000, 4000, 5000, 6000];
    for (let i = 0; check.verified === false && i < retryWaits.length; i++) {
      console.log(`Service line Add did not appear to commit for ${procedureCode} (attempt ${i + 1}/${retryWaits.length}): portal total $${check.portalTotal}, expected $${expectedRunningTotal.toFixed(2)} - retrying.`);
      await current(sel3.addServiceLineButton).click({ timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(retryWaits[i]);
      check = await verifyCommitted();
    }
    if (check.verified === false) {
      throw new Error(
        `Service line for ${procedureCode} (charge $${chargeAmount}, ${units} units) did not commit after ${retryWaits.length + 1} Add attempts - portal Total Charged Amount shows $${check.portalTotal}, expected $${expectedRunningTotal.toFixed(2)}. Stopping rather than submit an incomplete claim.`
      );
    }
    console.log(`Service line ${procedureCode} commit check: ${check.verified === true ? 'CONFIRMED' : 'unverified (field unreadable, proceeding)'} - portal total $${check.portalTotal}, expected $${expectedRunningTotal.toFixed(2)}.`);
  }

  // === FIXED === Base (trip) units previously came ONLY from
  // claim.isRoundTrip (always 1 or 2), completely ignoring any explicit
  // unit count the app sent - this is exactly why a correctly-computed
  // app-side unit count never reached the real claim. Now: an explicit
  // value is used if provided, falling back to the old round-trip-based
  // logic only when genuinely absent.
  const baseUnits = claim.explicitTripUnits !== null ? claim.explicitTripUnits : (claim.isRoundTrip ? 2 : 1);
  const baseCharge = rates.baseRate.charge_amount * baseUnits;
  await fillServiceLine(rates.baseRate.procedure_code, baseCharge, baseUnits, rates.baseRate.place_of_service);

  // === FIXED === Mileage previously came ONLY from
  // (dropoffOdometer - pickupOdometer) on whatever raw odometer pair was
  // sent - ignoring any explicit, already-correct mileage figure the app
  // computed (e.g. summed across individual round-trip legs, excluding
  // the gap between them). Now: an explicit value is used if provided,
  // falling back to the odometer-derived calculation only when absent.
  const loadedMiles = claim.explicitMiles !== null
    ? claim.explicitMiles
    : (claim.dropoffOdometer && claim.pickupOdometer ? claim.dropoffOdometer - claim.pickupOdometer : null);

  if (loadedMiles) {
    const mileageCharge = rates.mileageRate.charge_amount * loadedMiles;
    await fillServiceLine(rates.mileageRate.procedure_code, mileageCharge, loadedMiles, rates.mileageRate.place_of_service);
  }

  if (claim.tripReportFilePath) {
    console.log('ATTACHMENT_V2_MARKER: starting attachment flow, file path =', claim.tripReportFilePath);
    await page.locator(sel3.attachmentUploadLink).click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);

    const fileInput = page.locator(sel3.attachmentFileInput).last();
    const fileSet = await fileInput.setInputFiles(claim.tripReportFilePath, { timeout: 8000 })
      .then(() => true)
      .catch(err => {
        console.log(`Attachment file upload failed: ${err.message}`);
        return false;
      });

    // Retry helper: the Attachments panel can re-collapse from an AJAX
    // postback at any moment (unpredictable timing), hiding whatever
    // field we're about to interact with. Instead of checking once, this
    // retries the whole action + re-expand cycle up to 5 times.
    async function attachmentActionWithRetry(actionFn, label, maxAttempts = 5) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await actionFn();
          return true;
        } catch (err) {
          console.log(`ATTACHMENT_V2_MARKER: ${label} attempt ${attempt + 1} failed (${err.message}) - re-expanding and retrying.`);
          // Use the stable icon ID, not the text link - the text link
          // reads "Click to add attachment" only before the FIRST click;
          // after that it becomes "Click to collapse", so re-clicking the
          // original text selector silently matches nothing.
          await page.locator(sel3.attachmentToggleIcon).last().click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1200);
          // Verify it's actually expanded now; if still hidden, click once more.
          const stillHidden = await page.locator(sel3.attachmentTypeDropdown).last().isHidden().catch(() => true);
          if (stillHidden) {
            await page.locator(sel3.attachmentToggleIcon).last().click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1200);
          }
        }
      }
      console.log(`ATTACHMENT_V2_MARKER: ${label} gave up after ${maxAttempts} attempts.`);
      return false;
    }

    if (fileSet) {
      await attachmentActionWithRetry(
        () => page.locator(sel3.attachmentTypeDropdown).last().selectOption({ label: sel3.attachmentTypeValue }, { timeout: 4000 }),
        'Attachment Type select'
      );

      await attachmentActionWithRetry(
        () => page.locator(sel3.transmissionMethodDropdown).last().selectOption({ index: 1 }, { timeout: 4000 }),
        'Transmission Method select'
      );

      const addSucceeded = await attachmentActionWithRetry(
        () => page.locator(sel3.attachmentAddButton).last().click({ timeout: 4000 }),
        'Attachment Add click'
      );

      if (addSucceeded) {
        console.log('ATTACHMENT_V2_MARKER: attachment Add click succeeded.');
      }

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  } else {
    console.log('ATTACHMENT_V2_MARKER: no tripReportFilePath - skipping attachment entirely (PDF fetch likely failed or trip has no PDF).');
  }

  if (mode === 'confirm_submit') {
    // === REAL SUBMISSION === This clicks Submit AND the real Confirm
    // button - a genuine, final, irreversible Medicaid claim
    // submission. Only ever call this against a real trip a human has
    // reviewed and approved via the Pass 1 capture/review flow.
    console.log('CONFIRM_SUBMIT: clicking Submit.');
    await current(sel3.submitButton).click({ timeout: 8000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const onConfirmPage = page.url().includes('ConfirmProfessionalClaim');
    if (!onConfirmPage) {
      throw new Error(`Did not reach Confirm page after Submit click. Current URL: ${page.url()}`);
    }

    console.log('CONFIRM_SUBMIT: on Confirm page, clicking real Confirm button.');
    // === FIXED (2026-08-15) === Confirmed via two real failures: this
    // click can report "Timeout Xms exceeded" even when it genuinely
    // fired and the portal actually processed the claim - a known
    // Playwright pattern where a click that triggers page navigation
    // races against the browser's own actionability check. Previously
    // this threw immediately, leaving the claim's real outcome unknown
    // (SUBMITTED_UNVERIFIED). Now: if the click call itself errors, we
    // don't give up - we check the CURRENT page right away for proof
    // the confirmation actually went through, in the same session,
    // before ever reporting an uncertain result.
    let confirmClickError = null;
    try {
      await page.locator('#dnn_ctr768_ClaimDetailsProfessional_ConfirmCmnButton').click({ timeout: 8000 });
    } catch (err) {
      confirmClickError = err;
      console.log(`CONFIRM_SUBMIT: Confirm click reported an error (${err.message}) - checking if it actually went through anyway before giving up.`);
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    await page.screenshot({ path: `${__dirname}/../last-run-success.png`, fullPage: true }).catch(() => {});

    // We've never seen the post-Confirm page before, so read back
    // whatever appears generically rather than guessing a specific
    // field ID - search visible text for anything that looks like a
    // confirmation/control/reference number near a relevant label.
    const postConfirmDump = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const allText = Array.from(document.querySelectorAll('span, td, div, label'))
        .map(el => (el.textContent || '').trim())
        .filter(t => t.length > 0 && t.length < 150);
      const confirmationCandidates = allText.filter(t =>
        /confirmation|control\s*#|control\s*number|tcn|reference\s*#|claim\s*#|icn/i.test(t)
      );
      return {
        pageTitle: document.title,
        url: window.location.href,
        bodyTextFull: bodyText.slice(0, 3000),
        confirmationCandidates
      };
    });

    // Extract the real Claim ID directly - confirmed format from a real
    // submission: "The Claim ID is 9426213001270."
    const claimIdMatch = postConfirmDump.bodyTextFull.match(/Claim ID is\s+(\d+)/i);
    const claimId = claimIdMatch ? claimIdMatch[1] : null;
    const isSuspended = /status is Suspended/i.test(postConfirmDump.bodyTextFull);

    if (!claimId && confirmClickError) {
      // The click genuinely errored AND we can't find a claim ID on the
      // current page - only NOW is this a real "we don't know" situation.
      // This should be rare after the fix above, but stay honest rather
      // than guess when it does happen.
      console.log(`CONFIRM_SUBMIT: Confirm click errored and no Claim ID found on the resulting page - reporting unverified rather than guessing.`);
      return {
        status: 'SUBMITTED_UNVERIFIED',
        message: `The portal Confirm button click reported an error (${confirmClickError.message}), and no Claim ID was found on the resulting page. The claim may or may not have been submitted. Verify in the portal and record its claim number - do NOT resubmit.`,
        post_confirm_dump: postConfirmDump
      };
    }

    console.log(`CONFIRM_SUBMIT: complete. Claim ID = ${claimId || 'NOT FOUND'}, status suspended = ${isSuspended}${confirmClickError ? ' (recovered after a click-timeout error)' : ''}.`);

    return {
      status: 'SUBMITTED',
      message: claimId
        ? `Claim submitted successfully. Claim ID: ${claimId}.`
        : 'Claim was submitted and confirmed, but the Claim ID could not be automatically parsed - check post_confirm_dump manually.',
      claim_id: claimId,
      claim_status_suspended: isSuspended,
      post_confirm_dump: postConfirmDump
    };
  }

  if (mode === 'debug_confirm_page') {
    // === TEMPORARY DEBUG MODE === Never used in real submission. Clicks
    // the actual Submit button ONE time (first time ever in this
    // project) to see what the "Confirm Professional Claim" page
    // actually looks like, so Pass 2 can be built against real
    // structure instead of guessing. Stops before Confirm/Cancel -
    // never finalizes anything.
    console.log('DEBUG_CONFIRM_PAGE: about to click Submit for inspection purposes only.');

    const submitMatchCount = await page.locator(sel3.submitButton).count();
    const submitVisible = await current(sel3.submitButton).isVisible().catch(() => false);
    console.log(`DEBUG_CONFIRM_PAGE: Submit selector matched ${submitMatchCount} element(s), last one visible=${submitVisible}.`);

    await current(sel3.submitButton).click({ timeout: 8000 }).catch(err => {
      console.log(`DEBUG_CONFIRM_PAGE: Submit click failed: ${err.message}`);
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const urlAfterClick = page.url();
    console.log(`DEBUG_CONFIRM_PAGE: URL after Submit click attempt: ${urlAfterClick}`);

    const pageDump = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
        .map(el => ({
          tag: el.tagName,
          id: el.id || null,
          text: (el.textContent || el.value || '').trim().slice(0, 60),
          visible: el.offsetParent !== null
        }))
        .filter(el => el.text || el.id);

      // This portal consistently names real interactive elements with a
      // "Cmn" substring (ContinueCmnButton, CancelCmnButton,
      // AddCmnLinkButton, etc. - confirmed across every page we've
      // debugged in this project). Dump every such element regardless
      // of visible text, to find Confirm/Cancel's real IDs precisely.
      const cmnElements = Array.from(document.querySelectorAll('[id*="Cmn"]'))
        .map(el => ({
          tag: el.tagName,
          id: el.id,
          text: (el.textContent || el.value || '').trim().slice(0, 60),
          visible: el.offsetParent !== null
        }));

      const labeledFields = Array.from(document.querySelectorAll('span, td, div'))
        .map(el => (el.textContent || '').trim())
        .filter(t => t.length > 0 && t.length < 100 && /confirm|control|receipt|reference|number|claim/i.test(t))
        .slice(0, 40);

      return {
        pageTitle: document.title,
        bodyTextSnippet: document.body.innerText.slice(0, 2000),
        buttons: buttons,
        cmnElements: cmnElements,
        possibleConfirmationFields: labeledFields
      };
    });

    await page.screenshot({ path: `${__dirname}/../last-run-success.png`, fullPage: true }).catch(() => {});

    console.log('DEBUG_CONFIRM_PAGE: dump complete, closing session WITHOUT clicking Confirm or Cancel.');

    return {
      status: 'DEBUG_CONFIRM_PAGE_INSPECTED',
      message: 'Submit was clicked for inspection only. Confirm/Cancel were NOT clicked. Session will close now.',
      diagnostics: {
        submit_selector_match_count: submitMatchCount,
        submit_was_visible: submitVisible,
        url_after_click: urlAfterClick
      },
      page_dump: pageDump
    };
  }

  if (mode === 'capture') {
    const memberName = claim.resolvedMemberName || '';

    const totalChargedAmount = capturedServiceLines
      .reduce((sum, line) => sum + parseFloat(line.charge_amount), 0)
      .toFixed(2);

    // === ADDED === Read back the ACTUAL radio button state from the real
    // page, not just what we intended to select. This is real proof for
    // capture-mode reviewers - after the signature-on-file incident, "we
    // sent the right data" isn't good enough; we need to show what the
    // portal itself actually has checked.
    // Real, page-verified state captured back on Step 1 (while those
    // radios still existed), not a too-late read here on Step 3.
    const signatureOnFileChecked = claim.resolvedSignatureOnFileChecked !== undefined
      ? claim.resolvedSignatureOnFileChecked
      : null;
    const identityVerifiedChecked = null; // no separate portal field for this - see identity_verified handling above

    console.log(`CAPTURE_MODE: member="${memberName}", lines=${capturedServiceLines.length}, total=${totalChargedAmount}, signatureOnFile=${signatureOnFileChecked}. Closing session without submitting.`);

    // === TEMPORARY DIAGNOSTIC (2026-08-13 service-line reliability
    // investigation) === Find the real "Total Charged Amount" field's
    // structure/ID from the live page, so a future commit-verification
    // fix can be built against a confirmed selector instead of another
    // guess. This is read-only - never modifies anything on the page.
    let totalChargedAmountDump = null;
    try {
      totalChargedAmountDump = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const matches = [];
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent && /Total Charged Amount/i.test(node.textContent)) {
            const labelEl = node.parentElement;
            // Look at the label's row/container for the actual value element
            const container = labelEl ? labelEl.closest('tr, div, td') || labelEl.parentElement : null;
            const candidateValueEls = container
              ? Array.from(container.querySelectorAll('span, td, div, input'))
                  .filter(el => el !== labelEl && /^\$?\s*[\d,]+\.\d{2}\s*$/.test((el.textContent || el.value || '').trim()))
              : [];
            matches.push({
              labelTag: labelEl ? labelEl.tagName : null,
              labelId: labelEl ? labelEl.id : null,
              containerTag: container ? container.tagName : null,
              containerId: container ? container.id : null,
              containerHTML: container ? container.outerHTML.slice(0, 800) : null,
              candidateValues: candidateValueEls.map(el => ({
                tag: el.tagName,
                id: el.id,
                text: (el.textContent || el.value || '').trim()
              }))
            });
          }
        }
        return matches.slice(0, 5);
      });
    } catch (diagErr) {
      console.log('TOTAL_AMOUNT_DIAGNOSTIC: dump failed:', diagErr.message);
    }
    console.log('TOTAL_AMOUNT_DIAGNOSTIC:', JSON.stringify(totalChargedAmountDump));

    return {
      status: 'READY_FOR_HUMAN_REVIEW',
      message: 'Claim data captured for review. Submit was NOT clicked. Portal session will be closed.',
      total_charged_amount_dump: totalChargedAmountDump,
      captured_claim: {
        member_id: claim.memberId,
        member_name: memberName,
        diagnosis_code: claim.diagnosisCode,
        service_lines: capturedServiceLines,
        total_charged_amount: totalChargedAmount,
        // Real, read-back proof of what the portal actually has selected -
        // not just what we intended to send it.
        signature_on_file_selected: signatureOnFileChecked,
        identity_verified_selected: identityVerifiedChecked
      }
    };
  }

  console.log('Form fully filled through Step 3. STOPPING before Submit - review required.');
  return {
    status: 'READY_FOR_HUMAN_REVIEW',
    message: 'Claim form is fully filled - Member ID, dates, Place of Service, Procedure Code, Diagnosis, Charge Amount, and Units - using live billing rates from Billing Settings. Submit was intentionally NOT clicked. A human must review and click Submit manually.'
  };
}

async function run(tripRecord, mode) {
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

  // Diagnosis code: use an explicit per-trip value if the caller provided
  // one, otherwise fall back to the provider's Billing Settings default.
  // This is the field a provider sets once and can't forget to pass per
  // request - removes a class of "missing/mistyped diagnosis" mistakes.
  if (!mapped.claim.diagnosisCode) {
    mapped.claim.diagnosisCode = rates.baseRate.default_diagnosis_code || rates.mileageRate.default_diagnosis_code || null;
  }
  if (!mapped.claim.diagnosisCode) {
    return {
      status: 'BLOCKED_MISSING_DIAGNOSIS_CODE',
      reason: 'No diagnosis code on the trip and no default_diagnosis_code configured in Billing Settings for this vehicle type. Set one in Billing Settings before submitting.',
      claim: mapped.claim
    };
  }

  // Fetch the trip report PDF (if one exists) before opening the browser.
  // Not fatal if missing - attachment is optional, not required to submit.
  const tripPdfPath = await fetchAndSaveTripPdf(mapped.claim.medicaidTripId).catch(() => null);
  mapped.claim.tripReportFilePath = tripPdfPath;

  // Fetch THIS provider's own HCPF portal login instead of a shared
  // Railway env var - each company using this robot needs their own
  // credentials, saved once in their app under Team & apps.
  let portalCredentials;
  try {
    portalCredentials = await fetchPortalCredentials('hfc-colorado', tripRecord.company_id || null);
  } catch (err) {
    console.log(`Trip ${tripRecord.id} blocked: could not fetch portal credentials - ${err.message}`);
    return {
      status: 'BLOCKED_MISSING_PORTAL_CREDENTIALS',
      reason: `No HCPF portal login configured for this provider. Add one under Team & apps → Billing portal → Add credential ("Colorado Health First"). Error: ${err.message}`,
      claim: mapped.claim
    };
  }

  // === ADDED (risk hardening) === Reduce obvious automation fingerprints.
  // Default headless Chromium exposes navigator.webdriver=true and a
  // few other tells that make it easy for a site to detect it's a bot,
  // not a human browsing normally.
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  // Hide the automation flag that gives away a scripted browser.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const INTERNAL_TIMEOUT_MS = 6 * 60 * 1000;
  const internalTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Internal timeout after ${INTERNAL_TIMEOUT_MS / 1000}s - aborting and closing browser.`)), INTERNAL_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([
      (async () => {
        await page.goto(config.loginUrl || config.baseUrl);
        await page.waitForTimeout(jitteredWait(600)); // brief pause, like a human landing on the page
        await page.fill(config.selectors.login.usernameField, portalCredentials.username);
        await page.waitForTimeout(jitteredWait(400)); // pause between username and password fields
        await page.fill(config.selectors.login.passwordField, portalCredentials.password);
        await page.waitForTimeout(jitteredWait(300));
        await page.click(config.selectors.login.submitButton);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

        const claimResult = await submitProfessionalClaim(page, config, mapped.claim, rates, mode);
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
