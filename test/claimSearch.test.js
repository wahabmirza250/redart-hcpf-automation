'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validSearchUrl,gotoSearchClaimsPage,fillSearchCriteria}=require('../src/claimSearch');
const origin='https://portal.example';
test('preserves portal generated search URL and tokens',()=>{
 assert.equal(validSearchUrl('/hcp/provider/Claims/SearchClaims/tabid/531/Default.aspx?p13=token',origin,origin),origin+'/hcp/provider/Claims/SearchClaims/tabid/531/Default.aspx?p13=token');
});
test('missing and foreign links cannot become a successful empty search',()=>{
 for(const href of [null,'https://evil.example/Claims/SearchClaims/','/hcp/provider/Claims/SubmitClaimProf/tabid/290/Default.aspx']) assert.throws(()=>validSearchUrl(href,origin,origin));
});
test('search requires visible search controls after navigation',async()=>{
 const page={evaluate:async()=>'/hcp/provider/Claims/SearchClaims/tabid/531/Default.aspx',url:()=>origin,goto:async()=>{},locator:()=>({first(){return this},waitFor:async()=>{throw Error('missing controls')}})};
 await assert.rejects(gotoSearchClaimsPage(page,{baseUrl:origin}),/missing controls/);
});
test('missing member field prevents search instead of swallowing error',async()=>{
 let clicked=false;
 const page={locator:()=>({count:async()=>0}),waitForNavigation:async()=>{clicked=true}};
 await assert.rejects(fillSearchCriteria(page,{memberId:'A123456'}),/required search field missing/);
 assert.equal(clicked,false);
});
