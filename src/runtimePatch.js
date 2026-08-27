const fs = require('fs');

const target = 'src/submitClaim.js';
let source = fs.readFileSync(target, 'utf8');

const anchor = `async function submitProfessionalClaim(page, config, claim, rates, mode) {\n  const sel = config.selectors.step1_claimHeader;\n\n  await page.click(config.selectors.navigation.claimsMenuLink);`;

const patched = `async function submitProfessionalClaim(page, config, claim, rates, mode) {\n  const sel = config.selectors.step1_claimHeader;\n\n  const postLoginState = await page.evaluate(() => ({\n    url: location.href,\n    title: document.title,\n    body: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 1600),\n    hasPassword: !!document.querySelector('input[type="password"]'),\n    claimsTextCount: Array.from(document.querySelectorAll('a,button,span,div')).filter(el => (el.textContent || '').trim() === 'Claims').length\n  }));\n  console.log('POST_LOGIN_STATE', JSON.stringify(postLoginState));\n  await page.screenshot({ path: '/app/post-login-state.png', fullPage: true }).catch(() => {});\n\n  if (postLoginState.hasPassword) {\n    throw new Error('POST_LOGIN_NOT_AUTHENTICATED: login form still visible; claim entry not started.');\n  }\n  if (!postLoginState.claimsTextCount) {\n    throw new Error('POST_LOGIN_NO_CLAIMS_MENU: provider dashboard did not expose Claims; claim entry not started.');\n  }\n\n  await page.click(config.selectors.navigation.claimsMenuLink);`;

if (!source.includes(anchor)) {
  console.error('POST_LOGIN_DIAGNOSTIC_PATCH_ANCHOR_NOT_FOUND');
  process.exit(1);
}

source = source.replace(anchor, patched);
fs.writeFileSync(target, source);
console.log('POST_LOGIN_DIAGNOSTIC_PATCH_APPLIED');
require('./server');
