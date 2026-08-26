/*
 * RedArt HCPF robot speed/stability bootstrap.
 *
 * This is intentionally fail-closed: every replacement must match the
 * known production source exactly. If the source changes, startup aborts
 * instead of silently applying a partial performance patch.
 *
 * Safety behavior is NOT changed here: Submit/Confirm handling, account
 * isolation, idempotency, ambiguous-outcome handling, and claim payloads
 * are untouched. This only removes excessive pacing/wait time introduced
 * during high-concurrency crash hardening.
 */
const fs = require('fs');
const path = require('path');

function replaceExactly(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`Performance patch ${label} expected exactly 1 match, found ${count}. Refusing to start.`);
  }
  return source.replace(before, after);
}

function patchFile(filePath, patcher) {
  const original = fs.readFileSync(filePath, 'utf8');
  const patched = patcher(original);
  if (patched === original) {
    throw new Error(`Performance patch made no changes to ${filePath}. Refusing to start.`);
  }
  fs.writeFileSync(filePath, patched, 'utf8');
}

const serverPath = path.join(__dirname, 'server.js');
const claimPath = path.join(__dirname, 'submitClaim.js');

patchFile(serverPath, (source) => {
  source = replaceExactly(
    source,
    'const MIN_SESSION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes',
    "const MIN_SESSION_COOLDOWN_MS = Math.max(0, Number(process.env.MIN_SESSION_COOLDOWN_MS || 5000)); // default 5 seconds",
    'session-cooldown',
  );
  return source;
});

patchFile(claimPath, (source) => {
  source = replaceExactly(
    source,
    'const delays = [300, 600, 1000, 1500, 2500, 4000, 5500, 7000, 8000];\n    const actionTimeout = 15000; // was 8000 - individual clicks can also be slow under load\n    const readTimeout = 6000; // was 3000',
    'const delays = [200, 400, 800];\n    const actionTimeout = 5000; // fast bounded retry; fail safely instead of hanging for minutes\n    const readTimeout = 2000;',
    'masked-date-retry-budget',
  );

  // ASP.NET MaskedEditExtender may replace the input node on blur/postback.
  // The old code typed into one locator, pressed Tab, then read that SAME
  // locator back. After a postback that locator is stale and can read as an
  // empty value even when the new live input accepted the date. Re-resolve
  // the live field after blur and use explicit keyboard focus/selection.
  source = replaceExactly(
    source,
    `      const field = current(selector);\n      await field.click({ timeout: actionTimeout }).catch(() => {});\n      await page.waitForTimeout(200);\n      const existing = await field.inputValue({ timeout: readTimeout }).catch(() => '');\n      if (existing && existing.trim() !== '') {\n        await field.click({ clickCount: 3 }).catch(() => {});\n        await page.keyboard.press('Delete').catch(() => {});\n        await page.waitForTimeout(150);\n      }\n      await field.pressSequentially(digitsOnly, { delay: 70 }).catch(() => {});\n      await page.keyboard.press('Tab').catch(() => {});\n      await page.waitForTimeout(400);\n\n      const finalValue = await field.inputValue({ timeout: readTimeout }).catch(() => '');`,
    `      const field = current(selector);\n      await field.scrollIntoViewIfNeeded({ timeout: actionTimeout }).catch(() => {});\n      await field.focus({ timeout: actionTimeout }).catch(() => {});\n      await page.waitForTimeout(100);\n      await page.keyboard.press('Control+A').catch(() => {});\n      await page.keyboard.press('Delete').catch(() => {});\n      await page.waitForTimeout(100);\n      await page.keyboard.type(digitsOnly, { delay: 35 }).catch(() => {});\n      await page.keyboard.press('Tab').catch(() => {});\n      await page.waitForTimeout(300);\n\n      // IMPORTANT: blur can trigger an ASP.NET partial postback that replaces\n      // the input node. Always resolve the current live field before readback.\n      const liveField = current(selector);\n      const finalValue = await liveField.inputValue({ timeout: readTimeout }).catch(() => '');`,
    'masked-date-live-readback',
  );

  source = replaceExactly(
    source,
    "await page.waitForTimeout(4000);\n\n    // === REAL COMMIT VERIFICATION",
    "await page.waitForTimeout(1500);\n\n    // === REAL COMMIT VERIFICATION",
    'service-line-initial-wait',
  );

  source = replaceExactly(
    source,
    'const retryWaits = [3000, 4000, 5000, 6000];',
    'const retryWaits = [1200, 2200, 4000];',
    'service-line-retry-waits',
  );

  source = replaceExactly(
    source,
    'async function attachmentActionWithRetry(actionFn, label, maxAttempts = 5) {\n      for (let attempt = 0; attempt < maxAttempts; attempt++) {\n        try {',
    "async function attachmentActionWithRetry(actionFn, label, maxAttempts = 3) {\n      for (let attempt = 0; attempt < maxAttempts; attempt++) {\n        const hiddenBeforeAction = await page.locator(sel3.attachmentTypeDropdown).last().isHidden().catch(() => true);\n        if (hiddenBeforeAction) {\n          await page.locator(sel3.attachmentToggleIcon).last().click({ timeout: 2000 }).catch(() => {});\n          await page.waitForTimeout(400);\n        }\n        try {",
    'attachment-proactive-expand',
  );

  source = replaceExactly(
    source,
    'await page.waitForTimeout(1200);\n          // Verify it\'s actually expanded now; if still hidden, click once more.',
    'await page.waitForTimeout(400);\n          // Verify it\'s actually expanded now; if still hidden, click once more.',
    'attachment-expand-wait-1',
  );

  source = replaceExactly(
    source,
    'await page.waitForTimeout(1200);\n          }\n        }\n      }',
    'await page.waitForTimeout(400);\n          }\n        }\n      }',
    'attachment-expand-wait-2',
  );

  return source;
});

console.log('PERFORMANCE_BOOTSTRAP: applied safe speed/stability tuning with live masked-date readback.');
require('./server');
