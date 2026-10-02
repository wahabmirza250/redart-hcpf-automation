'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {JobStore,PortalScheduler}=require('../src/runtime');
const sourceFile=path.resolve(__dirname,'../src/server.js');
const realRequire=createRequire(sourceFile);

for(const failure of ['throw','unverified']) test(`server preserves receipt after ${failure} and refuses a second submit`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-server-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const routes=new Map();let runs=0;
 const app={use(){},get(p,fn){routes.set(`GET ${p}`,fn);},post(p,fn){routes.set(`POST ${p}`,fn);},listen(){}};
 const express=()=>app;express.json=()=>()=>{};
 const mocks={express,'./runtime':{PortalScheduler,JobStore:class extends JobStore{constructor(){super({persistPath:path.join(dir,'jobs.json')});}}},
 './submitClaim':{run:async(_record,_mode,persistence)=>{
   runs++;await persistence.beforeConfirm();await persistence.onReceipt('2326275001022');
   if(failure==='throw')throw new Error('browser closed after receipt');
   return {status:'SUBMITTED_UNVERIFIED'};
 }}};
 vm.runInNewContext(fs.readFileSync(sourceFile,'utf8'),{require:name=>mocks[name]||realRequire(name),
   process:{env:{CLAIM_LEDGER_PATH:path.join(dir,'ledger.json')},cwd:()=>dir},__dirname:path.dirname(sourceFile),__filename:sourceFile,
   console:{log(){},error(){}},setTimeout,clearTimeout,Buffer});
 const body={id:'test-trip',company_id:'test-company',provider_id:'test-provider',medicaid_member_id:'TEST',trip_date:'01/14/2026',
   miles:9,trip_units:2,mode:'confirm_submit',i_understand_this_is_real:true};
 function res(){return {statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;}};}
 const initial=res();await routes.get('POST /submit-claim')({body},initial);
 assert.equal(initial.value.status,'started');
 await new Promise(resolve=>setTimeout(resolve,20));
 const status=res();routes.get('GET /job-status/:jobId')({params:{jobId:initial.value.jobId}},status);
 assert.equal(status.value.status,'done');assert.equal(status.value.result.claim_id,'2326275001022');
 const retry=res();await routes.get('POST /submit-claim')({body},retry);
 assert.equal(retry.value.duplicate,true);assert.equal(retry.value.result.claim_id,'2326275001022');assert.equal(runs,1);
});
