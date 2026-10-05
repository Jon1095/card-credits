/* Migration against a copy of a real backup. Point BACKUP_FILE at an exported backup (never commit it):
     BACKUP_FILE=/path/to/backup.json npm run test:emulator
   Without BACKUP_FILE the tests that need it are skipped. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collection, getDocs, getDoc, doc, setDoc, updateDoc, deleteField } from 'firebase/firestore';
import { testEnv, device, fsApi, OWNER, STRANGER } from './helpers.js';
import { migrateToCatalog, SEED_CREDITS } from '../../catalog.js';
import { usedInYear, cardPossible } from '../../calc.js';
import { legacy, CREDITS as LEGACY } from '../fixtures/legacy-calc.js';

const FILE = process.env.BACKUP_FILE;
const backup = FILE ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
const skip = !backup && 'set BACKUP_FILE to a backup to run this';
const NOW = new Date('2026-10-05T12:00:00Z');
let env;
before(async () => { env = await testEnv(); });
after(async () => { await env?.cleanup(); });

async function reset() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(ctx => ctx.firestore().doc(`users/${OWNER}`).set(backup.data));
}
const snapshots = async db => (await getDocs(collection(db, 'users', OWNER, 'snapshots'))).docs.filter(d => d.id.startsWith('pre-catalog-'));
const credits = async db => Object.fromEntries((await getDocs(collection(db, 'users', OWNER, 'credits'))).docs.map(d => [d.id, d.data()]));

test('migrates the backup: snapshot first, seeds 17 credits, only adds schemaVersion', { skip }, async () => {
  await reset();
  const dev = device(OWNER);
  const r = await migrateToCatalog(fsApi, dev.db, OWNER, NOW);
  assert.equal(r.migrated, true);
  assert.equal(r.created.length, 17);
  const user = (await getDoc(doc(dev.db, 'users', OWNER))).data();
  assert.equal(user.schemaVersion, 2);
  const { schemaVersion, ...rest } = user;
  assert.deepEqual(rest, backup.data, 'log, off, anniv, fees, rent and biltRate untouched');
  const snaps = await snapshots(dev.db);
  assert.equal(snaps.length, 1);
  const { takenAt, ...copy } = snaps[0].data();
  assert.deepEqual(copy, backup.data, 'pre-catalog snapshot is a full copy of the user document');
  const cat = await credits(dev.db);
  assert.deepEqual(Object.keys(cat).sort(), SEED_CREDITS.map(c => c.id).sort());
  for (const s of SEED_CREDITS) { const { id, ...want } = s; const { updatedAt, ...got } = cat[id]; assert.deepEqual(got, want, id); }
  await dev.close();
});

test('running it again changes nothing', { skip }, async () => {
  const dev = device(OWNER);
  const before = await credits(dev.db);
  const r = await migrateToCatalog(fsApi, dev.db, OWNER, new Date('2026-10-06T12:00:00Z'));
  assert.equal(r.migrated, false);
  assert.equal((await snapshots(dev.db)).length, 1, 'no second snapshot');
  assert.deepEqual(await credits(dev.db), before);
  await dev.close();
});

test('two devices at once: one migration, one snapshot, 17 credits', { skip }, async () => {
  await reset();
  const a = device(OWNER), b = device(OWNER);
  const rs = await Promise.all([migrateToCatalog(fsApi, a.db, OWNER, NOW), migrateToCatalog(fsApi, b.db, OWNER, new Date(NOW.getTime() + 1000))]);
  assert.equal(rs.filter(r => r.migrated).length, 1, JSON.stringify(rs));
  assert.equal((await snapshots(a.db)).length, 1);
  assert.equal(Object.keys(await credits(a.db)).length, 17);
  await a.close(); await b.close();
});

test('if an older cached app drops schemaVersion, re-running never overwrites my catalog edits', { skip }, async () => {
  const dev = device(OWNER);
  const edited = [{ amount: 7, from: '2000-01-01' }, { amount: 8, from: '2027-01-01' }];
  await updateDoc(doc(dev.db, 'users', OWNER, 'credits', 'gold-dunkin'), { amounts: edited });
  await setDoc(doc(dev.db, 'users', OWNER), backup.data);   // what the old app's "Replace everything" import writes
  const r = await migrateToCatalog(fsApi, dev.db, OWNER, new Date('2026-10-07T12:00:00Z'));
  assert.equal(r.migrated, true);
  assert.deepEqual(r.created, []);
  assert.deepEqual((await getDoc(doc(dev.db, 'users', OWNER, 'credits', 'gold-dunkin'))).data().amounts, edited);
  assert.equal((await getDoc(doc(dev.db, 'users', OWNER))).data().schemaVersion, 2);
  await dev.close();
});

test('another signed-in user can’t run the migration on my data', { skip }, async () => {
  await reset();
  const dev = device(STRANGER);
  await assert.rejects(migrateToCatalog(fsApi, dev.db, OWNER, NOW), /permission/i);
  await dev.close();
});

test('totals from the migrated catalog match the old app on this backup (2025–2027)', { skip }, async () => {
  await reset();
  const dev = device(OWNER);
  await migrateToCatalog(fsApi, dev.db, OWNER, NOW);
  const cat = await credits(dev.db), list = Object.entries(cat).map(([id, c]) => ({ id, ...c }));
  const S = backup.data, ctx = { anniv: S.anniv, off: S.off, biltRate: S.biltRate }, old = legacy(S);
  for (const Y of [2025, 2026, 2027]) {
    const used = usedInYear(S.log, Y, id => ({ id, ...cat[id] }), ctx);
    for (const card of ['csr', 'gold', 'bilt']) {
      assert.equal(used.byCard[card] || 0, old.usedInYear(card, Y), `used ${card} ${Y}`);
      assert.equal(cardPossible(list, card, Y, ctx), LEGACY.filter(c => c.card === card).reduce((t, c) => t + old.possibleByCredit(c, Y), 0), `possible ${card} ${Y}`);
    }
  }
  await dev.close();
});
