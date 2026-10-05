/* The credit catalog: migration, the review queue's proposal handlers, and the logic that turns the
   Edit / Add credit forms into proposals. Nothing here touches the DOM. The few Firestore calls are
   passed in (fs = {doc, runTransaction}), so the same code runs in the app (CDN SDK) and in the
   Node tests (npm SDK against the emulator).

   Proposal (users/{uid}/proposals/{id}):
     domain 'credits' | 'rewards' (later)      targetId    the credit ID
     kind   'amount_change' | 'added' | 'ended' | 'other'
     current   the values as they were when proposed (used to detect out-of-date proposals)
     proposed  the new values                  effectiveFrom 'YYYY-MM-DD'
     source {url, checkedAt, excerpt}          note        createdBy 'manual' | 'bot'
     runId     status 'pending' | 'approved' | 'rejected' | 'superseded'
     createdAt decidedAt (ISO strings)         applied     exactly what was written
     group     optional: proposals that must be approved together (end + add) */

import { SEED_CREDITS } from './catalog-seed.js';
import { amountOn, dayBefore } from './calc.js';
export { SEED_CREDITS };

export const SCHEMA_VERSION = 2;
export const FREQS = ['month', 'half', 'year'];
export const RESETS = ['calendar', 'anniversary'];
export const KINDS = ['amount_change', 'added', 'ended', 'other'];
export const OTHER_FIELDS = ['name', 'how', 'info', 'sourceUrl'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9-]{1,64}$/;

export const isDate = d => typeof d === 'string' && DATE.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
}
const latestFrom = c => (c.amounts || []).reduce((d, h) => (h.from > d ? h.from : d), '');

/* ---------- migration ----------
   One transaction: if the user doc isn't on schema 2, or any seed credit is missing, copy the whole
   user doc to snapshots/pre-catalog-<timestamp>, create the missing credits (existing ones are never
   overwritten), and set schemaVersion: 2. Nothing else in the user doc is touched. Safe to run twice
   and from two devices at once: the second transaction sees the first one's writes and does nothing. */
export async function migrateToCatalog(fs, db, uid, now = new Date()) {
  const userRef = fs.doc(db, 'users', uid);
  const refs = SEED_CREDITS.map(c => fs.doc(db, 'users', uid, 'credits', c.id));
  return fs.runTransaction(db, async tx => {
    const user = await tx.get(userRef);
    if (!user.exists()) return { migrated: false, reason: 'no user document' };
    const snaps = [];
    for (const r of refs) snaps.push(await tx.get(r));   // every read before any write
    const missing = SEED_CREDITS.filter((_, i) => !snaps[i].exists());
    const data = user.data();
    if (data.schemaVersion === SCHEMA_VERSION && missing.length === 0) return { migrated: false, reason: 'already migrated' };
    const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
    tx.set(fs.doc(db, 'users', uid, 'snapshots', `pre-catalog-${stamp}`), { ...data, takenAt: now.toISOString() });
    for (const c of missing) {
      const { id, ...fields } = c;
      tx.set(fs.doc(db, 'users', uid, 'credits', id), { ...fields, updatedAt: now.toISOString() });
    }
    tx.update(userRef, { schemaVersion: SCHEMA_VERSION });
    return { migrated: true, created: missing.map(c => c.id), snapshot: `pre-catalog-${stamp}` };
  });
}

/* ---------- review queue: handlers per domain ----------
   A handler answers two questions about a proposal against the live data:
     problem(p, catalog)        why it can't be approved as-is, or null
     apply(p, catalog, today)   {id, write, applied}: the fields to write to the target document
   Approving writes `write` and the proposal's new status in one batch. A later domain (rewards)
   only adds an entry to HANDLERS. */
function outOfDate(p, live) {
  switch (p.kind) {
    case 'added': return !!live;
    case 'amount_change': return !deepEqual(p.current?.amounts ?? null, live.amounts ?? null);
    case 'ended': return !deepEqual(p.current?.activeTo ?? null, live.activeTo ?? null);
    case 'other': return Object.keys(p.proposed || {}).some(k => !deepEqual(p.current?.[k] ?? null, live[k] ?? null));
    default: return false;
  }
}

