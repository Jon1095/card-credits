import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../calc.js';
import { SEED_CREDITS, planApproval, makeProposal } from '../../catalog.js';
import { legacy, CREDITS as LEGACY } from '../fixtures/legacy-calc.js';

const credit = (o) => ({ id: 'x', card: 'gold', name: 'X', freq: 'month', resetOn: 'calendar', valuation: 'dollars', activeFrom: '2000-01-01', activeTo: null, amounts: [{ amount: 10, from: '2000-01-01' }], ...o });
const ctx = { anniv: { csr: 5, bilt: 11 }, off: {}, biltRate: 0.5 };
const amounts = (c, Y) => C.periodsInYear(c, Y, ctx).map(p => p.amount);

test('amount change mid-year: monthly $5 → $15 from Oct 1', () => {
  const c = credit({ amounts: [{ amount: 5, from: '2000-01-01' }, { amount: 15, from: '2026-10-01' }] });
  assert.deepEqual(amounts(c, 2026), [5, 5, 5, 5, 5, 5, 5, 5, 5, 15, 15, 15]);
  assert.equal(C.possibleForYear(c, 2026, ctx), 90);
});

test('change dated mid-period takes effect from the next period: half-year changed Mar 15', () => {
  const c = credit({ freq: 'half', amounts: [{ amount: 100, from: '2000-01-01' }, { amount: 150, from: '2026-03-15' }] });
  assert.deepEqual(amounts(c, 2026), [100, 150]);
  assert.equal(C.amountFor(c, C.periodAt(c, 2026, 5, ctx)), 100, 'May is still in H1, at the old amount');
});

test('credit ended mid-year: monthly $10, activeTo Jun 30', () => {
  const c = credit({ activeTo: '2026-06-30' });
  assert.equal(C.periodsInYear(c, 2026, ctx).length, 6);
  assert.equal(C.possibleForYear(c, 2026, ctx), 60);
  assert.equal(C.trackerRows([c], 2026, 6, ctx).length, 1, 'June still shows');
  for (let m = 7; m <= 12; m++) assert.equal(C.trackerRows([c], 2026, m, ctx).length, 0, `no Tracker row in month ${m}`);
});

test('credit added mid-year: monthly $10 from Apr 15', () => {
  const c = credit({ activeFrom: '2026-04-15', amounts: [{ amount: 10, from: '2026-04-15' }] });
  const ps = C.periodsInYear(c, 2026, ctx);
  assert.equal(ps.length, 9);
  assert.equal(ps[0].key, '2026-04', 'April counts');
  assert.equal(ps[0].amount, 10);
  assert.equal(C.possibleForYear(c, 2026, ctx), 90);
  assert.equal(C.trackerRows([c], 2026, 3, ctx).length, 0, 'no row in March');
});

test('yearly credit added mid-year behaves as before the catalog', () => {
  const S = { anniv: ctx.anniv, off: {}, biltRate: 0.5, log: {} };
  const old = legacy(S), oldC = { id: 'y', card: 'csr', freq: 'year', amt: 250, start: '2026-06' };
  const c = credit({ id: 'y', card: 'csr', freq: 'year', activeFrom: '2026-06-01', amounts: [{ amount: 250, from: '2026-06-01' }] });
  for (const Y of [2025, 2026, 2027]) assert.equal(C.possibleForYear(c, Y, ctx), old.possibleByCredit(oldC, Y), `year ${Y}`);
  const late = credit({ freq: 'year', activeFrom: '2026-06-15', amounts: [{ amount: 250, from: '2026-06-15' }] });
  assert.equal(C.possibleForYear(late, 2026, ctx), 250, 'added Jun 15: counts once in 2026 at its amount');
  assert.equal(C.possibleForYear(late, 2025, ctx), 0);
});

