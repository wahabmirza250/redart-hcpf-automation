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
const {
  legMilesFromRecord,
  matchPortalClaimRow,
  normalizeHcpfStatus,
  parseMoney,
  portalDateDigits,
  validateCorrectionModifierPlan,
  validateMileagePlan
} = require('./claimSafety');
const { openAuthenticatedPortal } = require('./portalAuth');
const { afterPostback, clickLast } = require('./portalWait');
const { attachClaimIdSniffer, waitForClaimReceipt } = require('./claimReceipt');

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

// Reject corrupt billing quantities before the browser reaches the HCPF form.
// A malformed app value previously reached the Units mask as 1314748; the
// portal truncated it to 114748.000 and the robot spent six retries proving
// the field could not match. More importantly, a permissive portal could have
// accepted a catastrophically wrong quantity. These limits deliberately fail
// closed and leave the bill unsubmitted for human correction.
function requireSafeUnits(value, { label, max }) {
  const units = Number(value);
  if (!Number.isFinite(units) || units <= 0 || units > max) {
    throw new Error(
      `BLOCKED_INVALID_UNITS: ${label} must be greater than 0 and no more than ${max}; received "${value}". ` +
      'Stopping before opening the HCPF claim form.'
    );
  }
  return units;
}

// Colorado's initial timely-filing window is 365 days. Old or future dates
// require human review (for example, a documented timely-filing exception)
// and must never flow through automatic submission.
function requireSafeServiceDate(value, now = new Date()) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/) || raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  let serviceDate;
  if (match && raw.includes('-')) {
    serviceDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  } else if (match) {
    serviceDate = new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
  } else {
    serviceDate = new Date(raw);
  }

  if (!Number.isFinite(serviceDate.getTime())) {
    throw new Error(`BLOCKED_INVALID_SERVICE_DATE: Service date "${value}" is invalid. Needs Attention before submission.`);
  }

  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const serviceUtc = Date.UTC(serviceDate.getUTCFullYear(), serviceDate.getUTCMonth(), serviceDate.getUTCDate());
  const ageDays = Math.floor((todayUtc - serviceUtc) / 86400000);
  if (ageDays < 0) {
    throw new Error(`BLOCKED_FUTURE_SERVICE_DATE: Service date "${value}" is in the future. Needs Attention before submission.`);
  }
  if (ageDays > 365) {
    throw new Error(
      `BLOCKED_TIMELY_FILING: Service date "${value}" is ${ageDays} days old (limit 365). ` +
      'Needs Attention; do not auto-submit without documented timely-filing support.'
    );
  }
  return serviceDate;
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

