'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PortalSessionPool}=require('../src/portalSessionPool');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}) {
 const pool=new PortalSessionPool(options);let opened=0,closed=0;
 const open=async()=>({page:{id:++opened},close:async()=>{closed++;return {loggedOut:true};}});
 return {pool,options:{open,validate:async()=>true},counts:()=>({opened,closed})};
}
test('100 sequential bills reuse a single login without logging out between them',async()=>{
 const f=fixture();
 for(let i=0;i<100;i++) {
   const lease=await f.pool.acquire('account',f.options);
   assert.equal(lease.page.id,1);
   await lease.close();
 }
 assert.deepEqual(f.counts(),{opened:1,closed:0});
 const last=await f.pool.acquire('account',f.options);await last.close({logout:true});
 assert.equal(f.counts().closed,1);
});
test('concurrent requests cannot use the same browser at once',async()=>{
 const f=fixture(),first=await f.pool.acquire('account',f.options);let acquired=false;
 const waiting=f.pool.acquire('account',f.options).then(lease=>{acquired=true;return lease;});
 await tick();assert.equal(acquired,false);
 await first.close();const second=await waiting;
 assert.equal(second.page.id,first.page.id);await second.close({logout:true});
});
test('stale idle timer cannot log out a new active job or its released session',async()=>{
 const f=fixture();const first=await f.pool.acquire('account',f.options);await first.close();
 const entry=f.pool.entries.get('account'),generation=entry.generation||0;
 const second=await f.pool.acquire('account',f.options);
 const oldExpiry=f.pool.expire('account',entry,generation);
 await tick();assert.equal(f.counts().closed,0);
 await second.close();await oldExpiry;assert.equal(f.counts().closed,0);
 const third=await f.pool.acquire('account',f.options);await third.close({logout:true});
});
test('expired authentication opens one fresh session between jobs',async()=>{
 const f=fixture();let first=await f.pool.acquire('account',f.options);await first.close();
 const second=await f.pool.acquire('account',{...f.options,validate:async()=>false});
 assert.equal(second.page.id,2);assert.equal(f.counts().closed,1);await second.close({logout:true});
});
test('job failure discards only its session; a different account is isolated',async()=>{
 const f=fixture();const a=await f.pool.acquire('a',f.options),b=await f.pool.acquire('b',f.options);
 assert.notEqual(a.page.id,b.page.id);a.invalidate();await a.close();
 assert.equal(f.counts().closed,1);await b.close({logout:true});
});
test('max age rotation waits until the active job releases its browser',async()=>{
 let now=0;const f=fixture({now:()=>now,maxAgeMs:100});
 const first=await f.pool.acquire('account',f.options);now=200;
 assert.equal(f.counts().closed,0);await first.close();
 const second=await f.pool.acquire('account',f.options);assert.equal(second.page.id,2);await second.close({logout:true});
});
test('portal block disposes old session and never retries login automatically',async()=>{
 const f=fixture();const first=await f.pool.acquire('account',f.options);await first.close();
 await assert.rejects(f.pool.acquire('account',{...f.options,validate:async()=>{throw new Error('PORTAL_BLOCKED');}}),/PORTAL_BLOCKED/);
 assert.deepEqual(f.counts(),{opened:1,closed:1});
});