test('anniversary credits: same periods, keys and yearly totals as before', () => {
  const S = { anniv: { csr: 5, bilt: 11 }, off: {}, biltRate: 0.4, log: {} };
  const old = legacy(S), c2 = { ...ctx, anniv: S.anniv, biltRate: 0.4 };
  for (const id of ['csr-travel', 'bilt-cash']) {
    const n = SEED_CREDITS.find(c => c.id === id), o = LEGACY.find(c => c.id === id);
    for (let y = 2025; y <= 2027; y++) for (let m = 1; m <= 12; m++) {
      const p = C.periodAt(n, y, m, c2);
      assert.equal(p.key, old.periodKey(o, y, m), `${id} ${y}-${m}`);
      assert.equal(Date.parse(p.next + 'T00:00:00'), old.periodEnd(o, y, m).getTime(), `${id} reset date ${y}-${m}`);
    }
    for (const Y of [2025, 2026, 2027]) assert.equal(C.possibleForYear(n, Y, c2), old.possibleByCredit(o, Y), `${id} possible ${Y}`);
  }
  assert.equal(C.periodAt(SEED_CREDITS.find(c => c.id === 'bilt-cash'), 2026, 1, { anniv: { bilt: null } }).key, '2026', 'anniversary not set falls back to the calendar year');
});

test('every seeded credit matches the old app: keys, Tracker rows, amounts and possible (2025–2027)', () => {
  const S = { anniv: { csr: 5, bilt: 11 }, off: { 'csr-peloton': true, 'csr-select': true }, biltRate: 0.5, log: {} };
  const old = legacy(S), c2 = { anniv: S.anniv, off: S.off, biltRate: 0.5 };
  for (const o of LEGACY) {
    const n = SEED_CREDITS.find(c => c.id === o.id);
    for (let y = 2025; y <= 2027; y++) {
      for (let m = 1; m <= 12; m++) {
        const p = C.periodAt(n, y, m, c2);
        assert.equal(p.key, old.periodKey(o, y, m), `${o.id} key ${y}-${m}`);
        const shown = C.trackerRows([n], y, m, c2).length === 1;
        assert.equal(shown, old.isOn(o) && old.activeAt(o, y, m), `${o.id} shown ${y}-${m}`);
        if (shown) assert.equal(C.amountFor(n, p), old.amtAt(o, y, m), `${o.id} amount ${y}-${m}`);
      }
      assert.equal(C.possibleForYear(n, y, c2), old.possibleByCredit(o, y), `${o.id} possible ${y}`);
    }
  }
});

test('used totals come from the saved check-offs, as before', () => {
  const log = {
    'gold-uber|2026-01': { amt: 10, face: 10, card: 'gold', ym: '2026-01' },
    'bilt-cash|CY2025-11': { amt: 200, face: 200, card: 'bilt', ym: '2026-01' },
    'csr-travel|CY2025-05': { amt: 300, face: 300, card: 'csr', ym: '2026-02' },
    'csr-dd-r|2025-12': { amt: 5, face: 5, card: 'csr', ym: '2025-12' }
  };
  const S = { anniv: { csr: 5, bilt: 11 }, off: {}, biltRate: 0.5, log }, old = legacy(S);
  const byId = id => SEED_CREDITS.find(c => c.id === id);
  for (const Y of [2025, 2026]) {
    const u = C.usedInYear(log, Y, byId, { biltRate: 0.5 });
    for (const card of ['csr', 'gold', 'bilt']) assert.equal(u.byCard[card] || 0, old.usedInYear(card, Y), `${card} ${Y}`);
    for (const o of LEGACY) assert.equal(u.byCredit[o.id] || 0, old.usedByCredit(o, Y), `${o.id} ${Y}`);
  }
  assert.equal(C.usedInYear(log, 2026, byId, { biltRate: 0.5 }).byMonth[0].bilt, 100, 'Bilt Cash at 50¢ in January');
});

