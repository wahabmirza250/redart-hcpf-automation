'use strict';

const fs = require('fs');
const path = require('path');
const { afterPostback } = require('./portalWait');

const BLOCK_PATTERNS = [
  /account (has been )?(locked|disabled|deactivated|suspended)/i,
  /too many (failed )?(login|attempts)/i,
  /try again (later|tomorrow|in 24)/i,
  /access denied/i,
  /your (user )?account is (locked|suspended|inactive)/i,
  /unusual (sign-?in )?activity/i,
  /temporarily (blocked|unavailable|locked)/i,
  /verification (code|required)|captcha/i
];

function accountStatusText(text) {
  // HCPF displays this educational notice on its authenticated home page.
  // Remove only the complete known notice, not arbitrary lockout messages.
  return String(text || '').replace(/Unlock a User Account:\s*A user may become temporarily locked out\.\s*This is commonly due to multiple attempts using wrong password\.\s*The account will automatically unlock after approximately 15 minutes, at which point the user may attempt to log in again using the correct credentials\./gi, '');
}

function textLooksBlocked(text) {
  return BLOCK_PATTERNS.some(re => re.test(accountStatusText(text)));
}

// Report the rule, never the page body: portal pages can contain member data.
function blockedRule(signals) {
  for (const source of ['title', 'body']) {
    const index = BLOCK_PATTERNS.findIndex(re => re.test(accountStatusText(signals[source])));
    if (index >= 0) return `${source}:rule-${index + 1}`;
  }
  return null;
}

function classifyPortalPage(signals = {}) {
  if (/you did not log\s*off your previous session/i.test(signals.body || '')) {
    return { ok: false, code: 'PORTAL_SESSION_ACTIVE', detail: 'The portal says the previous session was not logged out. Sign out of that portal session or let it expire before reconnecting. No claim was submitted by this login attempt.' };
  }
  const rule = blockedRule(signals);
  if (rule) {
    return {
      ok: false,
      code: 'PORTAL_BLOCKED',
      detail: `Portal lockout or access block detected (${rule}). Stop. Do not retry from this robot today.`
    };
  }
  if (signals.hasPassword) {
    return {
      ok: false,
      code: 'POST_LOGIN_NOT_AUTHENTICATED',
      detail: 'Login form still visible; session is not authenticated.'
    };
  }
  if (!signals.claimsTextCount) {
    return {
      ok: false,
      code: 'POST_LOGIN_NO_CLAIMS_MENU',
      detail: 'Provider dashboard did not expose the Claims menu.'
    };
  }
  return { ok: true, code: 'AUTHENTICATED' };
}

async function readPortalSignals(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2000),
    hasPassword: !!document.querySelector('input[type="password"]'),
    claimsTextCount: Array.from(document.querySelectorAll('a, button, span, div, li'))
      .filter(el => (el.textContent || '').trim() === 'Claims').length
  }));
}

