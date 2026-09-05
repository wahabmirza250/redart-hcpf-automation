'use strict';

const fs = require('fs');
const path = require('path');

const BLOCK_PATTERNS = [
  /account (has been )?(locked|disabled|deactivated|suspended)/i,
  /too many (failed )?(login|attempts)/i,
  /try again (later|tomorrow|in 24)/i,
  /access denied/i,
  /your (user )?account is (locked|suspended|inactive)/i,
  /unusual (sign-?in )?activity/i,
  /temporarily (blocked|unavailable|locked)/i,
  /please contact (support|the help desk|your administrator)/i,
  /verification (code|required)|captcha/i
];

function textLooksBlocked(text) {
  return BLOCK_PATTERNS.some(re => re.test(String(text || '')));
}

function classifyPortalPage(signals = {}) {
  if (textLooksBlocked(signals.body) || textLooksBlocked(signals.title)) {
    return {
      ok: false,
      code: 'PORTAL_BLOCKED',
      detail: 'Portal lockout or access block detected. Stop. Do not retry from this robot today.'
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
  const passwordVisible = await page.locator(config.selectors.login.passwordField).first().isVisible().catch(() => false);
  if (!passwordVisible) return;
  await page.fill(config.selectors.login.usernameField, credentials.username);
  await page.waitForTimeout(250);
  await page.fill(config.selectors.login.passwordField, credentials.password);
  await page.waitForTimeout(200);
  await page.click(config.selectors.login.submitButton);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
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

  async function newPage(storageState) {
    const context = await browser.newContext({
      userAgent,
      storageState: storageState || undefined
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    return { context, page };
  }

  async function finish(context, page, reusedSession) {
    const signals = await readPortalSignals(page);
    const classified = classifyPortalPage(signals);
    if (!classified.ok) {
      fs.rmSync(sessPath, { force: true });
      await page.screenshot({ path: path.join(process.cwd(), 'last-run-error.png'), fullPage: true }).catch(() => {});
      await browser.close().catch(() => {});
      throw new Error(`${classified.code}: ${classified.detail}`);
    }
    await context.storageState({ path: sessPath }).catch(() => {});
    return { browser, context, page, reusedSession, signals };
  }

  if (fs.existsSync(sessPath) && sessionAgeMs(sessPath) < ttl) {
    const { context, page } = await newPage(sessPath);
    await page.goto(config.loginUrl || config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const signals = await readPortalSignals(page);
    if (textLooksBlocked(signals.body) || textLooksBlocked(signals.title)) {
      fs.rmSync(sessPath, { force: true });
      await browser.close().catch(() => {});
      throw new Error('PORTAL_BLOCKED: Portal reported a lockout or access block. Stop. Do not retry from this robot today.');
    }
    if (!signals.hasPassword && signals.claimsTextCount) {
      console.log('PORTAL_SESSION_REUSED', accountKey);
      return { browser, context, page, reusedSession: true, signals };
    }
    await loginOnPage(page, config, credentials);
    return finish(context, page, false);
  }

  const { context, page } = await newPage();
  await page.goto(config.loginUrl || config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await loginOnPage(page, config, credentials);
  return finish(context, page, false);
}

module.exports = {
  BLOCK_PATTERNS,
  textLooksBlocked,
  classifyPortalPage,
  readPortalSignals,
  sessionPathFor,
  sessionAgeMs,
  sessionDir,
  openAuthenticatedPortal
};
