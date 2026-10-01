'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPortalPage, textLooksBlocked } = require('../src/portalAuth');

test('ordinary support instructions do not block an authenticated dashboard', () => {
  for (const body of ['Please contact support for help.', 'Please contact the help desk.', 'Please contact your administrator to update your details.']) {
    assert.equal(classifyPortalPage({ body, hasPassword: false, claimsTextCount: 1 }).ok, true);
    assert.equal(classifyPortalPage({ body, hasPassword: true, claimsTextCount: 0 }).code, 'POST_LOGIN_NOT_AUTHENTICATED');
  }
});

test('support text does not hide a real block or verification challenge', () => {
  for (const body of ['Your account is locked. Please contact support.', 'Access denied. Please contact the help desk.', 'Verification code required. Please contact support.']) {
    const result = classifyPortalPage({ body, hasPassword: false, claimsTextCount: 1 });
    assert.equal(result.code, 'PORTAL_BLOCKED');
    assert.match(result.detail, /body:rule-\d+/);
    assert.equal(result.detail.includes(body), false);
  }
});

test('lockout copy is treated as blocked, not a flaky selector', () => {
  assert.equal(textLooksBlocked('Your account has been locked. Try again tomorrow.'), true);
  assert.equal(classifyPortalPage({
    title: 'Access Denied',
    body: 'Too many failed login attempts. Try again later.',
    hasPassword: true,
    claimsTextCount: 0
  }).code, 'PORTAL_BLOCKED');
});

test('a live dashboard with Claims is authenticated', () => {
  const result = classifyPortalPage({
    title: 'Provider Home',
    body: 'Welcome to the Colorado HCPF portal',
    hasPassword: false,
    claimsTextCount: 2
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'AUTHENTICATED');
});

test('password field still showing means login did not take', () => {
  const result = classifyPortalPage({
    title: 'Log In',
    body: 'Please enter your User ID',
    hasPassword: true,
    claimsTextCount: 0
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POST_LOGIN_NOT_AUTHENTICATED');
});