function sessionPathFor(accountKey, dir) {
  const safe = String(accountKey || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(dir, `${safe}.json`);
}

function sessionAgeMs(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sessionDir() {
  const dir = process.env.PORTAL_SESSION_DIR || path.join(process.cwd(), 'data', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionTtlMs() {
  const parsed = Number(process.env.PORTAL_SESSION_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8 * 60 * 60 * 1000;
}

async function loginOnPage(page, config, credentials) {
  const before = classifyPortalPage(await readPortalSignals(page));
  if (['PORTAL_SESSION_ACTIVE', 'PORTAL_BLOCKED'].includes(before.code)) {
    throw new Error(`${before.code}: ${before.detail}`);
  }
  const passwordVisible = await page.locator(config.selectors.login.passwordField).first().isVisible().catch(() => false);
  if (!passwordVisible) return;
  await page.fill(config.selectors.login.usernameField, credentials.username);
  await page.fill(config.selectors.login.passwordField, credentials.password);
  // Let the portal's normal change/blur validation enable its submit control.
  await page.locator(config.selectors.login.passwordField).first().press('Tab');
  try {
    await page.click(config.selectors.login.submitButton);
  } catch (err) {
    const status = classifyPortalPage(await readPortalSignals(page));
    if (['PORTAL_SESSION_ACTIVE', 'PORTAL_BLOCKED'].includes(status.code)) {
      throw new Error(`${status.code}: ${status.detail}`);
    }
    throw err;
  }
  await afterPostback(page, { ready: 'text=Claims', timeout: 15000 });
}

// Closing Chromium alone does not end an HCPF server session. Use the
// portal's own Logout control, and retain the latest cookies if logout fails.
async function closePortalSession({ browser, context, page, sessPath, config }) {
  let loggedOut = false;
  try {
    // The portal renders Logout as a text control, not consistently an ARIA link.
    const logout = page.getByText(/^log\s*(out|off)$/i).last();
    if (await logout.isVisible()) {
      await logout.click({ timeout: 10000 });
      for (const frame of page.frames()) {
        const confirmation = frame.getByText('Are you sure you want to logout?', { exact: true });
        const asksToLogout = await confirmation.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
        if (asksToLogout) {
          await frame.getByText('OK', { exact: true }).last().click({ timeout: 10000 });
          console.log('PORTAL_LOGOUT_CONFIRMED');
          break;
        }
      }
      await page.locator(config.selectors.login.passwordField).first().waitFor({ state: 'visible', timeout: 15000 });
      const status = classifyPortalPage(await readPortalSignals(page));
      loggedOut = status.code === 'POST_LOGIN_NOT_AUTHENTICATED';
    }
    if (loggedOut) fs.rmSync(sessPath, { force: true });
    else await context.storageState({ path: sessPath });
  } catch (err) {
    console.warn('PORTAL_LOGOUT_FAILURE:', String(err.message || '').split('\n')[0]);
    await context.storageState({ path: sessPath }).catch(() => {});
  } finally {
    if (!loggedOut) {
      await page.screenshot({ path: path.join(process.cwd(), 'last-run-error.png'), fullPage: true }).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
  if (!loggedOut) console.warn('PORTAL_LOGOUT_UNVERIFIED: Saved session retained for recovery.');
  return { loggedOut };
}

/**
 * Reuse a saved HCPF cookie jar when it is still valid so we are not
 * logging in from a blank profile on every claim (that is what locks the
 * account overnight). Never retries through a lockout page.
 */
async function openAuthenticatedPortal({ chromium, config, credentials, accountKey }) {
  const dir = sessionDir();
  const sessPath = sessionPathFor(accountKey, dir);
  const ttl = sessionTtlMs();
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  let activePage;
  async function newPage(storageState) {
    const context = await browser.newContext({
      userAgent,
      storageState: storageState || undefined
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    activePage = page;
    return { context, page };
  }

  async function finish(context, page, reusedSession) {
    const signals = await readPortalSignals(page);
    const classified = classifyPortalPage(signals);
    if (!classified.ok) {
      await page.screenshot({ path: path.join(process.cwd(), 'last-run-error.png'), fullPage: true }).catch(() => {});
      await browser.close().catch(() => {});
      throw new Error(`${classified.code}: ${classified.detail}`);
    }
    await context.storageState({ path: sessPath }).catch(() => {});
    return sessionResult(context, page, reusedSession, signals);
  }

  function sessionResult(context, page, reusedSession, signals) {
    return { browser, context, page, reusedSession, signals,
      close: () => closePortalSession({ browser, context, page, sessPath, config }) };
  }

  try {
  if (fs.existsSync(sessPath) && sessionAgeMs(sessPath) < ttl) {
    const { context, page } = await newPage(sessPath);
    await page.goto(config.loginUrl || config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const signals = await readPortalSignals(page);
    if (textLooksBlocked(signals.body) || textLooksBlocked(signals.title)) {
      // Use the same failure path so a reused session also saves evidence.
      return await finish(context, page, false);
    }
    if (!signals.hasPassword && signals.claimsTextCount) {
      console.log('PORTAL_SESSION_REUSED', accountKey);
      await context.storageState({ path: sessPath }).catch(() => {});
      return sessionResult(context, page, true, signals);
    }
    if (classifyPortalPage(signals).code === 'PORTAL_SESSION_ACTIVE') {
      // This notice is already present before entering any credentials.
      // Follow its close-browser instruction for this stale saved context,
      // then allow exactly one normal login from a clean context. A fresh
      // rejection or actual account lockout is never retried.
      await context.close();
      fs.rmSync(sessPath, { force: true });
      console.log('PORTAL_STALE_CONTEXT_DISCARDED');
    } else {
      await loginOnPage(page, config, credentials);
      return await finish(context, page, false);
    }
  }

  const { context, page } = await newPage();
  await page.goto(config.loginUrl || config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await loginOnPage(page, config, credentials);
  return await finish(context, page, false);
  } catch (err) {
    err.portalStage = 'login';
    err.submitReached = false;
    await activePage?.screenshot({ path: path.join(process.cwd(), 'last-run-error.png'), fullPage: true }).catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = {
  BLOCK_PATTERNS,
  textLooksBlocked,
  classifyPortalPage,
  readPortalSignals,
  sessionPathFor,
  sessionAgeMs,
  sessionDir,
  openAuthenticatedPortal,
  closePortalSession,
  loginOnPage
};