const creditsHandler = {
  problem(p, catalog) {
    const live = catalog[p.targetId] || null;
    const P = p.proposed || {};
    if (!KINDS.includes(p.kind)) return `Unknown kind "${p.kind}".`;
    if (p.kind !== 'added' && !live) return 'This credit doesn’t exist.';
    if (outOfDate(p, live)) return p.kind === 'added' ? 'A credit with this ID already exists.' : 'Out of date: the credit has changed since this was proposed.';
    if (p.kind === 'amount_change') {
      if (!(typeof P.amount === 'number' && P.amount >= 0)) return 'The new amount isn’t a valid number.';
      if (!isDate(p.effectiveFrom)) return 'The effective date isn’t valid.';
      const last = latestFrom(live);
      if (p.effectiveFrom <= last) return `The new amount must start after ${last}, the date of the latest amount.`;
    }
    if (p.kind === 'added') {
      if (!ID.test(p.targetId || '')) return 'The credit ID isn’t valid.';
      if (!isDate(p.effectiveFrom)) return 'The start date isn’t valid.';
      if (!P.card || !P.name || !FREQS.includes(P.freq) || !RESETS.includes(P.resetOn)) return 'The new credit is missing its card, name, frequency or reset.';
      if (!(typeof P.amount === 'number' && P.amount >= 0)) return 'The amount isn’t a valid number.';
    }
    if (p.kind === 'ended') {
      if (!isDate(P.activeTo)) return 'The end date isn’t valid.';
      if (live.activeFrom && P.activeTo < live.activeFrom) return 'The end date is before the credit started.';
    }
    if (p.kind === 'other') {
      const keys = Object.keys(P);
      if (keys.some(k => k === 'freq' || k === 'resetOn')) return 'Frequency and reset changes end this credit and add a new one.';
      if (!keys.length || keys.some(k => !OTHER_FIELDS.includes(k))) return 'Only the name, how-to, details and source link can be edited this way.';
    }
    return null;
  },

  apply(p, catalog, today) {
    const live = catalog[p.targetId] || null, P = p.proposed || {};
    const verified = { lastVerified: (p.source?.checkedAt || today).slice(0, 10), changeNote: p.note || null };
    const url = p.source?.url || P.sourceUrl || null;
    if (url) verified.sourceUrl = url;
    let write;
    if (p.kind === 'amount_change') write = { amounts: [...live.amounts, { amount: P.amount, from: p.effectiveFrom }] };
    if (p.kind === 'ended') write = { activeTo: P.activeTo };
    if (p.kind === 'other') write = { ...P };
    if (p.kind === 'added') {
      const maxSort = Math.max(0, ...Object.values(catalog).map(c => c.sortOrder || 0));
      write = {
        card: P.card, name: P.name, freq: P.freq, resetOn: P.resetOn,
        amounts: [{ amount: P.amount, from: p.effectiveFrom }], activeFrom: p.effectiveFrom, activeTo: P.activeTo || null,
        valuation: P.valuation === 'biltCash' ? 'biltCash' : 'dollars', how: P.how || '', info: P.info || [],
        sourceUrl: null, sortOrder: P.sortOrder ?? maxSort + 10
      };
    }
    write = { ...write, ...verified, updatedAt: new Date().toISOString() };
    return { id: p.targetId, create: p.kind === 'added', write, applied: write };
  }
};
export const HANDLERS = { credits: creditsHandler };

/** Why a proposal can't be approved as-is (out of date, invalid), or null. */
export const problemWith = (p, catalog) => (HANDLERS[p.domain] ? HANDLERS[p.domain].problem(p, catalog) : `No handler for "${p.domain}".`);

/** The writes for approving one proposal, or a group (end + add) together. Throws if any can't be
    approved. Returns [{proposal, id, create, write}] in order; apply each to its own catalog in turn
    so a group's second step sees the first. */
export function planApproval(proposals, catalog, today) {
  const cat = { ...catalog }, out = [];
  for (const p of proposals) {
    const why = problemWith(p, cat);
    if (why) throw new Error(why);
    const r = HANDLERS[p.domain].apply(p, cat, today);
    cat[r.id] = r.create ? { id: r.id, ...r.write } : { ...cat[r.id], ...r.write };
    out.push({ proposal: p, ...r });
  }
  return out;
}

/* ---------- making proposals (manual edits, and the shape the checker will use) ---------- */
export function makeProposal(fields, now = new Date()) {
  return {
    domain: 'credits', current: null, note: '', source: { url: '', checkedAt: now.toISOString().slice(0, 10), excerpt: '' },
    createdBy: 'manual', runId: null, status: 'pending', createdAt: now.toISOString(), decidedAt: null, applied: null,
    ...fields
  };
}

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'credit';
/** A new, unused credit ID. */
export function newCreditId(base, takenIds) {
  const taken = new Set(takenIds);
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}
export const idForNewCredit = (card, name, takenIds) => newCreditId(`${card}-${slug(name)}`, takenIds);

/** A frequency or reset change: end the old credit the day before `effectiveFrom` and add a new one
    with a new ID, so check-offs already logged under the old ID keep their period keys. */
