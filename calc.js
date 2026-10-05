/* Period and amount rules for credits. Pure functions only: no DOM, no Firestore, no clock.
   index.html and the tests both import this file, and every total in the app comes from here.

   A credit (from users/{uid}/credits/{id}) has:
     freq        'month' | 'half' | 'year'
     resetOn     'calendar' | 'anniversary'
     amounts     [{amount, from:'YYYY-MM-DD'}] sorted by from
     activeFrom  'YYYY-MM-DD'          activeTo 'YYYY-MM-DD' | null (ongoing)
     valuation   'dollars' | 'biltCash'
   Dates are ISO strings, so comparing them as strings compares them as dates.

   ctx carries the user's settings: {anniv:{csr:5,…}, off:{creditId:true}, biltRate:0.5}.

   Rules
   - A period counts if it overlaps the credit's active window.
   - A period's amount is the amount in effect on the later of the period start and activeFrom,
     so a change dated mid-period takes effect from the next period.
   - Yearly credits, including anniversary ones, count once per calendar year (as before the
     catalog): "possible" for year Y uses the calendar year as the window.
   - Check-offs carry their own amt and face, so nothing here can change a past check-off. */

const pad = n => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const lastDayOf = (y, m) => iso(y, m, daysIn(y, m));
const maxDate = (a, b) => (a && a > b ? a : b);
const nextDay = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
export const dayBefore = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };

/** Anniversary month (1-12) that applies to a credit, or null when it resets on the calendar. */
export function annivMonth(c, ctx) {
  return c.resetOn === 'anniversary' ? (ctx?.anniv?.[c.card] || null) : null;
}

/** The period containing month (y, m): {key, start, end, next}. key is what check-offs are logged under. */
export function periodAt(c, y, m, ctx) {
  if (c.freq === 'month') return { key: `${y}-${pad(m)}`, start: iso(y, m, 1), end: lastDayOf(y, m), next: m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1) };
  if (c.freq === 'half') {
    const h = m <= 6 ? 1 : 2;
    return { key: `${y}-H${h}`, start: iso(y, h === 1 ? 1 : 7, 1), end: h === 1 ? iso(y, 6, 30) : iso(y, 12, 31), next: h === 1 ? iso(y, 7, 1) : iso(y + 1, 1, 1) };
  }
  const a = annivMonth(c, ctx);
  if (a) {
    const sy = m >= a ? y : y - 1;
    const next = iso(sy + 1, a, 1);
    return { key: `CY${sy}-${pad(a)}`, start: iso(sy, a, 1), end: dayBefore(next), next };
  }
  return { key: String(y), start: iso(y, 1, 1), end: iso(y, 12, 31), next: iso(y + 1, 1, 1) };
}

/** Does the period [start, end] overlap the credit's active window? */
export function overlaps(c, p) {
  return (!c.activeFrom || c.activeFrom <= p.end) && (!c.activeTo || c.activeTo >= p.start);
}

/** Amount in effect on a date (0 if none yet). */
export function amountOn(c, date) {
  let a = null;
  for (const h of c.amounts || []) if (h.from <= date) a = h.amount;
  return a ?? 0;
}

/** Amount for a period: in effect on the later of the period start and activeFrom. */
export function amountFor(c, p) {
  return amountOn(c, maxDate(c.activeFrom, p.start));
}

/** Dollar value used in totals. Bilt Cash is counted at the user's chosen rate. */
export function valueOf(c, dollars, ctx) {
  return c?.valuation === 'biltCash' ? dollars * (ctx?.biltRate ?? 0.5) : dollars;
}

export const isOn = (c, ctx) => !ctx?.off?.[c.id];

/** The periods of calendar year Y that count toward "possible", with their amounts. */
export function periodsInYear(c, Y, ctx) {
  const ps = c.freq === 'month' ? Array.from({ length: 12 }, (_, i) => periodAt(c, Y, i + 1, ctx))
    : c.freq === 'half' ? [periodAt(c, Y, 1, ctx), periodAt(c, Y, 7, ctx)]
    : [{ key: String(Y), start: iso(Y, 1, 1), end: iso(Y, 12, 31) }];   // yearly: one per calendar year
  return ps.filter(p => overlaps(c, p)).map(p => ({ ...p, amount: amountFor(c, p) }));
}

