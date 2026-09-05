'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JobStore, PortalScheduler } = require('../src/runtime');

test('never runs two sessions for the same HCPF account', async () => {
  const scheduler = new PortalScheduler({ globalLimit: 4, cooldownMs: 0 });
  let active = 0;
  let peak = 0;
  const task = () => scheduler.run('london', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
  });
  await Promise.all([task(), task(), task(), task()]);
  assert.equal(peak, 1);
});

test('allows different portal accounts up to the global limit', async () => {
  const scheduler = new PortalScheduler({ globalLimit: 2, cooldownMs: 0 });
  let active = 0;
  let peak = 0;
  const task = account => scheduler.run(account, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
  });
  await Promise.all([task('a'), task('b'), task('c')]);
  assert.equal(peak, 2);
});

test('job store reuses an idempotency key and stays bounded', () => {
  const jobs = new JobStore({ maxJobs: 2, ttlMs: 60000, persistPath: null });
  jobs.create('one', { status: 'running', startedAt: new Date().toISOString() }, 'trip-1');
  assert.equal(jobs.findByKey('trip-1').jobId, 'one');
  jobs.create('two', { status: 'done', startedAt: new Date().toISOString() });
  jobs.create('three', { status: 'done', startedAt: new Date().toISOString() });
  assert.equal(jobs.count(), 2);
  assert.equal(jobs.get('one'), null);
});
