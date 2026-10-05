import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CREDITS, HANDLERS, problemWith, planApproval, makeProposal, proposalsFromEdit, splitReplace, idForNewCredit, cleanCredit } from '../../catalog.js';
import { periodAt, usedInYear, possibleForYear } from '../../calc.js';
import { CREDITS as LEGACY } from '../fixtures/legacy-calc.js';

const cat = () => Object.fromEntries(SEED_CREDITS.map(({ id, ...c }) => [id, { id, ...c }]));
const P = (o) => makeProposal(o, new Date('2026-10-04T12:00:00Z'));
const TODAY = '2026-10-04';

test('seed keeps every existing credit ID, order and the special cases', () => {
  assert.deepEqual(SEED_CREDITS.map(c => c.id), LEGACY.map(c => c.id));
  const by = Object.fromEntries(SEED_CREDITS.map(c => [c.id, c]));
  assert.deepEqual(by['csr-dd-r'].amounts, [{ amount: 5, from: '2000-01-01' }, { amount: 15, from: '2026-10-01' }]);
  assert.deepEqual([by['csr-select'].activeFrom, by['csr-select'].activeTo], ['2026-01-01', '2026-12-31']);
  assert.equal(by['csr-lyft'].activeTo, '2027-09-30');
  assert.equal(by['bilt-cash'].valuation, 'biltCash');
  assert.deepEqual(SEED_CREDITS.filter(c => c.resetOn === 'anniversary').map(c => c.id), ['csr-travel', 'bilt-cash']);
  assert.ok(SEED_CREDITS.every(c => c.lastVerified === null));
});

test('amount_change appends {amount, from}, and sets lastVerified and sourceUrl from the proposal', () => {
  const c = cat(), live = c['gold-dunkin'];
  const p = P({ kind: 'amount_change', targetId: 'gold-dunkin', current: { amounts: live.amounts }, proposed: { amount: 8 }, effectiveFrom: '2027-01-01', source: { url: 'https://example.com/gold', checkedAt: '2026-10-02', excerpt: '$8 a month' }, note: 'Raised to $8' });
  const [r] = planApproval([p], c, TODAY);
  assert.deepEqual(r.write.amounts, [...live.amounts, { amount: 8, from: '2027-01-01' }]);
  assert.equal(r.write.lastVerified, '2026-10-02');
  assert.equal(r.write.sourceUrl, 'https://example.com/gold');
  assert.equal(r.write.changeNote, 'Raised to $8');
  assert.deepEqual(r.applied, r.write, 'the audit trail records exactly what was written');
});

test('amount_change is refused when dated on or before the latest amount', () => {
  const c = cat(), live = c['csr-dd-r'];
  for (const d of ['2026-09-15', '2026-10-01']) {
    const p = P({ kind: 'amount_change', targetId: 'csr-dd-r', current: { amounts: live.amounts }, proposed: { amount: 20 }, effectiveFrom: d });
    assert.match(problemWith(p, c), /must start after 2026-10-01/, d);
    assert.throws(() => planApproval([p], c, TODAY));
  }
});

test('out of date: proposals whose current values no longer match the live credit can’t be approved', () => {
  const c = cat();
  const stale = P({ kind: 'amount_change', targetId: 'csr-dd-r', current: { amounts: [{ amount: 5, from: '2000-01-01' }] }, proposed: { amount: 20 }, effectiveFrom: '2027-01-01' });
  assert.match(problemWith(stale, c), /Out of date/);
  const other = P({ kind: 'other', targetId: 'gold-uber', current: { name: 'Uber Credit' }, proposed: { name: 'Uber Cash monthly' }, effectiveFrom: TODAY });
  assert.match(problemWith(other, c), /Out of date/);
  const ended = P({ kind: 'ended', targetId: 'csr-lyft', current: { activeTo: null }, proposed: { activeTo: '2027-06-30' }, effectiveFrom: '2027-06-30' });
  assert.match(problemWith(ended, c), /Out of date/, 'Lyft already ends 2027-09-30');
});

test('added creates the credit with activeFrom = effectiveFrom; refused if the ID exists', () => {
  const c = cat(), id = idForNewCredit('gold', 'Hotel credit', Object.keys(c));
  assert.equal(id, 'gold-hotel-credit');
  const p = P({ kind: 'added', targetId: id, proposed: { card: 'gold', name: 'Hotel credit', freq: 'half', resetOn: 'calendar', amount: 50, valuation: 'dollars', how: 'h', info: ['i'] }, effectiveFrom: '2027-01-01' });
  const [r] = planApproval([p], c, TODAY);
  assert.equal(r.create, true);
  assert.equal(r.write.activeFrom, '2027-01-01');
  assert.deepEqual(r.write.amounts, [{ amount: 50, from: '2027-01-01' }]);
  assert.equal(r.write.activeTo, null);
  assert.match(problemWith({ ...p, targetId: 'gold-uber' }, c), /already exists/);
});

