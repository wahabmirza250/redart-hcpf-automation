'use strict';

/**
 * Gainwell/DNN keeps analytics and ASP.NET ping requests open. Playwright
 * `networkidle` therefore sits until the full timeout on "busy" days and
 * returns immediately on quiet days — the exact one-day-works, next-day-dies
 * pattern. After a postback we wait for DOM + an optional ready locator.
 */
async function afterPostback(page, { ready = null, timeout = 8000 } = {}) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  if (ready) {
    await page.locator(ready).last().waitFor({ state: 'visible', timeout }).catch(() => {});
  }
}

async function clickLast(page, selector, options = {}) {
  await page.locator(selector).last().click({ timeout: options.timeout || 8000 });
}

module.exports = { afterPostback, clickLast };
