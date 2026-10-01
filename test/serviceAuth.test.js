'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireServiceAuth } = require('../src/serviceAuth');
test('only health endpoints are public; all claim and debug routes require the service key', () => {
  const previous = process.env.ROBOT_SERVICE_KEY;
  process.env.ROBOT_SERVICE_KEY = 'test-only-key';
  try {
    function check(path, key, method = 'GET') {
      let status = 200, passed = false;
      const res = { status(n) { status = n; return this; }, json() {} };
      requireServiceAuth({ path, method, get: () => key }, res, () => { passed = true; });
      return { status, passed };
    }
    assert.equal(check('/health').passed, true);
    assert.equal(check('/').passed, true);
    for (const path of ['/ledger', '/app', '/job-status/job', '/debug-server-check', '/submit-claim', '/verify-member']) {
      assert.equal(check(path).status, 401);
      assert.equal(check(path, 'wrong').status, 401);
      assert.equal(check(path, 'test-only-key').passed, true);
    }
    assert.equal(check('/health', undefined, 'POST').status, 401);
    delete process.env.ROBOT_SERVICE_KEY;
    assert.equal(check('/ledger').status, 503);
  } finally {
    if (previous === undefined) delete process.env.ROBOT_SERVICE_KEY;
    else process.env.ROBOT_SERVICE_KEY = previous;
  }
});
