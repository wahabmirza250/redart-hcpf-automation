'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loginOnPage, openAuthenticatedPortal, closePortalSession, classifyPortalPage } = require('../src/portalAuth');
const config = require('../config/hcpf-colorado.json');

test('login triggers normal blur validation before clicking the exact submit control', async () => {
  const calls = [];
  const locator = { first() { return this; }, last() { return this; }, isVisible: async () => true, press: async key => calls.push(key), waitFor: async () => {} };
  await loginOnPage({ evaluate: async () => ({hasPassword:true}), locator: () => locator, fill: async selector => calls.push(selector), click: async selector => calls.push(selector), waitForLoadState: async () => {} }, config, {username:'test',password:'test'});
  assert.deepEqual(calls, [config.selectors.login.usernameField, config.selectors.login.passwordField, 'Tab', "input[type='submit'][value='Log In']:visible"]);
});

test('a login failure captures evidence and closes the browser', async () => {
  let captured = false, closed = false;
  const page = { evaluate: async () => ({hasPassword:true}), goto: async () => {}, locator: () => ({ first() { return this; }, isVisible: async () => true }), fill: async () => { throw new Error('login validation failed'); }, screenshot: async () => { captured = true; } };
  const browser = {newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }),close: async () => {closed = true;} };
  await assert.rejects(openAuthenticatedPortal({chromium:{launch:async()=>browser},config,credentials:{},accountKey:'test-nonexistent-login-cleanup'}), /login validation failed/);
  assert.equal(captured,true);
  assert.equal(closed,true);
});

test('previous-session rejection does not fill credentials or wait on disabled login', async () => {
  const signals = {body:'Error You did not logoff your previous session. Please close all browser windows to enable login.', hasPassword:true};
  assert.equal(classifyPortalPage(signals).code, 'PORTAL_SESSION_ACTIVE');
  await assert.rejects(loginOnPage({evaluate:async()=>signals,fill:async()=>assert.fail('must not attempt login')},config,{}), /PORTAL_SESSION_ACTIVE/);
});

test('portal Logout is completed before closing the browser and cached cookies are removed', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'portal-logout-'));
  const sessPath = path.join(dir,'session.json'); fs.writeFileSync(sessPath,'{}');
  const calls = [];
  const logout = {first(){return this;},isVisible:async()=>true,click:async()=>calls.push('logout')};
  try {
    const result = await closePortalSession({config,sessPath,
      browser:{close:async()=>calls.push('close')},context:{storageState:async()=>assert.fail('logged-out cookies must not be saved')},
      page:{getByRole:()=>logout,locator:()=>({first(){return this;},waitFor:async()=>calls.push('login-visible')}),evaluate:async()=>({hasPassword:true})}});
    assert.equal(result.loggedOut,true);
    assert.deepEqual(calls,['logout','login-visible','close']);
    assert.equal(fs.existsSync(sessPath),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('failed logout preserves current cookies and still closes browser without overwriting claim outcome', async () => {
  const calls=[];
  const result=await closePortalSession({config,sessPath:'unused-test-path',
    browser:{close:async()=>calls.push('close')},context:{storageState:async()=>calls.push('save')},
    page:{getByRole:()=>({first(){return this;},isVisible:async()=>true,click:async()=>{throw new Error('logout failed');}})}});
  assert.equal(result.loggedOut,false);
  assert.deepEqual(calls,['save','close']);
});
