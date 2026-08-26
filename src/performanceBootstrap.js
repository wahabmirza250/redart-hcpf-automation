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
  // Old crash-hardening forced every account to sit idle for 2 minutes
  // after a session. Keep a small configurable gap for stability without
  // destroying throughput. Default 5 seconds; can be raised instantly via
  // Railway env without a code deploy.
  source = replaceExactly(
    source,
    'const MIN_SESSION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes',
    "const MIN_SESSION_COOLDOWN_MS = Math.max(0, Number(process.env.MIN_SESSION_COOLDOWN_MS || 5000)); // default 5 seconds",
    'session-cooldown',
  );
  return source;
});

patchFile(claimPath, (source) => {
  // The 8-concurrent load-test tuning made a bad masked date field consume
  // minutes. Normal RedArt production is capped below that, so use short,
  // bounded retries and fail safely instead of waiting toward 480 seconds.
  source = replaceExactly(
    source,
    'const delays = [300, 600, 1000, 1500, 2500, 4000, 5500, 7000, 8000];\n    const actionTimeout = 15000; // was 8000 - individual clicks can also be slow under load\n    const readTimeout = 6000; // was 3000',
    'const delays = [200, 400, 800];\n    const actionTimeout = 5000; // fast bounded retry; fail safely instead of hanging for minutes\n    const readTimeout = 2000;',
    'masked-date-retry-budget',
  );

  // Remove a full four-second fixed wait after every service-line Add.
  // Verification still reads the portal total and retries if it did not
  // commit; we are only shortening idle time before that verification.
  source = replaceExactly(
    source,
    "await page.waitForTimeout(4000);\n\n    // === REAL COMMIT VERIFICATION",
    "await page.waitForTimeout(1500);\n\n    // === REAL COMMIT VERIFICATION",
    'service-line-initial-wait',
  );

  // Keep commit verification, but make it responsive. Three retries remain,
  // with increasing waits; a failed line still aborts before Submit.
  source = replaceExactly(
    source,
    'const retryWaits = [3000, 4000, 5000, 6000];',
    'const retryWaits = [1200, 2200, 4000];',
    'service-line-retry-waits',
  );

  // Attachment handling currently burns several seconds waiting on a hidden
  // dropdown before it even tries to expand the panel. Check/expand first and
  // keep retries bounded. Attachment failures remain non-submission data only;
  // this does not touch Submit/Confirm.
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

console.log('PERFORMANCE_BOOTSTRAP: applied safe speed/stability tuning.');
require('./server');
