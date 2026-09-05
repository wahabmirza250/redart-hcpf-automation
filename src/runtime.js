'use strict';

const fs = require('fs');
const path = require('path');

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

class PortalScheduler {
  constructor(options = {}) {
    this.globalLimit = options.globalLimit || envInt('PORTAL_GLOBAL_SESSIONS', 2, 1, 8);
    this.cooldownMs = options.cooldownMs ?? envInt('PORTAL_ACCOUNT_COOLDOWN_MS', 2500, 0, 60000);
    this.globalActive = 0;
    this.accountActive = new Set();
    this.lastEndedAt = new Map();
    this.queue = [];
  }

  queued(accountKey) {
    return this.accountActive.has(accountKey) || this.globalActive >= this.globalLimit ||
      this.queue.some(item => item.accountKey === accountKey);
  }

  snapshot() {
    return {
      global_limit: this.globalLimit,
      active_sessions: this.globalActive,
      active_accounts: this.accountActive.size,
      queued_sessions: this.queue.length
    };
  }

  async run(accountKey, task) {
    await this.#acquire(accountKey);
    try {
      const lastEnded = this.lastEndedAt.get(accountKey) || 0;
      const waitMs = Math.max(0, this.cooldownMs - (Date.now() - lastEnded));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      return await task();
    } finally {
      this.lastEndedAt.set(accountKey, Date.now());
      this.globalActive = Math.max(0, this.globalActive - 1);
      this.accountActive.delete(accountKey);
      this.#drain();
    }
  }

  #acquire(accountKey) {
    return new Promise(resolve => {
      this.queue.push({ accountKey, resolve });
      this.#drain();
    });
  }

  #drain() {
    if (this.globalActive >= this.globalLimit) return;
    for (let index = 0; index < this.queue.length && this.globalActive < this.globalLimit;) {
      const item = this.queue[index];
      if (this.accountActive.has(item.accountKey)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.globalActive += 1;
      this.accountActive.add(item.accountKey);
      item.resolve();
    }
  }
}

class JobStore {
  constructor(options = {}) {
    this.maxJobs = options.maxJobs || envInt('JOB_HISTORY_LIMIT', 1000, 50, 10000);
    this.ttlMs = options.ttlMs || envInt('JOB_HISTORY_TTL_MS', 24 * 60 * 60 * 1000, 60000, 7 * 24 * 60 * 60 * 1000);
    this.persistPath = options.persistPath !== undefined
      ? options.persistPath
      : (process.env.JOB_STORE_PATH || path.join(process.cwd(), 'data', 'job-store.json'));
    this.jobs = new Map();
    this.keys = new Map();
    this.#load();
  }

  get(id) {
    this.prune();
    return this.jobs.get(id) || null;
  }

  findByKey(key) {
    if (!key) return null;
    const id = this.keys.get(key);
    return id ? this.get(id) : null;
  }

  create(id, value, key = null) {
    this.prune();
    const job = { ...value, jobId: id, idempotencyKey: key };
    this.jobs.set(id, job);
    if (key) this.keys.set(key, id);
    this.prune();
    this.#save();
    return job;
  }

  update(id, patch) {
    const current = this.jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.jobs.set(id, next);
    this.#save();
    return next;
  }

  count() {
    this.prune();
    return this.jobs.size;
  }

  prune(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      const timestamp = Date.parse(job.finishedAt || job.startedAt || 0);
      if (Number.isFinite(timestamp) && now - timestamp > this.ttlMs) this.#delete(id, job);
    }
    while (this.jobs.size > this.maxJobs) {
      const [id, job] = this.jobs.entries().next().value;
      this.#delete(id, job);
    }
  }

  #delete(id, job) {
    this.jobs.delete(id);
    if (job?.idempotencyKey && this.keys.get(job.idempotencyKey) === id) this.keys.delete(job.idempotencyKey);
    this.#save();
  }

  #load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const job of data.jobs || []) {
        if (job && job.jobId) this.jobs.set(job.jobId, job);
      }
      for (const [key, id] of Object.entries(data.keys || {})) this.keys.set(key, id);
    } catch (err) {
      console.error('JOB_STORE_LOAD_FAILED:', err.message);
    }
  }

  #save() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        jobs: [...this.jobs.values()],
        keys: Object.fromEntries(this.keys)
      }));
      fs.renameSync(tmp, this.persistPath);
    } catch (err) {
      console.error('JOB_STORE_SAVE_FAILED:', err.message);
    }
  }
}

module.exports = { JobStore, PortalScheduler, envInt };
