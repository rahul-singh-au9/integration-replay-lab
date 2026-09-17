import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fixtures } from '../src/core/fixtures';
import { replayScenario } from '../src/core/replay';

test('server replay persists real computed results and isolates saved runs', async ({page,browser}) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Private browser session',{exact:true})).toBeVisible();
  const created=page.waitForResponse(r=>r.url().endsWith('/api/runs') && r.request().method()==='POST');
  await page.getByRole('button',{name:'Run replay',exact:true}).click();
  const response=await created;
  expect(response.status()).toBe(201);
  const {run}=await response.json();
  expect(run.scenario).toEqual(fixtures[0].scenario);
  expect(run.result).toEqual(replayScenario(fixtures[0].scenario));
  await expect(page.getByText('Saved replay · Server result',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Selected delivery evidence'})).toBeVisible();
  const cookie=(await page.context().cookies()).find(c=>c.name.endsWith('irl_session'));
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect(cookie?.secure).toBe(new URL(page.url()).protocol==='https:');

  const other=await browser.newContext();
  const base=new URL(page.url()).origin;
  await other.request.post(`${base}/api/session`,{headers:{Origin:base},data:{}});
  expect((await other.request.get(`${base}/api/runs/${run.id}`)).status()).toBe(404);
  expect((await other.request.delete(`${base}/api/runs/${run.id}`,{headers:{Origin:base}})).status()).toBe(404);
  await other.close();

  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export JSON',exact:true}).click();
  const bundle=JSON.parse(await readFile((await (await downloading).path())!,'utf8'));
  expect(bundle.result).toEqual(run.result);
  expect(bundle.scenario).toEqual(run.scenario);
  await page.getByRole('button',{name:'Import scenario',exact:true}).click();
  await page.getByLabel('Scenario JSON',{exact:true}).fill(JSON.stringify(bundle));
  await page.getByRole('dialog').getByRole('button',{name:'Import scenario',exact:true}).click();
  await expect(page.getByText('Replay complete',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Run locally',exact:true}).click();
  await expect(page.getByText('Local replay · Not saved',{exact:true})).toBeVisible();
  const localDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export JSON',exact:true}).click();
  const localBundle=JSON.parse(await readFile((await (await localDownload).path())!,'utf8'));
  expect(localBundle.result).toEqual(run.result);

  await page.reload();
  await page.getByRole('button',{name:/^Saved replays/}).click();
  await expect(page.getByRole('heading',{name:run.title,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open',exact:true}).click();
  await expect(page.getByText('Saved replay · Server result',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/^Saved replays/}).click();
  await page.getByRole('button',{name:`Delete ${run.title}`,exact:true}).click();
  await page.getByRole('button',{name:'Delete replay',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A place for repeatable investigations.',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('invalid input and service failures preserve explicit local-only operation', async ({page}) => {
  await page.route('**/api/**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Storage unavailable.',requestId:'test-outage'})}));
  await page.goto('/');
  await page.getByRole('button',{name:'Import scenario',exact:true}).click();
  await page.getByLabel('Scenario JSON',{exact:true}).fill('{');
  await page.getByRole('dialog').getByRole('button',{name:'Import scenario',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Run replay',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Storage unavailable');
  await expect(page.getByText('Saved replay · Server result',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Run locally',exact:true}).click();
  await expect(page.getByText('Local replay · Not saved',{exact:true})).toBeVisible();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export JSON',exact:true}).click();
  expect((await download).suggestedFilename()).toMatch(/replay\.json$/);
});

test('mobile replay and key views meet accessibility and layout targets', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'Run locally',exact:true}).click();
  await expect(page.getByText('Replay complete',{exact:true})).toBeVisible();
  for(const viewport of [{width:1440,height:960},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(results.violations.filter(v=>['serious','critical'].includes(v.impact??'')).map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,reason:n.failureSummary}))}))).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  }
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Open navigation',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await page.getByRole('button',{name:/^Saved replays/}).click();
  await expect(page.getByRole('heading',{name:'Saved replays',exact:true})).toBeVisible();
});

test('keyboard import restores focus and renders imported text without executing it', async ({page}) => {
  const scenario=structuredClone(fixtures[0].scenario);
  scenario.title='<img src=x onerror="window.injectionRan=true">';
  await page.goto('/');
  await page.getByRole('button',{name:'Import scenario',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Scenario JSON',{exact:true}).fill(JSON.stringify(scenario));
  await page.getByRole('dialog').getByRole('button',{name:'Import scenario',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Import scenario',exact:true})).toBeFocused();
  await expect(page.getByRole('heading',{name:scenario.title,exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Reflect.get(window,'injectionRan'))).toBeUndefined();
  await page.getByRole('button',{name:'Run locally',exact:true}).click();
  await expect(page.getByText('Replay complete',{exact:true})).toBeVisible();
});

test('method, JSON view and import dialog meet the accessibility target', async ({page}) => {
  await page.goto('/');
  for(const next of ['How it works','Scenario JSON','Import scenario']) {
    await page.getByRole('button',{name:next,exact:true}).last().click();
    const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(results.violations.filter(v=>['serious','critical'].includes(v.impact??'')).map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
  }
});

test('long imported identifiers and maximum amounts remain usable on mobile', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const scenario=structuredClone(fixtures[0].scenario);
  scenario.title='A'.repeat(160);
  for(const event of scenario.events) {
    event.orderId='order-'+ 'a'.repeat(58);
    event.eventId='event-'+ 'b'.repeat(58);
    event.revision=Number.MAX_SAFE_INTEGER;
    event.totalCents=Number.MAX_SAFE_INTEGER;
  }
  await page.goto('/');
  await page.getByRole('button',{name:'Import scenario',exact:true}).click();
  await page.getByLabel('Scenario JSON',{exact:true}).fill(JSON.stringify(scenario));
  await page.getByRole('dialog').getByRole('button',{name:'Import scenario',exact:true}).click();
  await page.getByRole('button',{name:'Run locally',exact:true}).click();
  await expect(page.getByText('Local replay · Not saved',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(page.getByText('9,007,199,254,740,991 cents',{exact:true}).first()).toBeVisible();
});

test('production assets stay within budget with no third-party page requests', async ({page}) => {
  const sizes:Promise<number>[]=[];
  const thirdParty:string[]=[];
  page.on('response',response=>{
    if(['script','stylesheet'].includes(response.request().resourceType())) sizes.push(response.body().then(body=>gzipSync(body).byteLength));
  });
  page.on('request',request=>{
    if(new URL(request.url()).origin!==new URL(page.url()).origin && !request.isNavigationRequest()) thirdParty.push(request.url());
  });
  const start=Date.now();
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Run locally',exact:true})).toBeEnabled();
  expect(Date.now()-start).toBeLessThan(10_000);
  await page.waitForLoadState('networkidle');
  const bytes=(await Promise.all(sizes)).reduce((sum,n)=>sum+n,0);
  expect(bytes).toBeLessThan(250*1024);
  expect(thirdParty).toEqual([]);
  console.log(JSON.stringify({gzipApplicationAssetBytes:bytes,usableWithinMs:Date.now()-start}));
});
