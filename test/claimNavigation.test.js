'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {openProfessionalClaim}=require('../src/claimNavigation');
const config=require('../config/hcpf-colorado.json');

test('duplicate lookup returning to Step 1 does not require the absent dashboard menu',async()=>{
  const page={url:()=>new URL('/hcp/provider/Claims/SubmitClaimProf/tabid/290/Default.aspx',config.baseUrl).href,
    locator:selector=>{assert.equal(selector,config.selectors.step1_claimHeader.memberIdField);return {first(){return this;},isVisible:async()=>true};},
    goto:async()=>assert.fail('already on Step 1')};
  await openProfessionalClaim(page,config);
});
test('opens the actual Step 1 href instead of clicking hidden menu copies',async()=>{
  let navigated;
  const page={url:()=>config.loginUrl,locator:()=>({first(){return this;},getAttribute:async()=>'/hcp/provider/Claims/SubmitClaimProf/tabid/290/Default.aspx?p13=test',waitFor:async()=>{}}),goto:async url=>{navigated=url;}};
  await openProfessionalClaim(page,config);
  assert.equal(new URL(navigated).search,'?p13=test');
});

test('search screen sharing the same route and member field is not the claim-entry form',async()=>{
 let navigated;
 const page={url:()=>new URL('/hcp/provider/Claims/SubmitClaimProf/tabid/531/Default.aspx',config.baseUrl).href,
 locator:()=>({first(){return this;},isVisible:async()=>true,getAttribute:async()=>'/hcp/provider/Claims/SubmitClaimProf/tabid/290/Default.aspx',waitFor:async()=>{}}),
 goto:async url=>{navigated=url;}};
 await openProfessionalClaim(page,config);
 assert.equal(new URL(navigated).pathname,'/hcp/provider/Claims/SubmitClaimProf/tabid/290/Default.aspx');
});
test('rejects non Step 1 destinations and identifies failure as pre-submit',async()=>{
  for(const href of ['https://example.com','/hcp/provider/Claims/SubmitClaimProf3/tabid/290/Default.aspx']) {
    const page={url:()=>config.loginUrl,locator:()=>({first(){return this;},getAttribute:async()=>href}),goto:async()=>assert.fail('must not navigate')};
    await assert.rejects(openProfessionalClaim(page,config),err=>err.submitReached===false&&err.portalStage==='navigate');
  }
});