async function gotoSearchClaimsPage(page, config) {
  await clickLast(page, config.selectors.navigation.claimsMenuLink);
  await clickLast(page, config.selectors.navigation.submitClaimProfLink);
  await afterPostback(page, { ready: 'text=Submit Claim Prof' });
  const searchClaimsUrl = page.url().replace(/tabid\/\d+/, 'tabid/531');
  await page.goto(searchClaimsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await afterPostback(page, { ready: '[id$="SearchMedicalAndDentalClaimsCmnButton"]' });
}

async function fillSearchCriteria(page, { memberId, serviceDate, claimId }) {
  if (memberId) {
    const memberIdField = page.locator('[id$="MemberIdCmnTextBox_Control"]').last();
    await memberIdField.click().catch(() => {});
    await memberIdField.fill('').catch(() => {});
    await memberIdField.pressSequentially(String(memberId), { delay: 40 }).catch(() => {});
    await memberIdField.evaluate(el => el.blur()).catch(() => {});
    await page.waitForTimeout(400);
  }
  if (claimId) {
    const claimIdField = page.locator('[id$="ClaimIDCmnTextBox_Control"]').last();
    await claimIdField.click().catch(() => {});
    await claimIdField.fill('').catch(() => {});
    await claimIdField.pressSequentially(String(claimId), { delay: 40 }).catch(() => {});
    await claimIdField.evaluate(el => el.blur()).catch(() => {});
    await page.waitForTimeout(400);
  }
  if (serviceDate) {
    const dateField = page.locator('[id$="DateOfCurrentCmnTextBox_Control"]').last();
    if (await dateField.isVisible().catch(() => false)) {
      const digits = portalDateDigits(serviceDate);
      const formatted = digits.length === 8
        ? `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
        : String(serviceDate);
      await dateField.click().catch(() => {});
      await dateField.fill('').catch(() => {});
      await dateField.pressSequentially(formatted, { delay: 40 }).catch(() => {});
      await dateField.evaluate(el => el.blur()).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  const searchButton = page.locator('[id$="SearchMedicalAndDentalClaimsCmnButton"]').last();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
    searchButton.evaluate(el => el.click())
  ]).catch(() => {});
  await afterPostback(page);
}

async function readSearchResultRows(page) {
  return page.evaluate(() => {
    const claims = [];
    const resultsTables = Array.from(document.querySelectorAll('table')).filter(t =>
      t.id && (t.id.includes('Results') || t.id.includes('Grid') || t.id.includes('Claims'))
    );
    if (!resultsTables.length) return { claims, resultCount: 0, searchCompleted: true };
    const table = resultsTables[0];
    const headerRow = table.querySelector('thead tr, tr:first-child');
    const dataRows = table.querySelectorAll('tbody tr, tr');
    let columnIndices = { claim_id: null, status: null, service_date: null, paid_amount: null, units: null, charge: null };
    if (headerRow) {
      headerRow.querySelectorAll('th, td').forEach((h, idx) => {
        const text = h.textContent?.trim().toLowerCase() || '';
        if (text.includes('claim') && text.includes('id')) columnIndices.claim_id = idx;
        if (text.includes('status')) columnIndices.status = idx;
        if (text.includes('service') && text.includes('date')) columnIndices.service_date = idx;
        if ((text.includes('paid') && text.includes('amount')) || text.includes('amount')) columnIndices.paid_amount = idx;
        if (text.includes('unit')) columnIndices.units = idx;
        if (text.includes('charge')) columnIndices.charge = idx;
      });
    }
    if (!columnIndices.claim_id) {
      columnIndices = { claim_id: 1, status: 2, service_date: 3, paid_amount: 4, units: 5, charge: 6 };
    }
    dataRows.forEach((row, rowIdx) => {
      if (rowIdx === 0 && headerRow === row) return;
      const cells = row.querySelectorAll('td');
      const needed = Math.max(...Object.values(columnIndices).filter(v => v !== null));
      if (cells.length <= needed) return;
      const claim = {
        claim_id: columnIndices.claim_id !== null ? cells[columnIndices.claim_id]?.textContent?.trim() : null,
        status: columnIndices.status !== null ? cells[columnIndices.status]?.textContent?.trim() : null,
        service_date: columnIndices.service_date !== null ? cells[columnIndices.service_date]?.textContent?.trim() : null,
        paid_amount: columnIndices.paid_amount !== null ? cells[columnIndices.paid_amount]?.textContent?.trim() : null,
        units: columnIndices.units !== null ? cells[columnIndices.units]?.textContent?.trim() : null,
        charge: columnIndices.charge !== null ? cells[columnIndices.charge]?.textContent?.trim() : null
      };
      if (claim.claim_id) claims.push(claim);
    });
    return { claims, resultCount: claims.length, searchCompleted: true };
  }).catch(err => ({ error: err.message, claims: [], searchCompleted: false }));
}

/**
 * Read-only portal check used before a real Confirm click.
 * Returns the first claim that matches member + service date, or null.
 * On search failure we return null so the ledger (not a guess) decides.
 */
async function findExistingPortalClaim(page, config, claim) {
  try {
    await gotoSearchClaimsPage(page, config);
    await fillSearchCriteria(page, { memberId: claim.memberId, serviceDate: claim.tripDate });
    const rows = await readSearchResultRows(page);
    const matches = (rows.claims || []).filter(row => matchPortalClaimRow(row, claim));
    const match = matches.length ? matches[matches.length - 1] : null;
    await clickLast(page, config.selectors.navigation.claimsMenuLink);
    await clickLast(page, config.selectors.navigation.submitClaimProfLink);
    await afterPostback(page);
    return match;
  } catch (err) {
    console.log('PRECHECK_SEARCH_FAILED:', err.message);
    return null;
  }
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
    ]),
    legMiles: legMilesFromRecord(tripRecord)
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

  // Validate every quantity before navigating into claim entry so a corrupt
  // mileage value cannot create even a partial service line in the portal.
  requireSafeServiceDate(claim.tripDate);
  const baseUnits = requireSafeUnits(
    claim.explicitTripUnits !== null ? claim.explicitTripUnits : (claim.isRoundTrip ? 2 : 1),
    { label: 'Trip units', max: 2 }
  );
  const loadedMilesRaw = claim.explicitMiles !== null
    ? claim.explicitMiles
    : (claim.dropoffOdometer && claim.pickupOdometer ? claim.dropoffOdometer - claim.pickupOdometer : null);
  const mileagePlan = loadedMilesRaw !== null && loadedMilesRaw !== undefined && loadedMilesRaw !== ''
    ? validateMileagePlan({ leg_miles: claim.legMiles }, loadedMilesRaw, claim.isRoundTrip, 52)
    : { legs: [], total: null, maxPerLeg: 52 };
  const loadedMiles = mileagePlan.total;

  await clickLast(page, config.selectors.navigation.claimsMenuLink);
  await clickLast(page, config.selectors.navigation.submitClaimProfLink);
  await afterPostback(page, { ready: sel.memberIdField });

  const payerValue = await page.$eval(sel.payerDropdown, el => el.value).catch(() => null);
  if (payerValue !== null) {
    await page.selectOption(sel.payerDropdown, { label: sel.payerValue });
  }

  await page.fill(sel.memberIdField, claim.memberId);
  await page.locator(sel.memberIdField).blur();
  const memberNameReady = page.locator("input[id*='MemberLastNameCmnTextBox']").first();
  await memberNameReady.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  for (let attempt = 0; attempt < 8; attempt++) {
    const filled = await memberNameReady.inputValue({ timeout: 1000 }).catch(() => '');
    if (filled && filled.trim()) break;
    await page.waitForTimeout(200);
  }

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
  // Date of Current is now always required, since Date Type is always
  // set to "Illness" above - the portal rejects the claim otherwise.
  if (!claim.tripDate) {
    throw new Error('No trip date available (claim.tripDate is empty) - Date of Current is a required field whenever Date Type is set, and cannot be filled without a real trip date. Stopping rather than submit an incomplete claim.');
  }
  {
    // === FIXED (2026-08-17) === Was a raw page.fill().catch(() => {}) -
    // this portal's date fields use ASP.NET's MaskedEditExtender and
    // reject programmatic .fill() (documented and already proven
    // elsewhere in this file for other date fields). Also confirmed via
    // a real portal validation error that this field is REQUIRED
    // whenever Date Type is set - so a silent failure here would have
    // recreated the exact same class of bug just fixed for Date Type.
    // Now uses the same proven, verified fill method as other date
    // fields, and fails loudly with a real diagnostic dump if it
    // doesn't work, instead of guessing again.
    const dateOfCurrentResult = await fillMaskedDateField(sel.dateOfCurrentField, portalDateDigits(claim.tripDate));
    if (!dateOfCurrentResult.success) {
      const allTextInputsDump = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input[type="text"]'))
          .filter(el => /date|current/i.test(el.id))
          .map(el => ({ id: el.id, value: el.value }));
      }).catch(err => `dump failed: ${err.message}`);
      throw new Error(`Date of Current field would not accept the trip date after ${dateOfCurrentResult.attempts} attempts - the portal requires this whenever Date Type is set. Date/current-related text inputs found on page: ${JSON.stringify(allTextInputsDump)}. Stopping rather than submit an incomplete claim.`);
    }
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

  await page.locator(sel.continueButton).last().click();
  await afterPostback(page);

  const stillOnStep1 = await page.locator('text=Submit Professional Claim: Step 1').isVisible().catch(() => false);
  if (stillOnStep1) {
    const pageText = await page.locator('body').innerText().catch(() => '');
    const errorLines = pageText.split('\n').filter(l => /required|invalid|error|please|must/i.test(l)).slice(0, 15).join(' | ');
    throw new Error(`Still on Step 1 after clicking Continue. Errors: ${errorLines || '(none found)'}`);
  }

  const sel2 = config.selectors.step2_diagnosisAndServiceLines;
  await afterPostback(page, { ready: sel2.diagnosisCodeField });
  await page.locator(sel2.diagnosisTypeDropdown).last().selectOption({ label: sel2.diagnosisTypeValue }).catch(() => {});
  await page.locator(sel2.diagnosisCodeField).last().fill(claim.diagnosisCode);
  await page.waitForTimeout(250);
  const suggestion = page.getByText(claim.diagnosisCode, { exact: true }).last();
  if (await suggestion.isVisible().catch(() => false)) {
    await suggestion.click();
  }
  await page.locator(sel2.diagnosisCodeAddButton).last().click({ timeout: 8000 });
  await afterPostback(page);
  const diagnosisListed = await page.evaluate(code => {
    const needle = String(code || '').toUpperCase();
    return Array.from(document.querySelectorAll('tr, td, span, li'))
      .some(el => (el.innerText || el.textContent || '').toUpperCase().includes(needle));
  }, claim.diagnosisCode).catch(() => false);
  if (!diagnosisListed) {
    throw new Error(`BLOCKED_DIAGNOSIS_NOT_COMMITTED: HCPF did not keep diagnosis ${claim.diagnosisCode} after Add. Submit was not clicked.`);
  }

  await page.locator(sel2.step2ContinueButton).last().click();
  await afterPostback(page, { ready: config.selectors.step3_serviceDetails.fromDateField });

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
    // === IMPROVED (2026-08-18) === Confirmed via real load testing: this
    // field is NOT unreliable in isolation - the exact same trip
    // succeeded cleanly when run alone. Under real concurrent load (8
    // simultaneous portal sessions), the portal itself responds roughly
    // 4x slower, and the old 6-attempt/2.5s-max backoff genuinely ran
    // out of room before a temporarily-slow field caught up. This isn't
    // a logic problem - it's a patience problem. Extended attempts,
    // backoff ceiling, and individual action timeouts to give a
    // legitimately slower portal enough room to succeed, while still
    // failing loudly (not silently) if it genuinely never does.
    const delays = [200, 400, 800, 1600];
    const actionTimeout = 8000;
    const readTimeout = 3000;
    for (let attempt = 0; attempt < delays.length + 1; attempt++) {
      const field = current(selector);
      await field.click({ timeout: actionTimeout }).catch(() => {});
      await page.waitForTimeout(200);
      const existing = await field.inputValue({ timeout: readTimeout }).catch(() => '');
      if (existing && existing.trim() !== '') {
        await field.click({ clickCount: 3 }).catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await page.waitForTimeout(150);
      }
      await field.pressSequentially(digitsOnly, { delay: 35 }).catch(() => {});
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(200);

      const finalValue = await field.inputValue({ timeout: readTimeout }).catch(() => '');
      const finalDigits = finalValue.replace(/\D/g, '');
      if (finalDigits === digitsOnly) {
        return { success: true, attempts: attempt + 1 };
      }

      console.log(`Date field did not register correctly (attempt ${attempt + 1}/${delays.length + 1}): expected "${digitsOnly}", field shows "${finalValue}".`);
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
    const delays = [150, 300, 600, 1000];
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
    await field.pressSequentially(code, { delay: 35 }).catch(() => {});
    await page.waitForTimeout(350);
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

  async function fillAndVerifyModifiers(modifiers, procedureCode) {
    const expected = Array.isArray(modifiers) ? modifiers.filter(Boolean).map(v => String(v).trim().toUpperCase()) : [];
    if (!expected.length) return [];
    if (expected.length > 4) {
      throw new Error(`BLOCKED_TOO_MANY_MODIFIERS: ${procedureCode} has ${expected.length}; HCPF supports at most 4.`);
    }

    const selectors = [
      sel3.modifier1Field,
      sel3.modifier2Field,
      sel3.modifier3Field,
      sel3.modifier4Field
    ].filter(Boolean);
    if (selectors.length < expected.length) {
      throw new Error(`BLOCKED_MODIFIER_FIELD_UNAVAILABLE: no configured HCPF modifier field for ${procedureCode}.`);
    }

    for (let index = 0; index < expected.length; index++) {
      const code = expected[index];
      const field = current(selectors[index]);
      if (await field.count() === 0 || !(await field.isVisible().catch(() => false))) {
        throw new Error(`BLOCKED_MODIFIER_FIELD_UNAVAILABLE: HCPF modifier ${index + 1} field is missing for ${procedureCode}.`);
      }
      const tag = await field.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'select') {
        const selected = await field.selectOption({ label: code }).catch(async () => field.selectOption({ value: code }).catch(() => []));
        if (!selected || selected.length === 0) {
          throw new Error(`BLOCKED_MODIFIER_NOT_ACCEPTED: HCPF would not select modifier ${code} for ${procedureCode}.`);
        }
      } else {
        await field.fill('', { timeout: 8000 });
        await field.pressSequentially(code, { delay: 80 });
        await page.waitForTimeout(500);
        const suggestion = page.getByText(code, { exact: true }).last();
        if (await suggestion.isVisible().catch(() => false)) await suggestion.click().catch(() => {});
        else await field.blur().catch(() => {});
      }
      const actual = String(await field.inputValue({ timeout: 5000 }).catch(() => '')).trim().toUpperCase();
      if (actual !== code) {
        throw new Error(
          `BLOCKED_MODIFIER_NOT_ACCEPTED: expected modifier ${code} for ${procedureCode}, but HCPF field shows "${actual || 'blank'}".`
        );
      }
    }
    return expected;
  }

  const capturedServiceLines = [];

  async function fillServiceLine(procedureCode, chargeAmount, units, placeOfServiceCode, modifiers = []) {
    const fromDateResult = await fillMaskedDateField(sel3.fromDateField, portalDateDigits(claim.tripDate));
    if (!fromDateResult.success) {
      throw new Error(`From Date for ${procedureCode} would not accept the trip date after ${fromDateResult.attempts} attempts - this is a required field and would fail Add validation.`);
    }
    const toDateResult = await fillMaskedDateField(sel3.toDateField, portalDateDigits(claim.tripDate));
    if (!toDateResult.success) {
      throw new Error(`To Date for ${procedureCode} would not accept the trip date after ${toDateResult.attempts} attempts - this is a required field and would fail Add validation.`);
    }

    await selectPlaceOfServiceByCode(sel3.placeOfServiceDropdown, placeOfServiceCode || '99');

    await fillProcedureCode(procedureCode);

    const verifiedModifiers = await fillAndVerifyModifiers(modifiers, procedureCode);

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
      units: Number(units).toFixed(3),
      modifiers: verifiedModifiers
    });
    const expectedRunningTotal = capturedServiceLines
      .reduce((sum, line) => sum + parseFloat(line.charge_amount), 0);

    // === FIXED === Previously: Add click failures were swallowed
    // (.catch() logged and continued) - meaning a genuinely failed click
    // could silently drop an entire service line from a real claim. The
    // click itself is now fatal if it doesn't fire at all.
    await current(sel3.addServiceLineButton).click({ timeout: 8000 });
    await afterPostback(page, { ready: '[id$="TotalChargedAmountCmnTextBox_Control"]' });
    await page.waitForTimeout(400);

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
      // A real submission must never continue without portal-side proof that
      // the service line committed. An unreadable proof field is uncertainty,
      // and uncertainty fails closed.
      if (portalTotal === null) return { verified: false, portalTotal: null };
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
    for (let poll = 0; check.verified === false && poll < 6; poll++) {
      await page.waitForTimeout(250);
      check = await verifyCommitted();
    }
    if (check.verified === false) {
      console.log(`Service line Add still unconfirmed for ${procedureCode}: portal total $${check.portalTotal}, expected $${expectedRunningTotal.toFixed(2)} - one guarded retry.`);
      await current(sel3.addServiceLineButton).click({ timeout: 8000 });
      await afterPostback(page, { ready: '[id$="TotalChargedAmountCmnTextBox_Control"]' });
      for (let poll = 0; check.verified === false && poll < 6; poll++) {
        await page.waitForTimeout(250);
        check = await verifyCommitted();
      }
    }
    if (check.verified === false) {
      throw new Error(
        `Service line for ${procedureCode} (charge $${chargeAmount}, ${units} units) did not commit after ${retryWaits.length + 1} Add attempts - portal Total Charged Amount shows $${check.portalTotal}, expected $${expectedRunningTotal.toFixed(2)}. Stopping rather than submit an incomplete claim.`
      );
    }

    if (verifiedModifiers.length) {
      const committedModifierProof = await page.evaluate(({ procedureCode, modifiers }) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        return rows.some(row => {
          const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').toUpperCase();
          return text.includes(procedureCode.toUpperCase()) && modifiers.every(modifier => text.includes(modifier));
        });
      }, { procedureCode, modifiers: verifiedModifiers }).catch(() => false);
      if (!committedModifierProof) {
        throw new Error(
          `BLOCKED_MODIFIER_COMMIT_UNVERIFIED: ${procedureCode} was added, but HCPF did not display modifier ${verifiedModifiers.join(', ')} on the committed service line. Submit was not clicked.`
        );
      }
    }
    console.log(`Service line ${procedureCode} commit check: CONFIRMED - portal total $${check.portalTotal}, expected $${expectedRunningTotal.toFixed(2)}.`);
  }

  // === FIXED === Base (trip) units previously came ONLY from
  // claim.isRoundTrip (always 1 or 2), completely ignoring any explicit
  // unit count the app sent - this is exactly why a correctly-computed
  // app-side unit count never reached the real claim. Now: an explicit
  // value is used if provided, falling back to the old round-trip-based
  // logic only when genuinely absent.
  const baseCharge = rates.baseRate.charge_amount * baseUnits;
  await fillServiceLine(
    rates.baseRate.procedure_code,
    baseCharge,
    baseUnits,
    rates.baseRate.place_of_service,
    claim.modifiersByProcedure?.[rates.baseRate.procedure_code] || []
  );

  // === FIXED === Mileage previously came ONLY from
  // (dropoffOdometer - pickupOdometer) on whatever raw odometer pair was
  // sent - ignoring any explicit, already-correct mileage figure the app
  // computed (e.g. summed across individual round-trip legs, excluding
  // the gap between them). Now: an explicit value is used if provided,
  // falling back to the odometer-derived calculation only when absent.
  if (loadedMiles !== null) {
    const mileageCharge = rates.mileageRate.charge_amount * loadedMiles;
    await fillServiceLine(
      rates.mileageRate.procedure_code,
      mileageCharge,
      loadedMiles,
      rates.mileageRate.place_of_service,
      claim.modifiersByProcedure?.[rates.mileageRate.procedure_code] || []
    );
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
          await page.waitForTimeout(400);
          // Verify it's actually expanded now; if still hidden, click once more.
          const stillHidden = await page.locator(sel3.attachmentTypeDropdown).last().isHidden().catch(() => true);
          if (stillHidden) {
            await page.locator(sel3.attachmentToggleIcon).last().click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(400);
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

      if (!addSucceeded) {
        throw new Error('BLOCKED_ATTACHMENT_NOT_COMMITTED: HCPF did not accept the trip report attachment. Submit was not clicked.');
      }

      await afterPostback(page);
      await page.waitForTimeout(400);
      const attachmentCommitted = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr'));
        return rows.some(row => {
          const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
          return /AM[-\s]?Ambulance Certification/i.test(text) && !/Click to add attachment/i.test(text);
        });
      }).catch(() => false);
      if (!attachmentCommitted) {
        throw new Error('BLOCKED_ATTACHMENT_NOT_COMMITTED: the Add action returned, but HCPF did not display the committed trip report. Submit was not clicked.');
      }
      console.log('ATTACHMENT_V2_MARKER: attachment commit CONFIRMED.');

    } else {
      throw new Error('BLOCKED_ATTACHMENT_UPLOAD_FAILED: the signed trip report could not be loaded into HCPF. Submit was not clicked.');
    }
  } else {
    if (mode === 'confirm_submit') {
      throw new Error('BLOCKED_MISSING_TRIP_REPORT: no signed trip report PDF was available. Submit was not clicked.');
    }
    console.log('ATTACHMENT_V2_MARKER: no tripReportFilePath in non-submit mode.');
  }

  if (mode === 'confirm_submit') {
    console.log('CONFIRM_SUBMIT: clicking Submit.');
    await current(sel3.submitButton).click({ timeout: 8000 });
    await afterPostback(page);
    await page.waitForURL(/ConfirmProfessionalClaim/i, { timeout: 12000 }).catch(() => {});
    const onConfirmPage = /ConfirmProfessionalClaim/i.test(page.url())
      || await page.getByText(/Confirm Professional Claim/i).isVisible().catch(() => false);
    if (!onConfirmPage) {
      throw new Error(`Did not reach Confirm page after Submit click. Current URL: ${page.url()}`);
    }

    console.log('CONFIRM_SUBMIT: on Confirm page, clicking real Confirm button.');
    const sniffer = attachClaimIdSniffer(page);
    let confirmClickError = null;
    const confirmButton = page.locator('[id$="ConfirmCmnButton"]').last();
    try {
      if (await confirmButton.count()) {
        await confirmButton.click({ timeout: 8000 });
      } else {
        await page.getByRole('button', { name: /^confirm$/i }).last().click({ timeout: 8000 });
      }
    } catch (err) {
      confirmClickError = err;
      console.log(`CONFIRM_SUBMIT: Confirm click reported an error (${err.message}) - still reading the page for a Claim ID.`);
    }
    await afterPostback(page);

    let receipt = await waitForClaimReceipt(page, {
      timeoutMs: 12000,
      overheardId: sniffer.state.claimId
    });
    sniffer.stop();

    if (!receipt.claimId) {
      console.log('CONFIRM_SUBMIT: success page had no Claim ID — searching HCPF in this same session.');
      const recovered = await findExistingPortalClaim(page, config, claim);
      if (recovered && recovered.claim_id) {
        receipt = {
          claimId: recovered.claim_id,
          dump: receipt.dump,
          source: 'portal_search'
        };
      }
    }

    await page.screenshot({ path: `${__dirname}/../last-run-success.png`, fullPage: true }).catch(() => {});
    const rawDump = receipt.dump || {};
    const bodyForStatus = rawDump.bodyTextFull || '';
    const postConfirmDump = {
      pageTitle: rawDump.pageTitle || null,
      url: rawDump.url || null,
      confirmationCandidates: rawDump.confirmationCandidates || [],
      bodyTextFull: String(bodyForStatus).slice(0, 4000)
    };
    const isSuspended = /status is Suspended/i.test(bodyForStatus);

    if (!receipt.claimId) {
      console.log(`CONFIRM_SUBMIT: no Claim ID on the page or in Search Claims${confirmClickError ? ` (click error: ${confirmClickError.message})` : ''}.`);
      return {
        status: 'SUBMITTED_UNVERIFIED',
        message: 'Confirm was attempted but no Claim ID could be read from the success page or Search Claims. Do NOT resubmit. Use /reconcile-claim.',
        post_confirm_dump: postConfirmDump
      };
    }

    console.log(`CONFIRM_SUBMIT: complete. Claim ID = ${receipt.claimId} via ${receipt.source}, suspended = ${isSuspended}.`);
    return {
      status: 'SUBMITTED',
      message: `Claim submitted successfully. Claim ID: ${receipt.claimId}.`,
      claim_id: receipt.claimId,
      claim_id_source: receipt.source,
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
    await afterPostback(page);

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

  try {
    const modifierPlan = validateCorrectionModifierPlan(tripRecord, [
      rates.baseRate.procedure_code,
      rates.mileageRate.procedure_code
    ]);
    mapped.claim.modifiersByProcedure = modifierPlan.modifiersByProcedure;
    mapped.claim.correctionModifierProofRequired = modifierPlan.required;
  } catch (err) {
    return { status: 'BLOCKED_MODIFIER_PREFLIGHT', reason: err.message, claim: mapped.claim };
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

  const accountKey = `${mapped.claim.providerId || 'unknown'}::${tripRecord.company_id || 'default'}`;
  const { browser, page } = await openAuthenticatedPortal({
    chromium,
    config,
    credentials: portalCredentials,
    accountKey
  });

  const INTERNAL_TIMEOUT_MS = 8 * 60 * 1000;
  const internalTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Internal timeout after ${INTERNAL_TIMEOUT_MS / 1000}s - aborting and closing browser.`)), INTERNAL_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([
      (async () => {
        if (mode === 'confirm_submit') {
          const already = await findExistingPortalClaim(page, config, mapped.claim);
          if (already && already.claim_id) {
            console.log(`PRECHECK: claim already on file for ${mapped.claim.memberId} ${mapped.claim.tripDate}: ${already.claim_id}`);
            return {
              status: 'ALREADY_ON_FILE',
              message: `HCPF already has claim ${already.claim_id} for this member and service date. Submit was not clicked.`,
              claim_id: already.claim_id,
              portal_status: already.status || null
            };
          }
        }

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

async function parseClaimDetailPage(page) {
  const raw = await page.evaluate(() => {
    const clean = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('tr'));

    function pairedValue(label) {
      const wanted = clean(label).toLowerCase();
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll(':scope > th, :scope > td'));
        for (let index = 0; index < cells.length; index++) {
          if (clean(cells[index].innerText || cells[index].textContent).toLowerCase() === wanted) {
            for (let next = index + 1; next < cells.length; next++) {
              const candidate = clean(cells[next].innerText || cells[next].textContent);
              if (candidate) return candidate;
            }
          }
        }
      }
      return null;
    }

    function headerMap(table) {
      const header = Array.from(table.querySelectorAll('tr')).find(row => {
        const text = clean(row.innerText || row.textContent).toLowerCase();
        return text.includes('eob') || text.includes('procedure code');
      });
      if (!header) return { header: null, indices: {} };
      const indices = {};
      Array.from(header.querySelectorAll('th, td')).forEach((cell, index) => {
        const name = clean(cell.innerText || cell.textContent).toLowerCase();
        if (name) indices[name] = index;
      });
      return { header, indices };
    }

    const tables = Array.from(document.querySelectorAll('table'));
    const adjudicationTable = tables.find(table => {
      const text = clean(table.innerText || table.textContent).toLowerCase();
      return text.includes('eob') && text.includes('description') && (text.includes('header') || text.includes('detail'));
    });
    const adjudicationErrors = [];
    if (adjudicationTable) {
      const { header, indices } = headerMap(adjudicationTable);
      const entries = Object.entries(indices);
      const indexFor = matcher => entries.find(([name]) => matcher.test(name))?.[1];
      const eobIndex = indexFor(/^eob$/i);
      const descriptionIndex = indexFor(/description/i);
      const levelIndex = indexFor(/header|detail/i);
      for (const row of adjudicationTable.querySelectorAll('tr')) {
        if (row === header) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        const eob = eobIndex === undefined ? null : clean(cells[eobIndex]?.innerText || cells[eobIndex]?.textContent);
        const description = descriptionIndex === undefined ? null : clean(cells[descriptionIndex]?.innerText || cells[descriptionIndex]?.textContent);
        if (eob || description) {
          adjudicationErrors.push({
            level: levelIndex === undefined ? null : clean(cells[levelIndex]?.innerText || cells[levelIndex]?.textContent),
            eob_code: eob,
            description
          });
        }
      }
    }

    const serviceTable = tables.find(table => {
      const text = clean(table.innerText || table.textContent).toLowerCase();
      return text.includes('procedure code') && text.includes('units') && text.includes('charge amount');
    });
    const serviceLines = [];
    if (serviceTable) {
      const { header, indices } = headerMap(serviceTable);
      const entries = Object.entries(indices);
      const indexFor = matcher => entries.find(([name]) => matcher.test(name))?.[1];
      const fields = {
        from_date: indexFor(/^from date$/i),
        to_date: indexFor(/^to date$/i),
        place_of_service: indexFor(/place of service/i),
        procedure_code: indexFor(/procedure code/i),
        modifier: indexFor(/^mod$/i),
        units: indexFor(/^units$/i),
        charge_amount: indexFor(/charge amount/i),
        allowed_amount: indexFor(/allowed amount/i)
      };
      for (const row of serviceTable.querySelectorAll('tr')) {
        if (row === header) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        const line = Object.fromEntries(Object.entries(fields).map(([name, index]) => [
          name,
          index === undefined ? null : clean(cells[index]?.innerText || cells[index]?.textContent)
        ]));
        if (line.procedure_code) serviceLines.push(line);
      }
    }

    const heading = clean(document.querySelector('h1, h2, [class*="title" i]')?.innerText || '');
    const body = document.body.innerText || '';
    const claimId = (heading.match(/ID\s+(\d+)/i) || body.match(/View Professional Claim\s*-?\s*ID\s+(\d+)/i))?.[1] || null;

    return {
      claim_id: claimId,
      raw_status: pairedValue('Claim Status'),
      total_charged_amount: pairedValue('Total Charged Amount'),
      total_allowed_amount: pairedValue('Total Allowed Amount'),
      total_paid_amount: pairedValue('Total Paid Amount'),
      service_date: pairedValue('Date of Current'),
      adjudication_errors: adjudicationErrors,
      service_lines: serviceLines
    };
  });

  return {
    ...raw,
    status: normalizeHcpfStatus(raw.raw_status),
    charged_amount: parseMoney(raw.total_charged_amount),
    allowed_amount: parseMoney(raw.total_allowed_amount),
    paid_amount: parseMoney(raw.total_paid_amount),
    denial_reasons: raw.adjudication_errors
  };
}

async function searchClaims(companyId, memberId, serviceDate, claimId, billingId, providerId) {
  const config = loadConfig(`${__dirname}/../config/hcpf-colorado.json`);
  const portalCredentials = await fetchPortalCredentials('hfc-colorado', companyId || null);

  if (!memberId && !claimId && !billingId) {
    throw new Error('INVALID_SEARCH_CRITERIA: At least one of member_id, claim_id, or billing_id must be provided');
  }

  const { browser, page } = await openAuthenticatedPortal({
    chromium,
    config,
    credentials: portalCredentials,
    accountKey: `${providerId || 'unknown'}::${companyId || 'default'}`
  });

  const SEARCH_TIMEOUT_MS = 2 * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`)), SEARCH_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([
      (async () => {
        await gotoSearchClaimsPage(page, config);
        await fillSearchCriteria(page, { memberId, serviceDate, claimId });
        const claimsData = await readSearchResultRows(page);

        claimsData.claims = (claimsData.claims || []).map(claim => ({
          ...claim,
          normalized_status: normalizeHcpfStatus(claim.status),
          paid_amount_value: parseMoney(claim.paid_amount),
          charge_value: parseMoney(claim.charge)
        }));

        let claim_detail = null;
        if (claimId) {
          const exactLink = page.getByText(String(claimId), { exact: true }).last();
          if (await exactLink.isVisible().catch(() => false)) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
              exactLink.click({ timeout: 10000 })
            ]);
            await page.waitForTimeout(400);
            claim_detail = await parseClaimDetailPage(page);
          }
        }

        await page.screenshot({ path: `${__dirname}/../last-run-success.png`, fullPage: true }).catch(() => {});

        return {
          status: 'SEARCH_COMPLETE',
          search_url: page.url(),
          results: claimsData,
          claim_detail
        };
      })(),
      timeoutPromise
    ]);
    return result;
  } catch (err) {
    await page.screenshot({ path: `${__dirname}/../last-run-error.png`, fullPage: true }).catch(() => {});
    console.error(`Search failed: ${err.message}`);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Backward-compatible read-only discovery entry point used by the older
 * /discover-search-claims route. It delegates to the same hardened search
 * implementation and can never enter the submission workflow.
 */
async function discoverSearchClaims(companyId, testClaim = {}) {
  const criteria = testClaim && typeof testClaim === 'object' ? testClaim : {};
  return searchClaims(
    companyId || null,
    criteria.member_id || criteria.medicaid_member_id || null,
    criteria.service_date || criteria.date_of_service || null,
    criteria.claim_id || null,
    criteria.billing_id || null,
    criteria.provider_id || null
  );
}

module.exports = { run, mapTripToClaim, fetchBillingRate, fetchBillingRates, discoverSearchClaims, searchClaims };