/** "Possible" for one credit in calendar year Y (0 when the credit is switched off). */
export function possibleForYear(c, Y, ctx) {
  if (!isOn(c, ctx)) return 0;
  return periodsInYear(c, Y, ctx).reduce((t, p) => t + valueOf(c, p.amount, ctx), 0);
}

/** "Possible" for a card in year Y. */
export function cardPossible(credits, cardId, Y, ctx) {
  return credits.filter(c => c.card === cardId).reduce((t, c) => t + possibleForYear(c, Y, ctx), 0);
}

/** Credits shown in the Tracker for month (y, m): switched on, and their period there overlaps the
    active window. Each row has the period, the amount for it (or the face saved with the check-off)
    and the check-off itself if there is one. */
export function trackerRows(credits, y, m, ctx, log = {}) {
  const rows = [];
  for (const c of credits) {
    if (!isOn(c, ctx)) continue;
    const p = periodAt(c, y, m, ctx);
    if (!overlaps(c, p)) continue;
    const e = log[`${c.id}|${p.key}`] || null;
    rows.push({ c, period: p, entry: e, face: e?.face ?? amountFor(c, p) });
  }
  return rows;
}

/** Used and total for a Tracker section, valued (Bilt Cash at the user's rate). */
export function sectionTotals(rows, ctx) {
  let used = 0, total = 0;
  for (const r of rows) {
    total += valueOf(r.c, r.face, ctx);
    if (r.entry) used += valueOf(r.c, Math.min(r.entry.amt, r.face), ctx);
  }
  return { used, total };
}

/** Totals of what was actually used in calendar year Y, from the check-off log.
    A check-off counts in the year and month it was logged under (its ym), as before the catalog. */
export function usedInYear(log, Y, creditById, ctx) {
  const byCard = {}, byCredit = {}, byMonth = Array.from({ length: 12 }, () => ({}));
  for (const [k, e] of Object.entries(log || {})) {
    if (!e?.ym?.startsWith(Y + '-')) continue;
    const id = k.split('|')[0], v = valueOf(creditById(id), e.amt, ctx);
    byCard[e.card] = (byCard[e.card] || 0) + v;
    byCredit[id] = (byCredit[id] || 0) + v;
    const mo = byMonth[Number(e.ym.slice(5)) - 1];
    mo[e.card] = (mo[e.card] || 0) + v;
  }
  return { byCard, byCredit, byMonth };
}

/** Credits for the calendar reminders: monthly and six-month credits that are on and whose current
    period overlaps the active window, with this period's amount. date is 'YYYY-MM-DD'. */
export function calendarCredits(credits, date, ctx) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const pick = freq => trackerRows(credits.filter(c => c.freq === freq), y, m, ctx).map(r => ({ c: r.c, amount: amountFor(r.c, r.period) }));
  return { month: pick('month'), half: pick('half') };
}

/* ---------- staleness ---------- */
export const STALE_DAYS = 90;
/** The later of lastVerified and the newest check run in which this credit matched the issuer page. */
export function verifiedDate(c, runs = []) {
  let d = c.lastVerified || null;
  for (const r of runs) {
    const when = (r.finishedAt || r.startedAt || '').slice(0, 10);
    if (!when) continue;
    const matched = Object.values(r.cards || {}).some(cr => (cr?.matched || []).includes(c.id));
    if (matched && (!d || when > d)) d = when;
  }
  return d;
}
/** Stale when there's no verified date, or it's more than 90 days before today ('YYYY-MM-DD'). */
export function isStale(c, runs, today) {
  const d = verifiedDate(c, runs);
  if (!d) return true;
  const age = (Date.parse(today + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000;
  return age > STALE_DAYS;
}

export { nextDay };
