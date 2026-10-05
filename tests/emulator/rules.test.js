import { test, after } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { testEnv, OWNER, BOT, STRANGER } from './helpers.js';

const validProposal = () => ({
  domain: 'credits', targetId: 'gold-dunkin', kind: 'amount_change', current: { amounts: [{ amount: 7, from: '2000-01-01' }] },
  proposed: { amount: 8 }, effectiveFrom: '2027-01-01', source: { url: 'https://www.americanexpress.com/', checkedAt: '2026-11-01', excerpt: 'Up to $8 a month' },
  note: 'Dunkin’ credit raised', createdBy: 'bot', runId: 'run-2026-11', status: 'pending', createdAt: '2026-11-01T09:00:00Z'
});
const validRun = () => ({ startedAt: '2026-11-01T09:00:00Z', finishedAt: '2026-11-01T09:04:00Z',
  cards: { csr: { status: 'checked', pages: ['https://example.com'], matched: ['csr-travel'] }, gold: { status: 'couldnt_check', reason: 'page didn’t load' } } });

async function seed(env) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.doc(`users/${OWNER}`).set({ rent: 1811, log: { 'gold-uber|2026-10': { amt: 10, face: 10, card: 'gold', ym: '2026-10' } } });
    await db.doc(`users/${OWNER}/credits/gold-dunkin`).set({ card: 'gold', name: 'Dunkin’ credit' });
    await db.doc(`users/${OWNER}/proposals/p1`).set({ ...validProposal(), createdBy: 'manual' });
    await db.doc(`users/${OWNER}/snapshots/2026-10`).set({ rent: 1811 });
    await db.doc(`users/${OWNER}/checkRuns/r1`).set(validRun());
  });
}

test('rules as published (bot block off)', async (t) => {
  const env = await testEnv({ bot: false });
  after(() => env.cleanup());
  await env.clearFirestore(); await seed(env);
  const owner = env.authenticatedContext(OWNER).firestore();
  const stranger = env.authenticatedContext(STRANGER).firestore();
  const anon = env.unauthenticatedContext().firestore();
  const bot = env.authenticatedContext(BOT).firestore();

  await t.test('my account can read and write everything under my user', async () => {
    for (const p of [`users/${OWNER}`, `users/${OWNER}/credits/gold-dunkin`, `users/${OWNER}/proposals/p1`, `users/${OWNER}/snapshots/2026-10`, `users/${OWNER}/checkRuns/r1`])
      await assertSucceeds(owner.doc(p).get());
    await assertSucceeds(owner.doc(`users/${OWNER}`).update({ rent: 1900 }));
    await assertSucceeds(owner.doc(`users/${OWNER}/credits/new-one`).set({ card: 'gold' }));
    await assertSucceeds(owner.doc(`users/${OWNER}/proposals/p2`).set({ status: 'pending' }));
    await assertSucceeds(owner.doc(`users/${OWNER}/proposals/p2`).update({ status: 'approved' }));
    await assertSucceeds(owner.collection(`users/${OWNER}/credits`).get());
  });
  await t.test('another signed-in user is denied everything', async () => {
    for (const p of [`users/${OWNER}`, `users/${OWNER}/credits/gold-dunkin`, `users/${OWNER}/proposals/p1`, `users/${OWNER}/snapshots/2026-10`, `users/${OWNER}/checkRuns/r1`]) {
      await assertFails(stranger.doc(p).get());
      await assertFails(stranger.doc(p).set({ x: 1 }));
    }
    await assertFails(stranger.doc(`users/${STRANGER}`).set({ x: 1 }), 'not even their own user document');
    await assertFails(anon.doc(`users/${OWNER}`).get());
  });
  await t.test('the checker account has no access while its block is off', async () => {
    await assertFails(bot.doc(`users/${OWNER}/credits/gold-dunkin`).get());
    await assertFails(bot.doc(`users/${OWNER}/proposals/p9`).set(validProposal()));
    await assertFails(bot.doc(`users/${OWNER}/checkRuns/r9`).set(validRun()));
  });
});

