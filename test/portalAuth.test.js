'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPortalPage, textLooksBlocked } = require('../src/portalAuth');

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
