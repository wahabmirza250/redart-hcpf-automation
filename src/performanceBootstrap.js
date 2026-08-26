/*
 * RedArt HCPF robot speed/stability bootstrap.
 *
 * Fail-closed: every replacement must match the known source exactly. If the
 * source changes, startup aborts rather than silently applying a partial patch.
 * Submit/Confirm, idempotency, tenant/account isolation and ambiguous-outcome
 * safety are intentionally untouched here.
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
    'const delays = [200, 400, 800];\n    const actionTimeout = 5000;\n    const readTimeout = 2000;',
    'masked-date-retry-budget',
  );

  source = replaceExactly(
    source,
    `      const field = current(selector);\n      await field.click({ timeout: actionTimeout }).catch(() => {});\n      await page.waitForTimeout(200);\n      const existing = await field.inputValue({ timeout: readTimeout }).catch(() => '');\n      if (existing && existing.trim() !== '') {\n        await field.click({ clickCount: 3 }).catch(() => {});\n        await page.keyboard.press('Delete').catch(() => {});\n        await page.waitForTimeout(150);\n      }\n      await field.pressSequentially(digitsOnly, { delay: 70 }).catch(() => {});\n      await page.keyboard.press('Tab').catch(() => {});\n      await page.waitForTimeout(400);\n\n      const finalValue = await field.inputValue({ timeout: readTimeout }).catch(() => '');`,
    `      // HCPF keeps hidden/template copies of service-line date inputs after\n      // ASP.NET partial postbacks. Using locator(...).last() can target a hidden\n      // copy while the real visible S0215 field stays blank. Always choose the\n      // currently visible input and re-resolve it after blur/postback.\n      const visibleSelector = selector + ':visible';\n      let field = page.locator(visibleSelector).last();\n      const visibleCount = await page.locator(visibleSelector).count().catch(() => 0);\n      if (visibleCount < 1) field = current(selector);\n      const targetId = await field.getAttribute('id').catch(() => null);\n      console.log('MASKED_DATE_TARGET:', targetId || 'unknown', 'visibleMatches=', visibleCount);\n\n      await field.scrollIntoViewIfNeeded({ timeout: actionTimeout }).catch(() => {});\n      await field.click({ timeout: actionTimeout }).catch(() => {});\n      await page.keyboard.press('Control+A').catch(() => {});\n      await page.keyboard.press('Delete').catch(() => {});\n      await page.waitForTimeout(80);\n      await field.pressSequentially(digitsOnly, { delay: 45 }).catch(() => {});\n      await page.keyboard.press('Tab').catch(() => {});\n      await page.waitForTimeout(250);\n\n      let liveField = page.locator(visibleSelector).last();\n      if ((await page.locator(visibleSelector).count().catch(() => 0)) < 1) liveField = current(selector);\n      let finalValue = await liveField.inputValue({ timeout: readTimeout }).catch(() => '');\n      let finalDigits = finalValue.replace(/\\D/g, '');\n\n      // Conservative fallback for the ASP.NET MaskedEditExtender: set the\n      // visible live input through the native value setter and dispatch the\n      // same events the portal listens for. We verify readback before allowing\n      // the flow to continue, so this cannot silently skip a required date.\n      if (finalDigits !== digitsOnly) {\n        await liveField.evaluate((el, digits) => {\n          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;\n          if (setter) setter.call(el, digits); else el.value = digits;\n          el.dispatchEvent(new Event('input', { bubbles: true }));\n          el.dispatchEvent(new Event('change', { bubbles: true }));\n          el.dispatchEvent(new Event('blur', { bubbles: true }));\n        }, digitsOnly).catch(() => {});\n        await page.waitForTimeout(250);\n        liveField = page.locator(visibleSelector).last();\n        if ((await page.locator(visibleSelector).count().catch(() => 0)) < 1) liveField = current(selector);\n        finalValue = await liveField.inputValue({ timeout: readTimeout }).catch(() => '');\n      }`,
    'masked-date-visible-live-field',
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

console.log('PERFORMANCE_BOOTSTRAP: visible-live masked-date targeting enabled.');
require('./server');