test('rules with the bot block turned on', async (t) => {
  const env = await testEnv({ bot: true });
  after(() => env.cleanup());
  await env.clearFirestore(); await seed(env);
  const bot = env.authenticatedContext(BOT).firestore();
  const owner = env.authenticatedContext(OWNER).firestore();

  await t.test('can read the credit catalog, and only that', async () => {
    await assertSucceeds(bot.doc(`users/${OWNER}/credits/gold-dunkin`).get());
    await assertSucceeds(bot.collection(`users/${OWNER}/credits`).get());
    await assertFails(bot.doc(`users/${OWNER}`).get(), 'check-offs and settings');
    await assertFails(bot.doc(`users/${OWNER}/proposals/p1`).get());
    await assertFails(bot.collection(`users/${OWNER}/proposals`).get());
    await assertFails(bot.doc(`users/${OWNER}/snapshots/2026-10`).get());
    await assertFails(bot.doc(`users/${OWNER}/checkRuns/r1`).get());
    await assertFails(bot.doc(`users/${BOT}/credits/x`).get(), 'nobody else’s data either');
  });
  await t.test('can create a valid pending bot proposal, never update or delete', async () => {
    await assertSucceeds(bot.doc(`users/${OWNER}/proposals/bot-1`).set(validProposal()));
    await assertFails(bot.doc(`users/${OWNER}/proposals/bot-1`).update({ note: 'changed' }));
    await assertFails(bot.doc(`users/${OWNER}/proposals/bot-1`).delete());
    await assertFails(bot.doc(`users/${OWNER}/proposals/p1`).set(validProposal()), 'can’t overwrite an existing proposal');
  });
  await t.test('proposals with the wrong shape or size are refused', async () => {
    const bad = {
      'createdBy manual': { createdBy: 'manual' }, 'status approved': { status: 'approved' }, 'domain rewards': { domain: 'rewards' },
      'unknown kind': { kind: 'delete_everything' }, 'extra field': { sneaky: true }, 'missing source': { source: null },
      'note too long': { note: 'x'.repeat(1001) }, 'excerpt too long': { source: { url: 'https://x', excerpt: 'x'.repeat(2001) } },
      'bad date': { effectiveFrom: 'next month' }, 'bad target id': { targetId: 'Gold Dunkin!' }, 'pre-approved': { applied: { amount: 8 } },
      'proposed with unknown field': { proposed: { amount: 8, log: {} } }, 'negative amount': { proposed: { amount: -5 } }
    };
    let i = 0;
    for (const [name, patch] of Object.entries(bad)) await assertFails(bot.doc(`users/${OWNER}/proposals/bad-${i++}`).set({ ...validProposal(), ...patch }), name);
    await assertFails(bot.doc(`users/${OWNER}/proposals/has%20space`).set(validProposal()));
  });
  await t.test('can create check runs, never update them; can’t write credits or settings', async () => {
    await assertSucceeds(bot.doc(`users/${OWNER}/checkRuns/run-1`).set(validRun()));
    await assertFails(bot.doc(`users/${OWNER}/checkRuns/run-1`).update({ finishedAt: 'x' }));
    await assertFails(bot.doc(`users/${OWNER}/checkRuns/run-2`).set({ ...validRun(), cards: { gold: { status: 'no_changes' } } }), 'unknown status');
    await assertFails(bot.doc(`users/${OWNER}/credits/gold-dunkin`).update({ name: 'x' }));
    await assertFails(bot.doc(`users/${OWNER}/credits/new`).set({ card: 'gold' }));
    await assertFails(bot.doc(`users/${OWNER}`).update({ rent: 1 }));
  });
  await t.test('my account still has full access with the bot block on', async () => {
    await assertSucceeds(owner.doc(`users/${OWNER}`).get());
    await assertSucceeds(owner.doc(`users/${OWNER}/proposals/bot-1`).update({ status: 'approved' }));
  });
});