test('after an amount change and after ending a credit, last year’s totals don’t change', () => {
  const c = credit({ id: 'gold-uber' }), cat = { 'gold-uber': c };
  const log = { 'gold-uber|2025-04': { amt: 10, face: 10, card: 'gold', ym: '2025-04' }, 'gold-uber|2026-02': { amt: 10, face: 10, card: 'gold', ym: '2026-02' } };
  const totals = (cr) => ({ possible: C.possibleForYear(cr, 2025, ctx), used: C.usedInYear(log, 2025, () => cr, ctx).byCard.gold });
  const before = totals(c);
  const [{ write: w1 }] = planApproval([makeProposal({ kind: 'amount_change', targetId: 'gold-uber', current: { amounts: c.amounts }, proposed: { amount: 15 }, effectiveFrom: '2026-07-01' })], cat, '2026-10-04');
  const changed = { ...c, ...w1 };
  assert.deepEqual(totals(changed), before, 'amount change');
  assert.equal(C.possibleForYear(changed, 2026, ctx), 6 * 10 + 6 * 15, 'this year picks it up from July');
  const [{ write: w2 }] = planApproval([makeProposal({ kind: 'ended', targetId: 'gold-uber', current: { activeTo: null }, proposed: { activeTo: '2026-03-31' }, effectiveFrom: '2026-03-31' })], { 'gold-uber': changed }, '2026-10-04');
  assert.deepEqual(totals({ ...changed, ...w2 }), before, 'ended');
  assert.deepEqual(log['gold-uber|2026-02'], { amt: 10, face: 10, card: 'gold', ym: '2026-02' }, 'saved check-offs are never touched');
});

test('section totals use the face saved with a check-off', () => {
  const c = credit({ amounts: [{ amount: 5, from: '2000-01-01' }, { amount: 15, from: '2026-10-01' }] });
  const rows = C.trackerRows([c], 2026, 9, ctx, { 'x|2026-09': { amt: 5, face: 5, card: 'gold', ym: '2026-09' } });
  assert.deepEqual(C.sectionTotals(rows, ctx), { used: 5, total: 5 });
  const oct = C.trackerRows([c], 2026, 10, ctx, {});
  assert.deepEqual(C.sectionTotals(oct, ctx), { used: 0, total: 15 });
});

test('calendar file credits: on, current, with this period’s amount', () => {
  const cs = [credit({ id: 'a' }), credit({ id: 'b', activeTo: '2026-09-30' }), credit({ id: 'h', freq: 'half', amounts: [{ amount: 50, from: '2000-01-01' }] }), credit({ id: 'off' })];
  const r = C.calendarCredits(cs, '2026-10-04', { ...ctx, off: { off: true } });
  assert.deepEqual(r.month.map(x => x.c.id), ['a']);
  assert.deepEqual(r.half.map(x => [x.c.id, x.amount]), [['h', 50]]);
});

test('staleness: missing or over 90 days; a matching check run counts as verified', () => {
  const c = credit({ id: 'gold-uber', lastVerified: null });
  assert.equal(C.isStale(c, [], '2026-10-04'), true);
  assert.equal(C.isStale({ ...c, lastVerified: '2026-07-06' }, [], '2026-10-04'), false, '90 days old is not stale');
  assert.equal(C.isStale({ ...c, lastVerified: '2026-07-05' }, [], '2026-10-04'), true, '91 days old is stale');
  const runs = [{ startedAt: '2026-09-01T10:00:00Z', finishedAt: '2026-09-01T10:05:00Z', cards: { gold: { status: 'checked', matched: ['gold-uber'] } } },
                { startedAt: '2026-10-01T10:00:00Z', cards: { gold: { status: 'couldnt_check', matched: [] } } }];
  assert.equal(C.verifiedDate(c, runs), '2026-09-01', 'a run that couldn’t check doesn’t verify anything');
  assert.equal(C.isStale(c, runs, '2026-10-04'), false);
});
