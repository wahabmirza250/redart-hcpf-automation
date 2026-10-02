'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ClaimLedger } = require('../src/claimLedger');
const { JobStore } = require('../src/runtime');
const { recoverJob } = require('../src/receiptRecovery');
const { attachClaimIdSniffer, waitForClaimReceipt } = require('../src/claimReceipt');

const id = '2326275001022';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-recovery-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const ledger = new ClaimLedger(path.join(dir,'ledger.json'));
  const jobs = new JobStore({persistPath:path.join(dir,'jobs.json')});
  const key = ClaimLedger.identityKey({companyId:'company-a',tripId:'trip-a'});
  jobs.create('job-a',{status:'running',startedAt:new Date().toISOString(),ledgerKey:key});
  ledger.record(key,{state:'uncertain',job_id:'job-a'});
  return {dir,ledger,jobs,key};
}

test('receipt survives late failure, null overwrite and process restart', t => {
  const {dir,ledger,jobs,key}=setup(t);
  ledger.record(key,{state:'submitted',claim_id:id});
  ledger.record(key,{state:'failed',claim_id:null,note:'browser closed during cleanup'});
  jobs.update('job-a',{status:'error',result:{error:'browser closed'}});
  const restartedLedger=new ClaimLedger(path.join(dir,'ledger.json'));
  const restartedJobs=new JobStore({persistPath:path.join(dir,'jobs.json')});
  const result=recoverJob(restartedJobs,restartedLedger,'job-a');
  assert.equal(result.status,'done');
  assert.equal(result.result.claim_id,id);
  assert.equal(restartedLedger.get(key).state,'submitted');
  assert.throws(()=>ledger.record(key,{state:'submitted',claim_id:'2326275009999'}),/RECEIPT_CONFLICT/);
});

test('expired job history recovers from durable ledger; unknown jobs do not', t => {
  const {ledger,key}=setup(t);
  ledger.record(key,{state:'submitted',claim_id:id});
  const empty=new JobStore({persistPath:null});
  assert.equal(recoverJob(empty,ledger,'job-a').result.claim_id,id);
  assert.equal(recoverJob(empty,ledger,'unrelated'),null);
});

test('uncertain claim without receipt stays unconfirmed after restart', t => {
  const {dir,ledger}=setup(t);
  const jobs=new JobStore({persistPath:path.join(dir,'jobs.json')});
  const result=recoverJob(jobs,ledger,'job-a');
  assert.equal(result.status,'running');
  assert.equal(result.interruptedByRestart,true);
  assert.equal(result.result,undefined);
});

function fakePage() {
  const page=new EventEmitter();
  const frame={};
  page.mainFrame=()=>frame;
  page.url=()=> 'https://portal.example/ConfirmProfessionalClaim';
  page.evaluate=async()=>{throw new Error('page closed');};
  return page;
}
function response(page,overrides={}) {
  return {request:()=>({method:()=> 'POST',isNavigationRequest:()=>true,frame:()=>page.mainFrame()}),
    url:()=> 'https://portal.example/Confirmation',headers:()=>({'content-type':'text/html'}),
    text:async()=>`<span>Claim ID</span><span>${id}</span>`, ...overrides};
}

test('network receipt is durable before the browser result returns', async t => {
  const {ledger,key}=setup(t);
  const page=fakePage();
  const sniffer=attachClaimIdSniffer(page,{onReceipt:claim_id=>ledger.record(key,{state:'submitted',claim_id})});
  page.emit('response',response(page));
  await sniffer.stop();
  assert.equal(ledger.get(key).claim_id,id);
  const receipt=await waitForClaimReceipt(page,{timeoutMs:500,getOverheardId:()=>sniffer.state.claimId});
  assert.equal(receipt.claimId,id);
});

test('unrelated response cannot create a receipt; delayed Confirm response is drained', async () => {
  const page=fakePage();
  const saved=[];
  const sniffer=attachClaimIdSniffer(page,{onReceipt:claimId=>saved.push(claimId)});
  page.emit('response',response(page,{url:()=> 'https://other.example/Confirmation'}));
  page.emit('response',response(page,{request:()=>({method:()=> 'GET'})}));
  page.emit('response',response(page,{text:async()=>{await new Promise(r=>setTimeout(r,20));return `Claim ID: ${id}`;}}));
  await sniffer.stop();
  assert.deepEqual(saved,[id]);
  assert.equal(page.listenerCount('response'),0);
});

test('closed browser does not abort polling while the response arrives', async () => {
  const page=fakePage();
  let claimId=null;
  const timer=setTimeout(()=>{claimId=id;},20);
  try {
    const result=await waitForClaimReceipt(page,{timeoutMs:1000,getOverheardId:()=>claimId});
    assert.equal(result.claimId,id);
  } finally {clearTimeout(timer);}
});
