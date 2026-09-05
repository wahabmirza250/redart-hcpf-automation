'use strict';

/**
 * HCPF success pages do not use one stable sentence. The old robot only
 * looked for "Claim ID is 123" in the first 3,000 characters, then gave up
 * and reported confusion. These patterns cover the wordings we have seen
 * and still refuse member IDs / dates / money.
 */
const CLAIM_ID_PATTERNS = [
  /Claim\s*ID\s+is\s+(\d{8,20})/i,
  /Claim\s*ID\s*[:#]\s*(\d{8,20})/i,
  /The\s+Claim\s+ID\s+is\s+(\d{8,20})/i,
  /Claim\s*(?:number|#)\s*[:#]?\s*(\d{8,20})/i,
  /TCN\s*[:#]?\s*(\d{8,20})/i,
  /ICN\s*[:#]?\s*(\d{8,20})/i,
  /Control\s*(?:#|Number)\s*[:#]?\s*(\d{8,20})/i
];

function looksLikeClaimId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 20) return false;
  if (/^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(digits)) return false;
  return true;
}

function extractClaimId(text) {
  const raw = String(text || '').replace(/\u00a0/g, ' ');
  for (const pattern of CLAIM_ID_PATTERNS) {
    const match = raw.match(pattern);
    if (match && looksLikeClaimId(match[1])) return match[1];
  }
  return null;
}

function extractClaimIdFromDump(dump = {}) {
  return extractClaimId(dump.bodyTextFull)
    || extractClaimId((dump.confirmationCandidates || []).join('\n'))
    || extractClaimId(dump.html)
    || extractClaimId(dump.url)
    || (looksLikeClaimId(dump.inputClaimId) ? String(dump.inputClaimId).replace(/\D/g, '') : null);
}

async function readReceiptDump(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').replace(/\u00a0/g, ' ');
    const html = document.documentElement?.outerHTML || '';
    const labeled = Array.from(document.querySelectorAll('span, td, div, label, p, li, strong, b'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0 && t.length < 200 && /claim|tcn|icn|control|confirmation/i.test(t));
    const claimInputs = Array.from(document.querySelectorAll('input, span[id], td[id]'))
      .map(el => ({
        id: el.id || '',
        value: el.value || el.textContent || ''
      }))
      .find(el => /claimid|claim_id|claim-id/i.test(el.id) && /\d{8,}/.test(el.value));
    return {
      pageTitle: document.title,
      url: window.location.href,
      bodyTextFull: bodyText,
      html,
      confirmationCandidates: labeled.slice(0, 40),
      inputClaimId: claimInputs ? String(claimInputs.value).replace(/\D/g, '') : null
    };
  }).catch(err => ({
    pageTitle: '',
    url: '',
    bodyTextFull: '',
    html: '',
    confirmationCandidates: [],
    inputClaimId: null,
    error: err.message
  }));
}

async function waitForClaimReceipt(page, { timeoutMs = 15000, overheardId = null } = {}) {
  const started = Date.now();
  let dump = null;
  if (overheardId && looksLikeClaimId(overheardId)) {
    dump = await readReceiptDump(page);
    return { claimId: String(overheardId).replace(/\D/g, ''), dump, source: 'network' };
  }

  while (Date.now() - started < timeoutMs) {
    dump = await readReceiptDump(page);
    const claimId = extractClaimIdFromDump(dump);
    if (claimId) return { claimId, dump, source: 'page' };
    await page.waitForTimeout(300);
  }

  dump = dump || await readReceiptDump(page);
  return { claimId: null, dump, source: null };
}

function attachClaimIdSniffer(page) {
  const state = { claimId: null };
  const onResponse = async (response) => {
    try {
      const type = response.headers()['content-type'] || '';
      if (!/html|json|text|xml/i.test(type)) return;
      const body = await response.text();
      const found = extractClaimId(body);
      if (found) state.claimId = found;
    } catch {
      // Response bodies are not always readable; page text is the fallback.
    }
  };
  page.on('response', onResponse);
  return {
    state,
    stop() {
      page.off('response', onResponse);
    }
  };
}

module.exports = {
  CLAIM_ID_PATTERNS,
  attachClaimIdSniffer,
  extractClaimId,
  extractClaimIdFromDump,
  looksLikeClaimId,
  readReceiptDump,
  waitForClaimReceipt
};
