/* End-to-end: the real app (index.html) in Chrome, using the real Firebase SDK against the local Auth and
   Firestore emulators, with the real security rules. Run with `npm run test:e2e` (needs Google Chrome;
   set CHROME_PATH if it isn't in the default place). By default it uses a synthetic backup; set
   BACKUP_FILE to an exported backup to run the same checks on real data (never commit that file). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { rules, PROJECT } from '../emulator/helpers.js';
import * as calc from '../../calc.js';
import { SEED_CREDITS } from '../../catalog.js';
import { legacy } from '../fixtures/legacy-calc.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/sample-backup.json');
const BACKUP_PATH = process.env.BACKUP_FILE || FIXTURE;
const backup = JSON.parse(readFileSync(BACKUP_PATH, 'utf8'));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EMAIL = 'e2e-owner@example.test', PASSWORD = `e2e-${Math.random().toString(36).slice(2)}`;   // throwaway emulator account

const now = new Date(), Y = now.getFullYear(), M = now.getMonth() + 1;
const pad = n => String(n).padStart(2, '0');
const TODAY = `${Y}-${pad(M)}-${pad(now.getDate())}`, YM = `${Y}-${pad(M)}`;
const fmt = n => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/** Point a copy of the app at the emulators (the only change made to the page under test). */
function emulatorize(html) {
  const steps = [
    ['signOut } from', 'signOut, connectAuthEmulator } from'],
    ['import { initializeFirestore,', 'import { connectFirestoreEmulator, initializeFirestore,'],
    ['projectId: "card-credits"', `projectId: "${PROJECT}"`],
    ['const auth = getAuth(fb);', "const auth = getAuth(fb); connectAuthEmulator(auth, 'http://127.0.0.1:9099', {disableWarnings:true});"],
    ['persistentMultipleTabManager() }) });', "persistentMultipleTabManager() }) }); connectFirestoreEmulator(db, '127.0.0.1', 8080);"]
  ];
  for (const [a, b] of steps) { assert.ok(html.includes(a), `emulator hook: ${a}`); html = html.replace(a, b); }
  return html;
}
function serve() {
  const srv = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const f = p === '/old.html' ? path.join(ROOT, 'tests/fixtures/pre-catalog-index.html.txt') : path.join(ROOT, p);
      if (!f.startsWith(ROOT)) throw new Error('outside');
      let body = await readFile(f);
      if (p === '/index.html' || p === '/old.html') body = emulatorize(body.toString());
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() })));
}

let env, server, browser, page, uid;
const errors = [], consoleErrs = [];
const adm = async fn => { let r; await env.withSecurityRulesDisabled(async ctx => { r = await fn(ctx.firestore()); }); return r; };
const get = p => adm(async db => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; });
const list = p => adm(async db => Object.fromEntries((await db.collection(p).get()).docs.map(d => [d.id, d.data()])));
async function until(fn, label, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 150)); } assert.fail(`timed out: ${label}`); }
const U = () => `users/${uid}`;
// Open a page of the app on the Tracker (the app restores the last tab after a reload, so pick it)
const openTracker = async url => { await page.goto(url); await page.waitForSelector('nav.tabs:not([hidden])', { timeout: 20000 }); await page.click('nav [data-tab="tracker"]'); await page.waitForSelector('.trow'); };
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, name + '.png'), fullPage: true }); };
const toCards = async () => { await page.click('nav [data-tab="cards"]'); await page.waitForSelector('.cardlist'); };
const usedThisYear = S => { const old = legacy(S); return ['csr', 'gold', 'bilt'].reduce((t, c) => t + old.usedInYear(c, Y), 0); };

before(async () => {
  const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }) });
  uid = (await r.json()).localId; assert.ok(uid, 'emulator user created');
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: rules({ owner: uid }), host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await adm(db => db.doc(`users/${uid}`).set(backup.data));
  server = await serve();
  assert.ok(existsSync(CHROME), `Chrome at ${CHROME}`);
  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block', acceptDownloads: true });
  page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(m.text().slice(0, 300)); });
});
after(async () => { await browser?.close(); server?.close(); await env?.cleanup(); });

