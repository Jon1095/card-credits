// Shared setup for tests that run against the Firestore emulator (npm run test:emulator).
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { initializeApp, deleteApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, doc, runTransaction } from 'firebase/firestore';

export const PROJECT = 'demo-card-credits';
export const OWNER = 'owner-uid', BOT = 'bot-uid', STRANGER = 'someone-else';
const HOST = '127.0.0.1', PORT = 8080;

/** firestore.rules with the placeholders filled in; bot: true turns on the BOT START..END block. */
export function rules({ bot = false, owner = OWNER } = {}) {
  let r = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8').replaceAll('YOUR_USER_ID', owner).replaceAll('BOT_UID', BOT);
  if (bot) {
    const lines = r.split('\n'); let on = false;
    r = lines.map(l => {
      if (l.includes('---- BOT START ----')) { on = true; return l; }
      if (l.includes('---- BOT END ----')) { on = false; return l; }
      return on ? l.replace(/^(\s*)\/\/ (?!\/\/)/, '$1') : l;
    }).join('\n');
  }
  return r;
}

export const testEnv = (opts) => initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: rules(opts), host: HOST, port: PORT } });

/** A modular-SDK Firestore signed in as uid, like one device running the app. */
let n = 0;
export function device(uid) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, `device-${uid}-${n++}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, HOST, PORT, { mockUserToken: { sub: uid, user_id: uid } });
  return { db, close: () => deleteApp(app) };
}
export const fsApi = { doc, runTransaction };