export function splitReplace(live, changes, effectiveFrom, takenIds, base = {}) {
  if (!isDate(effectiveFrom) || effectiveFrom <= (live.activeFrom || '')) throw new Error('The change must start after the credit started.');
  const group = `replace-${live.id}-${effectiveFrom}`;
  const newId = newCreditId(`${live.id}-${effectiveFrom.slice(0, 7).replace('-', '')}`, takenIds);
  const ended = makeProposal({ ...base, kind: 'ended', targetId: live.id, current: { activeTo: live.activeTo ?? null }, proposed: { activeTo: dayBefore(effectiveFrom) }, effectiveFrom, group });
  const proposed = {
    card: live.card, name: changes.name ?? live.name, freq: changes.freq ?? live.freq, resetOn: changes.resetOn ?? live.resetOn,
    amount: changes.amount ?? amountOn(live, effectiveFrom), valuation: live.valuation, how: changes.how ?? live.how, info: changes.info ?? live.info,
    sortOrder: (live.sortOrder || 0) + 1, replaces: live.id
  };
  if (live.activeTo) proposed.activeTo = live.activeTo;
  const added = makeProposal({ ...base, kind: 'added', targetId: newId, current: null, proposed, effectiveFrom, group });
  return [ended, added];
}

/** Turn the Edit form into proposals. form: {name, how, info[], sourceUrl, amount, amountFrom,
    freq, resetOn, activeTo, note}. Returns [] when nothing changed. */
export function proposalsFromEdit(live, form, takenIds, now = new Date()) {
  const base = { note: form.note || '', source: { url: form.sourceUrl || '', checkedAt: now.toISOString().slice(0, 10), excerpt: '' } };
  const effective = form.amountFrom;
  if ((form.freq && form.freq !== live.freq) || (form.resetOn && form.resetOn !== live.resetOn)) {
    const changes = { freq: form.freq, resetOn: form.resetOn, name: form.name, how: form.how, info: form.info };
    if (typeof form.amount === 'number') changes.amount = form.amount;
    return splitReplace(live, changes, effective, takenIds, base);
  }
  const out = [];
  if (typeof form.amount === 'number' && isDate(effective) && form.amount !== amountOn(live, effective))
    out.push(makeProposal({ ...base, kind: 'amount_change', targetId: live.id, current: { amounts: live.amounts }, proposed: { amount: form.amount }, effectiveFrom: effective }, now));
  const changed = {};
  for (const k of OTHER_FIELDS) if (form[k] !== undefined && !deepEqual(form[k] || (k === 'info' ? [] : null), live[k] || (k === 'info' ? [] : null))) changed[k] = form[k];
  if (Object.keys(changed).length)
    out.push(makeProposal({ ...base, kind: 'other', targetId: live.id, current: Object.fromEntries(Object.keys(changed).map(k => [k, live[k] ?? null])), proposed: changed, effectiveFrom: now.toISOString().slice(0, 10) }, now));
  if ((form.activeTo || null) !== (live.activeTo || null) && form.activeTo)
    out.push(makeProposal({ ...base, kind: 'ended', targetId: live.id, current: { activeTo: live.activeTo ?? null }, proposed: { activeTo: form.activeTo }, effectiveFrom: form.activeTo }, now));
  return out;
}

/* ---------- backups: validate catalog and proposal documents from a file ---------- */
export function cleanCredit(id, c, cards) {
  if (!ID.test(id) || !c || typeof c !== 'object') return null;
  if (!cards.includes(c.card) || !FREQS.includes(c.freq) || !RESETS.includes(c.resetOn)) return null;
  if (!Array.isArray(c.amounts) || !c.amounts.length || !c.amounts.every(h => typeof h?.amount === 'number' && isDate(h.from))) return null;
  if (!isDate(c.activeFrom) || (c.activeTo != null && !isDate(c.activeTo))) return null;
  return {
    card: c.card, name: String(c.name || ''), freq: c.freq, resetOn: c.resetOn,
    amounts: [...c.amounts].map(h => ({ amount: h.amount, from: h.from })).sort((a, b) => (a.from < b.from ? -1 : 1)),
    activeFrom: c.activeFrom, activeTo: c.activeTo ?? null, valuation: c.valuation === 'biltCash' ? 'biltCash' : 'dollars',
    how: String(c.how || ''), info: Array.isArray(c.info) ? c.info.map(String) : [], sourceUrl: c.sourceUrl ? String(c.sourceUrl) : null,
    lastVerified: isDate(c.lastVerified) ? c.lastVerified : null, changeNote: c.changeNote ? String(c.changeNote) : null,
    sortOrder: Number(c.sortOrder) || 0, updatedAt: String(c.updatedAt || '')
  };
}
export function cleanProposal(p) {
  if (!p || typeof p !== 'object' || typeof p.domain !== 'string' || !KINDS.includes(p.kind) || typeof p.targetId !== 'string') return null;
  if (!['pending', 'approved', 'rejected', 'superseded'].includes(p.status)) return null;
  return JSON.parse(JSON.stringify(p));   // plain data only
}