test('the app migrates real data, then every catalog feature works end to end', async (t) => {
  await t.test('sign in → the migration runs once and only adds data', async () => {
    await page.goto(server.url);
    await page.fill('#si-email', EMAIL); await page.fill('#si-pass', PASSWORD); await page.click('#si-go');
    await page.waitForSelector('.trow', { timeout: 20000 });
    const user = await until(async () => { const u = await get(U()); return u?.schemaVersion === 2 && u; }, 'schemaVersion 2');
    for (const k of ['log', 'off', 'anniv', 'fees', 'rent', 'biltRate']) assert.deepEqual(user[k], backup.data[k], `${k} untouched`);
    const credits = await list(`${U()}/credits`);
    assert.deepEqual(Object.keys(credits).sort(), SEED_CREDITS.map(c => c.id).sort());
    const snaps = Object.entries(await list(`${U()}/snapshots`)).filter(([id]) => id.startsWith('pre-catalog-'));
    assert.equal(snaps.length, 1);
    for (const k of Object.keys(backup.data)) assert.deepEqual(snaps[0][1][k], backup.data[k], `snapshot ${k}`);
    await until(async () => (await page.textContent('#sync')) === 'Saved', 'Saved');
  });

  await t.test('Tracker and Value totals match the old app on this data', async () => {
    const S = backup.data, ctx = { anniv: S.anniv, off: S.off, biltRate: S.biltRate };
    const monthRows = calc.trackerRows(SEED_CREDITS.filter(c => c.freq === 'month'), Y, M, ctx, S.log);
    const { used, total } = calc.sectionTotals(monthRows, ctx);
    assert.equal(await page.textContent('.panel .ptitle .sub'), `${fmt(used)} of ${fmt(total)}`, 'Monthly section');
    await page.click('nav [data-tab="value"]');
    assert.equal(await page.textContent('.hero .big'), fmt(usedThisYear(S)), 'Value tab: credits redeemed this year');
    const old = legacy(S);
    const { CREDITS } = await import('../fixtures/legacy-credits.js');
    const want = ['csr', 'gold', 'bilt'].map(card => fmt(CREDITS.filter(c => c.card === card).reduce((t, c) => t + old.possibleByCredit(c, Y), 0)));
    assert.deepEqual(await page.$$eval('.vline span:nth-child(3) b', bs => bs.map(b => b.textContent)), want, 'Value tab: possible per card');
  });

  await t.test('check-off still saves amt, face, card and ym', async () => {
    await page.click('nav [data-tab="tracker"]');
    const id = 'gold-uber', key = `${id}|${YM}`, was = !!(await get(U())).log[key];
    await page.click(`[data-toggle="${id}"]`);
    const log = await until(async () => { const l = (await get(U())).log; return !!l[key] !== was && l; }, 'check-off saved');
    if (!was) assert.deepEqual(log[key], { amt: 10, face: 10, card: 'gold', ym: YM });
    await page.click(`[data-toggle="${id}"]`);
    await until(async () => !!(await get(U())).log[key] === was, 'restored');
  });

  await t.test('Verify: stale counts, badges, Mark verified and Verify all', async () => {
    await toCards(); await shot('1-cards-tab');
    assert.deepEqual(await page.$$eval('.vtag', v => v.map(x => x.textContent)), ['11 credits to verify', '4 credits to verify', '2 credits to verify']);
    await page.click('[data-card="csr"]');
    assert.equal(await page.locator('.crow .pill.vb').count(), 11, 'a Verify badge on every unverified credit');
    await shot('2-card-page');
    await page.click('[data-info="csr-travel"]');
    await shot('3-info-sheet');
    assert.match(await page.textContent('.vinfo'), /Source: no link yet[\s\S]*Not verified yet/);
    await page.click('#in-verify');
    assert.equal((await until(() => get(`${U()}/credits/csr-travel`).then(c => c.lastVerified && c), 'lastVerified')).lastVerified, TODAY);
    await page.waitForFunction(() => document.querySelectorAll('.crow .pill.vb').length === 10);
    await page.click('#back'); await page.click('[data-card="gold"]');
    await page.click('#verify-all');
    await until(async () => Object.values(await list(`${U()}/credits`)).filter(c => c.card === 'gold').every(c => c.lastVerified === TODAY), 'gold verified');
    await page.click('#back');
    await page.waitForFunction(() => [...document.querySelectorAll('.vtag')].map(x => x.textContent).join('|') === '10 credits to verify|2 credits to verify');
  });

  await t.test('Edit → proposal → Review changes → Approve writes the change and the audit trail', async () => {
    await page.click('[data-card="gold"]'); await page.click('[data-info="gold-dunkin"]'); await page.click('#in-edit');
    const from = await page.inputValue('#ed-from');
    assert.equal(await page.inputValue('#ed-amount'), '7');
    await page.fill('#ed-amount', '8'); await page.fill('#ed-note', 'Raised to $8');
    await shot('4-edit-form');
    await page.click('#ed-form button[type=submit]');
    await until(async () => Object.values(await list(`${U()}/proposals`)).length === 1, 'proposal created');
    assert.equal((await get(`${U()}/credits/gold-dunkin`)).amounts.length, 1, 'nothing applied before approval');
    await page.click('#back');
    await page.waitForSelector('#review');
    assert.match(await page.textContent('#review'), /Review changes\s*1/);
    await page.click('#review');
    const item = page.locator('[data-item]');
    assert.match(await item.textContent(), /Dunkin’ credit/);
    assert.match(await item.textContent(), /\$7 → \$8 a month/);
    await item.locator('[data-approve]').click();
    const c = await until(() => get(`${U()}/credits/gold-dunkin`).then(c => c.amounts.length === 2 && c), 'amount appended');
    assert.deepEqual(c.amounts.at(-1), { amount: 8, from });
    assert.equal(c.changeNote, 'Raised to $8');
    const [p] = Object.values(await list(`${U()}/proposals`));
    assert.equal(p.status, 'approved'); assert.deepEqual(p.applied.amounts, c.amounts); assert.ok(p.decidedAt);
    await page.click('#hist');
    assert.match(await page.textContent('#view'), /Approved[\s\S]*Dunkin’ credit/);
  });

  await t.test('an out-of-date proposal can’t be approved; Reject records the decision', async () => {
    await adm(db => db.doc(`${U()}/proposals/stale-1`).set({ domain: 'credits', targetId: 'gold-dunkin', kind: 'amount_change', current: { amounts: [{ amount: 7, from: '2000-01-01' }] }, proposed: { amount: 9 }, effectiveFrom: `${Y + 1}-01-01`, source: { url: '', checkedAt: TODAY, excerpt: '' }, note: '', createdBy: 'manual', runId: null, status: 'pending', createdAt: new Date().toISOString(), decidedAt: null, applied: null }));
    const item = page.locator('[data-item="stale-1"]'); await item.waitFor();
    assert.match(await item.textContent(), /Out of date/);
    assert.equal(await item.locator('[data-approve]').isDisabled(), true);
    await item.locator('[data-reject]').click();
    assert.equal((await until(() => get(`${U()}/proposals/stale-1`).then(p => p.status !== 'pending' && p), 'rejected')).status, 'rejected');
    assert.equal((await get(`${U()}/credits/gold-dunkin`)).amounts.length, 2, 'nothing applied');
  });

  await t.test('check runs show per card; "couldn’t check" never reads as "no changes"; Approve all needs a confirm', async () => {
    const started = new Date().toISOString();
    await adm(async db => {
      await db.doc(`${U()}/checkRuns/run-1`).set({ startedAt: started, finishedAt: started, cards: { csr: { status: 'checked', pages: ['https://www.chase.com/'], matched: ['csr-travel', 'csr-lyft'] }, gold: { status: 'couldnt_check', reason: 'page didn’t load' }, bilt: { status: 'partial', reason: 'one page timed out', matched: ['bilt-cash'] } } });
      const base = { domain: 'credits', kind: 'amount_change', effectiveFrom: `${Y + 1}-01-01`, createdBy: 'bot', runId: 'run-1', status: 'pending', createdAt: started, note: '', decidedAt: null, applied: null };
      await db.doc(`${U()}/proposals/bot-1`).set({ ...base, targetId: 'csr-lyft', current: { amounts: [{ amount: 10, from: '2000-01-01' }] }, proposed: { amount: 12 }, source: { url: 'https://www.chase.com/sapphire', checkedAt: TODAY, excerpt: '$12 in Lyft credit' } });
      await db.doc(`${U()}/proposals/bot-2`).set({ ...base, targetId: 'bilt-hotel', current: { amounts: [{ amount: 200, from: '2000-01-01' }] }, proposed: { amount: 250 }, source: { url: 'https://www.bilt.com/card', checkedAt: TODAY, excerpt: '$250 hotel credit' } });
    });
    await page.locator('[data-item="bot-1"]').waitFor();
    await shot('5-review');
    const text = await page.textContent('#view');
    assert.match(text, /Sapphire Reserve: checked, changes found/);
    assert.match(text, /Gold Card: couldn’t check \(page didn’t load\)/);
    assert.match(text, /Palladium Card: partly checked \(one page timed out\)/);
    assert.doesNotMatch(text, /Gold Card: checked, no changes/);
    assert.match(await page.textContent('[data-item="bot-1"]'), /automatic check[\s\S]*Source: www\.chase\.com/);
    await page.click('#all'); await shot('6-approve-all-confirm');
    assert.equal((await list(`${U()}/proposals`))['bot-1'].status, 'pending', 'nothing applied by the first tap');
    await page.click('#all-yes');
    await until(async () => { const ps = await list(`${U()}/proposals`); return ps['bot-1'].status === 'approved' && ps['bot-2'].status === 'approved'; }, 'approve all');
    const lyft = await get(`${U()}/credits/csr-lyft`);
    assert.deepEqual(lyft.amounts.at(-1), { amount: 12, from: `${Y + 1}-01-01` });
    assert.equal(lyft.sourceUrl, 'https://www.chase.com/sapphire'); assert.equal(lyft.lastVerified, TODAY);
    await page.click('#back');
    await page.waitForFunction(() => [...document.querySelectorAll('.vtag')].map(x => x.textContent).join('|') === '9 credits to verify', null, { timeout: 5000 });
  });

  await t.test('a frequency change becomes end + add with a new ID, approved together; old check-offs still count', async () => {
    await page.click('[data-card="gold"]'); await page.click('[data-info="gold-dining"]'); await page.click('#in-edit');
    await page.selectOption('#ed-freq', 'half'); await page.fill('#ed-from', `${Y + 1}-01-01`); await page.fill('#ed-amount', '60');
    await page.click('#ed-form button[type=submit]');
    await page.click('#back'); await page.click('#review');
    const item = page.locator('[data-item*=","]'); await item.waitFor();
    assert.match(await item.textContent(), /Frequency or reset change/);
    await item.locator('[data-approve]').click();
    const nid = `gold-dining-${Y + 1}01`;
    const added = await until(() => get(`${U()}/credits/${nid}`), 'new credit');
    assert.equal(added.freq, 'half'); assert.equal(added.activeFrom, `${Y + 1}-01-01`);
    assert.deepEqual(added.amounts, [{ amount: 60, from: `${Y + 1}-01-01` }]);
    assert.equal((await get(`${U()}/credits/gold-dining`)).activeTo, `${Y}-12-31`);
    assert.equal(Object.values(await list(`${U()}/proposals`)).filter(p => p.group).every(p => p.status === 'approved'), true, 'both halves approved');
    await page.click('nav [data-tab="value"]');
    assert.equal(await page.textContent('.hero .big'), fmt(usedThisYear(backup.data)), 'used this year unchanged');
  });

  await t.test('Add credit → approve → it shows on the card page', async () => {
    await toCards(); await page.click('[data-card="bilt"]'); await page.click('#add-credit');
    await page.fill('#ad-name', 'Lounge credit'); await page.fill('#ad-amount', '100'); await page.selectOption('#ad-freq', 'year'); await page.fill('#ad-from', `${Y + 1}-01-01`);
    await page.click('#ad-form button[type=submit]');
    await page.click('#back'); await page.click('#review');
    await page.locator('[data-item]').filter({ hasText: 'Lounge credit' }).locator('[data-approve]').click();
    await until(() => get(`${U()}/credits/bilt-lounge-credit`), 'added credit');
    await page.click('#back'); await page.click('[data-card="bilt"]');
    assert.match(await page.textContent('#view'), new RegExp(`Lounge credit[\\s\\S]*Starts Jan 1, ${Y + 1}`));
  });

  await t.test('every new button gets the haptic overlay', async () => {
    const counts = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.querySelectorAll(':scope > label.hap > input[switch]').length));
    assert.ok(counts.length > 10 && counts.every(n => n === 1), JSON.stringify(counts));
  });

  await t.test('export includes the catalog and proposals; the monthly snapshot does too', async () => {
    await page.click('#back');
    assert.equal(await page.isVisible('#review'), false, 'Review row hidden when nothing is pending');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exp')]);
    const b = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    assert.equal(b.version, 2);
    assert.ok(Object.keys(b.data.credits).length >= 19 && b.data.credits['gold-dunkin'].amounts.length === 2);
    assert.ok(Object.keys(b.data.proposals).length >= 6);
    const snap = await get(`${U()}/snapshots/${YM}`);
    assert.ok(snap && Object.keys(snap.credits).length === 17 && 'proposals' in snap, 'monthly snapshot has the catalog');
  });

  await t.test('importing an old (version 1) backup with Replace keeps the catalog and schemaVersion', async () => {
    const before = Object.keys(await list(`${U()}/credits`)).length, fixtureLog = JSON.parse(readFileSync(FIXTURE, 'utf8')).data.log;
    await page.setInputFiles('#importFile', FIXTURE); await page.click('#im-go');
    const u = await until(async () => { const x = await get(U()); return JSON.stringify(x.log) === JSON.stringify(fixtureLog) && x; }, 'replaced');
    assert.equal(u.schemaVersion, 2);
    assert.equal(Object.keys(await list(`${U()}/credits`)).length, before, 'no credit deleted');
    const pre = Object.entries(await list(`${U()}/snapshots`)).find(([id]) => id.startsWith('before-import-'));
    assert.ok(pre && Object.keys(pre[1].credits).length === before, 'pre-import copy includes the catalog');
  });

  await t.test('an older cached copy of the app still works on the migrated data', async () => {
    await openTracker(server.url + 'old.html');
    const key = `gold-dunkin|${YM}`, was = !!(await get(U())).log[key];
    await page.click('[data-toggle="gold-dunkin"]');
    await until(async () => !!(await get(U())).log[key] !== was, 'old app check-off saved');
    await openTracker(server.url);
    assert.equal(await page.getAttribute('[data-toggle="gold-dunkin"]', 'aria-pressed'), String(!was), 'new app sees it');
    assert.equal((await get(U())).schemaVersion, 2);
  });

  await t.test('returning to the app after pagehide reloads it and keeps working', async () => {
    await Promise.all([page.waitForEvent('load'), page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); })]);
    await page.waitForSelector('.trow', { timeout: 20000 });
    await until(async () => (await page.textContent('#sync')) === 'Saved', 'Saved after reload');
  });

  await t.test('no page errors, and no form was ever submitted twice', () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrs.filter(m => /Form submission canceled/.test(m)), []);
  });
});
