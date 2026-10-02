'use strict';

// The ledger is authoritative if a browser or job-store write fails after
// the irreversible Confirm click. This never initiates a portal submission.
function jobWithReceipt(job, ledgerRow) {
  if (!ledgerRow?.claim_id || !['submitted', 'already_on_file'].includes(ledgerRow.state)) return job;
  if (job && job.ledgerKey !== ledgerRow.key) return job;
  return {
    ...job,
    jobId: job?.jobId || ledgerRow.job_id,
    ledgerKey: ledgerRow.key,
    status: 'done',
    queued: false,
    interruptedByRestart: false,
    finishedAt: job?.finishedAt || ledgerRow.updated_at,
    result: {
      ...(job?.result?.claim_id === ledgerRow.claim_id ? job.result : {}),
      status: 'SUBMITTED',
      claim_id: ledgerRow.claim_id,
      claim_id_source: 'durable_receipt',
      message: `Portal claim ${ledgerRow.claim_id} was saved. Do not resubmit.`,
    },
  };
}

function recoverJob(jobs, ledger, jobId) {
  const job = jobs.get(jobId);
  const row = job?.ledgerKey
    ? ledger.get(job.ledgerKey)
    : Object.values(ledger.all()).find(row => row.job_id === jobId);
  return jobWithReceipt(job, row);
}

module.exports = { jobWithReceipt, recoverJob };
