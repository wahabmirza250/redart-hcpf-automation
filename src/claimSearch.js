'use strict';

function validSearchUrl(href, currentUrl, origin) {
  const target = new URL(href || '', currentUrl);
  if (!href || target.origin !== origin || !/\/Claims\//i.test(target.pathname) || !/SearchClaims|\/tabid\/531\//i.test(target.pathname)) {
    throw new Error('SEARCH_NAVIGATION_UNVERIFIED: no valid portal Search Claims link');
  }
  return target.href;
}

async function gotoSearchClaimsPage(page, config) {
  const href = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const link = links.find(a => /Search Claims/i.test((a.textContent || '') + ' ' + (a.title || '')) && a.getAttribute('href'));
    return link?.getAttribute('href') || null;
  });
  await page.goto(validSearchUrl(href, page.url(), new URL(config.baseUrl).origin), {waitUntil:'domcontentloaded',timeout:25000});
  await page.locator('[id$="SearchMedicalAndDentalClaimsCmnButton"]').first().waitFor({state:'visible',timeout:15000});
}

async function visibleField(page, selectors, dateRole) {
  for (const selector of selectors) {
    const list=page.locator(selector);
    for(let i=0;i<await list.count();i++) {
      const field=list.nth(i);
      if(await field.isVisible()) return field;
    }
  }
  if(dateRole && typeof page.evaluate === 'function') {
    const marked=await page.evaluate(role=>{
      const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
      const fields=el=>Array.from(el.querySelectorAll('input')).filter(i=>visible(i)&&!['hidden','button','submit','checkbox','radio'].includes(i.type));
      const row=Array.from(document.querySelectorAll('tr,fieldset,div')).filter(visible)
        .filter(el=>/Service\s+From/i.test(el.innerText||'')&&/\bTo\b/.test(el.innerText||''))
        .sort((a,b)=>a.innerText.length-b.innerText.length).find(el=>fields(el).length===2);
      if(!row) return false;
      const input=fields(row)[role==='from'?0:1];
      input.setAttribute('data-redart-search-date',role);
      return true;
    },dateRole);
    if(marked) return page.locator(`[data-redart-search-date="${dateRole}"]`).first();
  }
  throw new Error('SEARCH_CRITERIA_UNVERIFIED: required search field missing');
}

async function fillVerified(field, value) {
  await field.fill(String(value));
  await field.press('Tab');
  if ((await field.inputValue()).replace(/[^a-z0-9]/gi,'').toUpperCase() !== String(value).replace(/[^a-z0-9]/gi,'').toUpperCase()) {
    throw new Error('SEARCH_CRITERIA_UNVERIFIED: portal did not retain search value');
  }
}

async function fillSearchCriteria(page,{memberId,serviceDate,claimId}) {
  if(memberId) await fillVerified(await visibleField(page,['input[id*="MemberID" i]']),memberId);
  if(claimId) await fillVerified(await visibleField(page,['input[id*="ClaimID" i]']),claimId);
  if(serviceDate) {
    const match=String(serviceDate).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(!match) throw new Error('SEARCH_CRITERIA_UNVERIFIED: invalid service date');
    const date=`${match[1].padStart(2,'0')}/${match[2].padStart(2,'0')}/${match[3]}`;
    await fillVerified(await visibleField(page,['input[id*="ServiceFrom" i]','input[id*="FromDate" i]'],'from'),date);
    await fillVerified(await visibleField(page,['input[id*="ServiceTo" i]','input[id*="ToDate" i]'],'to'),date);
  }
  const search=page.locator('[id$="SearchMedicalAndDentalClaimsCmnButton"]').first();
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{}),search.click({timeout:10000})]);
  await page.waitForTimeout(1000);
}

async function readSearchResultRows(page) {
  const result=await page.evaluate(()=>{
    const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
    const tables=Array.from(document.querySelectorAll('table'));
    for(const table of tables) {
      const rows=Array.from(table.querySelectorAll('tr')).filter(r=>r.closest('table')===table);
      const header=rows.find(r=>/claim\s*(id|number)/i.test(r.innerText) && /status/i.test(r.innerText));
      if(!header) continue;
      const labels=Array.from(header.children).map(c=>clean(c.textContent).toLowerCase());
      const idIndex=labels.findIndex(x=>/claim\s*(id|number)/i.test(x));
      const statusIndex=labels.findIndex(x=>/status/.test(x));
      if(idIndex<0||statusIndex<0) continue;
      const dateIndex=labels.findIndex(x=>/service.*(date|from)|from.*date/.test(x));
      const paidIndex=labels.findIndex(x=>/paid/.test(x));
      const chargeIndex=labels.findIndex(x=>/charge/.test(x));
      const memberIndex=labels.findIndex(x=>/member.*id/.test(x));
      const claims=[];
      for(const row of rows) {
        if(row===header) continue;
        const cells=Array.from(row.children).map(c=>clean(c.textContent));
        const claimId=cells[idIndex];
        if(!/^\d{10,20}$/.test(claimId||'')) continue;
        claims.push({claim_id:claimId,status:cells[statusIndex],service_date:dateIndex<0?null:cells[dateIndex],member_id:memberIndex<0?null:cells[memberIndex],paid_amount:paidIndex<0?null:cells[paidIndex],charge:chargeIndex<0?null:cells[chargeIndex],row:cells});
      }
      if(claims.length) return {claims,resultCount:claims.length,searchCompleted:true};
    }
    return {claims:[],resultCount:0,searchCompleted:false,error:'SEARCH_RESULTS_UNVERIFIED: no readable claim rows; absence is not proof that no claim exists'};
  });
  return result;
}

module.exports={validSearchUrl,gotoSearchClaimsPage,fillSearchCriteria,readSearchResultRows};

