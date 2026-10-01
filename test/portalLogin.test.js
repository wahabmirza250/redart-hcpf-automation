'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loginOnPage, openAuthenticatedPortal } = require('../src/portalAuth');
const config = require('../config/hcpf-colorado.json');

test('login triggers normal blur validation before clicking the exact submit control', async () => {
  const calls = [];
  const locator = { first() { return this; }, last() { return this; }, isVisible: async () => true, press: async key => calls.push(key), waitFor: async () => {} };
  await loginOnPage({ locator: () => locator, fill: async selector => calls.push(selector), click: async selector => calls.push(selector), waitForLoadState: async () => {} }, config, {username:'test',password:'test'});
  assert.deepEqual(calls, [config.selectors.login.usernameField, config.selectors.login.passwordField, 'Tab', "input[type='submit'][value='Log In']:visible"]);
});

test('a login failure captures evidence and closes the browser', async () => {
  let captured = false, closed = false;
  const page = { goto: async () => {}, locator: () => ({ first() { return this; }, isVisible: async () => true }), fill: async () => { throw new Error('login validation failed'); }, screenshot: async () => { captured = true; } };
  const browser = {newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }),close: async () => {closed = true;} };
  await assert.rejects(openAuthenticatedPortal({chromium:{launch:async()=>browser},config,credentials:{},accountKey:'test-nonexistent-login-cleanup'}), /login validation failed/);
  assert.equal(captured,true);
  assert.equal(closed,true);
});