test('ended sets activeTo; other edits name, how, info and sourceUrl only', () => {
  const c = cat();
  const [e] = planApproval([P({ kind: 'ended', targetId: 'csr-peloton', current: { activeTo: null }, proposed: { activeTo: '2026-12-31' }, effectiveFrom: '2026-12-31' })], c, TODAY);
  assert.equal(e.write.activeTo, '2026-12-31');
  const live = c['gold-dining'];
  const o = P({ kind: 'other', targetId: 'gold-dining', current: { name: live.name, info: live.info }, proposed: { name: 'Dining partners credit', info: ['New list'] }, effectiveFrom: TODAY });
  const [r] = planApproval([o], c, TODAY);
  assert.equal(r.write.name, 'Dining partners credit');
  assert.deepEqual(r.write.info, ['New list']);
  assert.equal(r.write.amounts, undefined, 'amounts untouched');
  assert.match(problemWith(P({ kind: 'other', targetId: 'gold-dining', current: { freq: 'month' }, proposed: { freq: 'half' }, effectiveFrom: TODAY }), c), /end this credit and add a new one/);
});

test('a frequency change from the Edit form becomes end + add with a new ID; old check-offs keep their keys', () => {
  const c = cat(), live = c['gold-dining'];
  const ps = proposalsFromEdit(live, { name: live.name, how: live.how, info: live.info, sourceUrl: null, amount: 60, amountFrom: '2027-01-01', freq: 'half', resetOn: 'calendar', note: 'Now $60 twice a year' }, Object.keys(c), new Date('2026-10-04T12:00:00Z'));
  assert.deepEqual(ps.map(p => p.kind), ['ended', 'added']);
  assert.equal(ps[0].group, ps[1].group);
  assert.equal(ps[0].proposed.activeTo, '2026-12-31');
  assert.equal(ps[1].targetId, 'gold-dining-202701');
  const steps = planApproval(ps, c, TODAY);
  const after = { ...c, 'gold-dining': { ...live, ...steps[0].write }, 'gold-dining-202701': { id: 'gold-dining-202701', ...steps[1].write } };
  assert.equal(after['gold-dining'].activeTo, '2026-12-31');
  assert.equal(after['gold-dining-202701'].freq, 'half');
  assert.equal(after['gold-dining-202701'].activeFrom, '2027-01-01');
  // the old check-off still resolves to the old credit and period, and counts as before
  const log = { 'gold-dining|2026-08': { amt: 10, face: 10, card: 'gold', ym: '2026-08' } };
  assert.equal(periodAt(after['gold-dining'], 2026, 8, {}).key, '2026-08');
  assert.equal(usedInYear(log, 2026, id => after[id], {}).byCredit['gold-dining'], 10);
  const ctx = { anniv: {}, off: {}, biltRate: 0.5 };
  assert.equal(possibleForYear(after['gold-dining'], 2026, ctx), 120, '2026 unchanged');
  assert.equal(possibleForYear(after['gold-dining'], 2027, ctx) + possibleForYear(after['gold-dining-202701'], 2027, ctx), 120, '2027: two halves of $60');
  assert.throws(() => splitReplace(live, { freq: 'half' }, '1999-01-01', []), /must start after/);
});

test('Edit form: an amount-only change makes one amount_change; no changes make nothing', () => {
  const c = cat(), live = c['gold-dunkin'];
  const same = { name: live.name, how: live.how, info: live.info, sourceUrl: null, amount: 7, amountFrom: '2026-11-01', freq: 'month', resetOn: 'calendar' };
  assert.deepEqual(proposalsFromEdit(live, same, []), []);
  const ps = proposalsFromEdit(live, { ...same, amount: 8 }, []);
  assert.deepEqual(ps.map(p => [p.kind, p.proposed.amount, p.effectiveFrom, p.createdBy, p.status]), [['amount_change', 8, '2026-11-01', 'manual', 'pending']]);
  const end = proposalsFromEdit(live, { ...same, activeTo: '2026-12-31' }, []);
  assert.deepEqual(end.map(p => p.kind), ['ended']);
});

test('registry: one handler per domain; unknown domains are refused', () => {
  assert.deepEqual(Object.keys(HANDLERS), ['credits']);
  assert.match(problemWith({ domain: 'rewards', kind: 'other', targetId: 'x' }, {}), /No handler/);
});

test('backup import validation keeps good credits and drops bad ones', () => {
  const good = cleanCredit('gold-uber', { ...cat()['gold-uber'] }, ['csr', 'gold', 'bilt']);
  assert.equal(good.name, 'Uber Cash');
  assert.equal(cleanCredit('Bad ID', { ...cat()['gold-uber'] }, ['gold']), null);
  assert.equal(cleanCredit('x', { ...cat()['gold-uber'], freq: 'weekly' }, ['gold']), null);
});
