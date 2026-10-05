// The period and total functions from index.html before the catalog (f7590df), unchanged except that
// the user's settings (S) and card list are passed in. Used only to prove the new calc.js matches.
import { CREDITS } from './legacy-credits.js';
export { CREDITS };
const CARD = { csr: { anniv: true }, gold: { anniv: false }, bilt: { anniv: true } };
const pad = n => String(n).padStart(2, '0');
const ymStr = (y, m) => `${y}-${pad(m)}`;
export function legacy(S) {
  function amtAt(c, y, m) { if (!c.amts) return c.amt; const k = ymStr(y, m); let a = c.amts[0].amt; for (const h of c.amts) { if (h.from <= k) a = h.amt; } return a; }
  function activeAt(c, y, m) { const k = ymStr(y, m); if (c.start && k < c.start) return false; if (c.end && k > c.end) return false; return true; }
  function annivMonth(c) { return (c.resetOn === 'anniv' && CARD[c.card].anniv) ? S.anniv[c.card] : null; }
  function periodKey(c, y, m) {
    if (c.freq === 'month') return ymStr(y, m);
    if (c.freq === 'half') return `${y}-H${m <= 6 ? 1 : 2}`;
    const a = annivMonth(c); if (a) { const sy = m >= a ? y : y - 1; return `CY${sy}-${pad(a)}`; }
    return String(y);
  }
  function periodEnd(c, y, m) {
    if (c.freq === 'month') return new Date(y, m, 1);
    if (c.freq === 'half') return m <= 6 ? new Date(y, 6, 1) : new Date(y + 1, 0, 1);
    const a = annivMonth(c); if (a) { const sy = m >= a ? y : y - 1; return new Date(sy + 1, a - 1, 1); }
    return new Date(y + 1, 0, 1);
  }
  const isOn = c => !S.off[c.id];
  const creditOf = id => CREDITS.find(x => x.id === id);
  const worth = (c, amt) => c?.cash ? amt * (S.biltRate ?? 0.5) : amt;
  function usedInYear(cardId, Y) { let t = 0; for (const [k, e] of Object.entries(S.log)) { if (e.card === cardId && e.ym.startsWith(Y + '-')) t += worth(creditOf(k.split('|')[0]), e.amt); } return t; }
  function usedByCredit(c, Y) { let t = 0; for (const [k, e] of Object.entries(S.log)) { if (k.split('|')[0] === c.id && e.ym.startsWith(Y + '-')) t += worth(c, e.amt); } return t; }
  function possibleByCredit(c, Y) {
    if (!isOn(c)) return 0;
    if (c.freq === 'month') { let t = 0; for (let m = 1; m <= 12; m++) if (activeAt(c, Y, m)) t += amtAt(c, Y, m); return t; }
    if (c.freq === 'half') { let t = 0; if (activeAt(c, Y, 1)) t += amtAt(c, Y, 1); if (activeAt(c, Y, 7)) t += amtAt(c, Y, 7); return t; }
    return activeAt(c, Y, 12) || activeAt(c, Y, 1) ? worth(c, amtAt(c, Y, 12)) : 0;
  }
  return { amtAt, activeAt, periodKey, periodEnd, isOn, worth, usedInYear, usedByCredit, possibleByCredit };
}
