'use strict';

async function openProfessionalClaim(page, config) {
  try {
    // The duplicate lookup already returns to Step 1. Its in-form layout
    // does not expose the dashboard menu, so do not navigate twice.
    if (/^\/hcp\/provider\/Claims\/SubmitClaimProf\/tabid\/290\/Default\.aspx$/i.test(new URL(page.url()).pathname) &&
        await page.locator(config.selectors.step1_claimHeader.memberIdField).first().isVisible()) return;
    // HCPF duplicates menu links in hidden menus. Use the portal-provided
    // Step 1 link instead of clicking the last (potentially hidden) copy.
    const link = page.locator('a[title="Submit Professional Claim - Step 1"]').first();
    const href = await link.getAttribute('href', { timeout: 10000 });
    const target = new URL(href || '', page.url());
    if (!href || target.origin !== new URL(config.baseUrl).origin ||
        !/^\/hcp\/provider\/Claims\/SubmitClaimProf\/tabid\/\d+\/Default\.aspx$/i.test(target.pathname)) {
      throw new Error('Portal did not expose a valid Step 1 navigation link');
    }
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator(config.selectors.step1_claimHeader.memberIdField).first()
      .waitFor({ state: 'visible', timeout: 15000 });
  } catch (err) {
    const failure = new Error('PORTAL_NAVIGATION_FAILED: stage=navigate submit_reached=false. Could not open the professional claim form.');
    failure.portalStage = 'navigate';
    failure.submitReached = false;
    failure.cause = err;
    throw failure;
  }
}

module.exports = { openProfessionalClaim };
