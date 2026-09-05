'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractClaimId, extractClaimIdFromDump, looksLikeClaimId } = require('../src/claimReceipt');

test('reads the historic HCPF success sentence', () => {
  assert.equal(extractClaimId('The Claim ID is 9426213001270.'), '9426213001270');
});

test('reads Claim ID buried after a long page of chrome', () => {
  const padding = 'Welcome to Colorado HCPF. '.repeat(400);
  const text = `${padding}\nClaim ID: 9426213001270\nStatus is Suspended`;
  assert.ok(text.length > 3000);
  assert.equal(extractClaimId(text), '9426213001270');
});

test('accepts TCN / ICN / Claim # labels', () => {
  assert.equal(extractClaimId('TCN # 1234567890123'), '1234567890123');
  assert.equal(extractClaimId('Claim # 1234567890123 was accepted'), '1234567890123');
});

test('does not treat member IDs, money, or dates as a claim id', () => {
  assert.equal(extractClaimId('Member ID M964077 charged $12.15 on 07/01/2026'), null);
  assert.equal(looksLikeClaimId('20260701'), false);
});

test('dump helper prefers labeled page text over noise', () => {
  const id = extractClaimIdFromDump({
    bodyTextFull: 'x'.repeat(100),
    confirmationCandidates: ['The Claim ID is 9426213001270'],
    html: '',
    url: ''
  });
  assert.equal(id, '9426213001270');
});
