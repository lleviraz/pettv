import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { setLogLevel } from 'firebase/app';

// Denied writes are the point of most tests; their SDK warnings would bury real failures
setLogLevel('error');

const ADMIN = 'admin-uid';
const HOME = 'home-uid';
const FAMILY = 'family-uid';
const STRANGER = 'stranger-uid';
const GUEST = 'guest-uid';
const BLOCKED = 'blocked-uid';

const HOUR = 3600000;
const SERVER_TS = { '.sv': 'timestamp' };
const emailOf = (uid) => `${uid}@example.com`;

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-pettv',
    database: { rules: readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8') },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  const now = Date.now();
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref().set({
      admin: { uid: ADMIN },
      home: { uid: HOME },
      whitelist: { [ADMIN]: true, [FAMILY]: true, [BLOCKED]: true },
      blocked: { [BLOCKED]: { name: 'Blocked', ts: now } },
      heartbeat: { ts: now, uid: HOME },
      tickets: {
        GUESTCODE: { uid: GUEST, expires: now + 10 * 60000, accessMs: HOUR },
        OLDCODE01: { uid: GUEST, expires: now - 1000, accessMs: HOUR },
        BLOCKCODE: { uid: BLOCKED, expires: now + 10 * 60000, accessMs: HOUR },
      },
    });
  });
});

function as(uid) {
  return env.authenticatedContext(uid, { email: emailOf(uid), email_verified: true }).database();
}

function anon() {
  return env.unauthenticatedContext().database();
}

function attempt(db, uid, code, overrides = {}) {
  return db.ref(`attempts/${uid}`).set({ count: 1, lastCode: code, email: emailOf(uid), ts: SERVER_TS, ...overrides });
}

// Mirrors the clients: record the guess as a counted attempt, then redeem in one atomic update
async function redeem(db, uid, code, grantOverrides = {}, keepTicket = false) {
  const prev = (await db.ref(`attempts/${uid}`).get()).val();
  await attempt(db, uid, code, { count: (prev?.count ?? 0) + 1 });
  const updates = {
    [`attempts/${uid}`]: null,
    [`grants/${uid}`]: {
      code,
      redeemedAt: SERVER_TS,
      accessMs: HOUR,
      name: 'Guest',
      email: emailOf(uid),
      ...grantOverrides,
    },
  };
  if (!keepTicket) updates[`tickets/${code}`] = null;
  return db.ref().update(updates);
}

function request(db, uid, overrides = {}) {
  return db.ref(`requests/${uid}`).set({
    name: 'Someone',
    email: emailOf(uid),
    type: 'viewer',
    ts: SERVER_TS,
    ...overrides,
  });
}

describe('signed-out visitors', () => {
  test('cannot read anything', async () => {
    for (const path of ['/', 'heartbeat', 'sessions', 'whitelist', 'grants', 'requests', 'log', 'tickets/GUESTCODE']) {
      await assertFails(anon().ref(path).get());
    }
  });

  test('cannot write a session or a request', async () => {
    await assertFails(anon().ref('sessions/x').set({ request: 'r' }));
    await assertFails(anon().ref('requests/x').set({ name: 'x' }));
  });
});

describe('signed-in stranger (no access)', () => {
  test('cannot see the stream signal or join', async () => {
    await assertFails(as(STRANGER).ref('heartbeat').get());
    await assertFails(as(STRANGER).ref(`sessions/${STRANGER}`).set({ request: 'r', name: 'S', email: emailOf(STRANGER) }));
  });

  test('cannot list private collections', async () => {
    for (const path of ['whitelist', 'tickets', 'grants', 'requests', 'log', 'sessions', 'blocked', 'home', 'admin']) {
      await assertFails(as(STRANGER).ref(path).get());
    }
  });

  test('can read only its own whitelist entry, and a ticket only after recording the guess', async () => {
    await assertSucceeds(as(STRANGER).ref(`whitelist/${STRANGER}`).get());
    await assertFails(as(STRANGER).ref(`whitelist/${FAMILY}`).get());
    await assertFails(as(STRANGER).ref('tickets/GUESTCODE').get());
    await assertSucceeds(attempt(as(STRANGER), STRANGER, 'GUESTCODE'));
    await assertSucceeds(as(STRANGER).ref('tickets/GUESTCODE').get());
    await assertFails(as(STRANGER).ref('tickets/OLDCODE01').get());
  });

  test('cannot grant itself access or change admin data', async () => {
    await assertFails(as(STRANGER).ref(`whitelist/${STRANGER}`).set(true));
    await assertFails(as(STRANGER).ref('home').set({ uid: STRANGER }));
    await assertFails(as(STRANGER).ref('admin').set({ uid: STRANGER }));
    await assertFails(as(STRANGER).ref(`blocked/${FAMILY}`).set({ name: 'x', ts: SERVER_TS }));
    await assertFails(as(STRANGER).ref('tickets/MYCODE01').set({ uid: STRANGER, expires: Date.now() + 60000, accessMs: HOUR }));
    await assertFails(as(STRANGER).ref(`grants/${STRANGER}`).set({ code: 'X', redeemedAt: SERVER_TS, accessMs: HOUR, name: 'S', email: emailOf(STRANGER) }));
  });

  test('cannot write the heartbeat or delete sessions', async () => {
    await assertFails(as(STRANGER).ref('heartbeat').set({ ts: 1, uid: STRANGER }));
    await assertFails(as(STRANGER).ref('sessions').remove());
  });
});

describe('whitelisted family member', () => {
  test('can see the stream signal and join with its own session', async () => {
    await assertSucceeds(as(FAMILY).ref('heartbeat').get());
    await assertSucceeds(as(FAMILY).ref(`sessions/${FAMILY}`).set({ request: 'r', name: 'F', email: emailOf(FAMILY) }));
    await assertSucceeds(as(FAMILY).ref(`sessions/${FAMILY}/offer`).get());
  });

  test('can label its session with a device name of sane length', async () => {
    const base = { request: 'r', name: 'F', email: emailOf(FAMILY) };
    await assertSucceeds(as(FAMILY).ref(`sessions/${FAMILY}`).set({ ...base, device: 'iPhone Safari' }));
    await assertFails(as(FAMILY).ref(`sessions/${FAMILY}`).set({ ...base, device: 'x'.repeat(80) }));
    await assertFails(as(FAMILY).ref(`sessions/${FAMILY}`).set({ ...base, device: 42 }));
  });

  test('cannot fake its email, touch other sessions, or read all sessions', async () => {
    await assertFails(as(FAMILY).ref(`sessions/${FAMILY}`).set({ request: 'r', name: 'F', email: 'boss@example.com' }));
    await assertFails(as(FAMILY).ref(`sessions/${GUEST}`).set({ request: 'r' }));
    await assertFails(as(FAMILY).ref('sessions').get());
    await assertFails(as(FAMILY).ref('sessions').remove());
  });

  test('cannot read the log or the admin lists', async () => {
    await assertFails(as(FAMILY).ref('log').get());
    await assertFails(as(FAMILY).ref('requests').get());
    await assertFails(as(FAMILY).ref('grants').get());
  });
});

describe('blocked user', () => {
  test('is denied even though it is whitelisted', async () => {
    await assertFails(as(BLOCKED).ref('heartbeat').get());
    await assertFails(as(BLOCKED).ref(`sessions/${BLOCKED}`).set({ request: 'r', name: 'B', email: emailOf(BLOCKED) }));
  });

  test('cannot request access or redeem a code issued to it', async () => {
    await assertFails(request(as(BLOCKED), BLOCKED));
    await assertFails(redeem(as(BLOCKED), BLOCKED, 'BLOCKCODE'));
  });
});

describe('home phone', () => {
  test('can publish presence and manage all sessions', async () => {
    await assertSucceeds(as(HOME).ref('heartbeat').set({ ts: SERVER_TS, uid: HOME }));
    await assertSucceeds(as(HOME).ref('sessions').get());
    await assertSucceeds(as(HOME).ref(`sessions/${FAMILY}/offer`).set('sdp'));
    await assertSucceeds(as(HOME).ref('grants').get());
    await assertSucceeds(as(HOME).ref('blocked').get());
  });

  test('a non-home account cannot publish presence', async () => {
    await assertFails(as(FAMILY).ref('heartbeat').set({ ts: SERVER_TS, uid: FAMILY }));
    await assertFails(as(ADMIN).ref('heartbeat').set({ ts: SERVER_TS, uid: ADMIN }));
  });
});

describe('one-time codes', () => {
  test('the intended account redeems once and gains access', async () => {
    await assertFails(as(GUEST).ref('heartbeat').get());
    await assertSucceeds(redeem(as(GUEST), GUEST, 'GUESTCODE'));
    await assertSucceeds(as(GUEST).ref('heartbeat').get());
    await assertSucceeds(as(GUEST).ref(`sessions/${GUEST}`).set({ request: 'r', name: 'G', email: emailOf(GUEST) }));
  });

  test('a code cannot be reused', async () => {
    await assertSucceeds(redeem(as(GUEST), GUEST, 'GUESTCODE'));
    await assertFails(redeem(as(GUEST), GUEST, 'GUESTCODE'));
  });

  test('another account cannot use a code issued to someone else', async () => {
    await assertFails(redeem(as(STRANGER), STRANGER, 'GUESTCODE'));
  });

  test('an expired code is refused', async () => {
    await assertFails(redeem(as(GUEST), GUEST, 'OLDCODE01'));
  });

  test('redeeming without consuming the ticket is refused', async () => {
    await assertFails(redeem(as(GUEST), GUEST, 'GUESTCODE', {}, true));
  });

  test('the grant cannot be padded or faked', async () => {
    await assertFails(redeem(as(GUEST), GUEST, 'GUESTCODE', { accessMs: 30 * 24 * HOUR }));
    await assertFails(redeem(as(GUEST), GUEST, 'GUESTCODE', { redeemedAt: Date.now() + 365 * 24 * HOUR }));
    await assertFails(redeem(as(GUEST), GUEST, 'GUESTCODE', { email: 'boss@example.com' }));
  });

  test('a stranger cannot delete a ticket it did not redeem', async () => {
    await assertFails(as(STRANGER).ref('tickets/GUESTCODE').remove());
  });

  test('an expired grant gives no access', async () => {
    await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`grants/${GUEST}`).set({
      code: 'X', redeemedAt: Date.now() - 2 * HOUR, accessMs: HOUR, name: 'G', email: emailOf(GUEST),
    }));
    await assertFails(as(GUEST).ref('heartbeat').get());
  });

  test('only the admin can create or cancel tickets and revoke grants', async () => {
    const ticket = { uid: GUEST, expires: Date.now() + 60000, accessMs: HOUR };
    await assertFails(as(FAMILY).ref('tickets/NEWCODE1').set(ticket));
    await assertSucceeds(as(ADMIN).ref('tickets/NEWCODE1').set(ticket));
    await assertSucceeds(as(ADMIN).ref('tickets/NEWCODE1').remove());
    await assertFails(as(ADMIN).ref('tickets/BADCODE1').set({ expires: Date.now() + 60000, accessMs: HOUR }));
    await assertSucceeds(redeem(as(GUEST), GUEST, 'GUESTCODE'));
    await assertSucceeds(as(ADMIN).ref(`grants/${GUEST}`).remove());
    await assertFails(as(GUEST).ref('heartbeat').get());
  });
});

describe('access requests', () => {
  test('a signed-in user can request once with its verified email', async () => {
    await assertSucceeds(request(as(STRANGER), STRANGER));
    await assertSucceeds(as(STRANGER).ref(`requests/${STRANGER}`).get());
  });

  test('a second request is refused while one is pending, but it can be withdrawn', async () => {
    await assertSucceeds(request(as(STRANGER), STRANGER));
    await assertFails(request(as(STRANGER), STRANGER, { type: 'home' }));
    await assertSucceeds(as(STRANGER).ref(`requests/${STRANGER}`).remove());
    await assertSucceeds(request(as(STRANGER), STRANGER, { type: 'home' }));
  });

  test('fake email, client timestamp, bad type, or someone else\'s slot are refused', async () => {
    await assertFails(request(as(STRANGER), STRANGER, { email: 'mom@example.com' }));
    await assertFails(request(as(STRANGER), STRANGER, { ts: Date.now() }));
    await assertFails(request(as(STRANGER), STRANGER, { type: 'admin' }));
    await assertFails(request(as(STRANGER), GUEST));
  });

  test('an unverified email cannot request', async () => {
    const db = env.authenticatedContext(STRANGER, { email: emailOf(STRANGER), email_verified: false }).database();
    await assertFails(request(db, STRANGER));
  });

  test('only the admin can list and dismiss requests', async () => {
    await assertSucceeds(request(as(STRANGER), STRANGER));
    await assertFails(as(FAMILY).ref('requests').get());
    await assertSucceeds(as(ADMIN).ref('requests').get());
    await assertSucceeds(as(ADMIN).ref(`requests/${STRANGER}`).remove());
  });
});

describe('activity log', () => {
  const entry = (uid, extra = {}) => ({ uid, event: 'test', ts: SERVER_TS, ...extra });

  test('anyone signed in can append its own entry with server time', async () => {
    await assertSucceeds(as(STRANGER).ref('log').push(entry(STRANGER, { email: emailOf(STRANGER), detail: 'x' })));
  });

  test('entries cannot be spoofed, backdated, padded, or changed', async () => {
    await assertFails(as(STRANGER).ref('log').push(entry(FAMILY)));
    await assertFails(as(STRANGER).ref('log').push(entry(STRANGER, { ts: Date.now() - HOUR })));
    await assertFails(as(STRANGER).ref('log').push(entry(STRANGER, { extra: 'field' })));
    const ref = as(STRANGER).ref('log/fixed-id');
    await assertSucceeds(ref.set(entry(STRANGER)));
    await assertFails(ref.set(entry(STRANGER, { event: 'changed' })));
    await assertFails(ref.remove());
  });

  test('only the admin can read the log', async () => {
    await assertFails(as(FAMILY).ref('log').get());
    await assertFails(as(HOME).ref('log').get());
    await assertSucceeds(as(ADMIN).ref('log').get());
  });
});

describe('admin', () => {
  test('can reassign the home phone, block, and see sessions', async () => {
    await assertSucceeds(as(ADMIN).ref('home').set({ uid: FAMILY }));
    await assertSucceeds(as(ADMIN).ref(`blocked/${STRANGER}`).set({ name: 'S', email: emailOf(STRANGER), ts: SERVER_TS }));
    await assertSucceeds(as(ADMIN).ref('sessions').get());
  });

  test('cannot edit the whitelist from the app (console only)', async () => {
    await assertFails(as(ADMIN).ref(`whitelist/${STRANGER}`).set(true));
  });
});

describe('code guessing limit', () => {
  const lockedAt = (uid, count, code = 'WRONG001') => env.withSecurityRulesDisabled((ctx) =>
    ctx.database().ref(`attempts/${uid}`).set({ count, lastCode: code, email: emailOf(uid), ts: Date.now() }));

  test('redeeming without a recorded guess for that exact code is refused', async () => {
    const direct = () => as(GUEST).ref().update({
      [`grants/${GUEST}`]: { code: 'GUESTCODE', redeemedAt: SERVER_TS, accessMs: HOUR, name: 'G', email: emailOf(GUEST) },
      'tickets/GUESTCODE': null,
    });
    await assertFails(direct());
    await assertSucceeds(attempt(as(GUEST), GUEST, 'WRONG001'));
    await assertFails(direct());
  });

  test('each guess must count up by exactly one', async () => {
    await assertFails(attempt(as(GUEST), GUEST, 'AAAAAAAA', { count: 2 }));
    await assertFails(attempt(as(GUEST), GUEST, 'AAAAAAAA', { count: 0 }));
    await assertSucceeds(attempt(as(GUEST), GUEST, 'AAAAAAAA', { count: 1 }));
    await assertFails(attempt(as(GUEST), GUEST, 'BBBBBBBB', { count: 1 }));
    await assertFails(attempt(as(GUEST), GUEST, 'BBBBBBBB', { count: 3 }));
    await assertSucceeds(attempt(as(GUEST), GUEST, 'BBBBBBBB', { count: 2 }));
  });

  test('the fifth guess is the last; after that even the right code is refused', async () => {
    await lockedAt(GUEST, 4);
    await assertSucceeds(attempt(as(GUEST), GUEST, 'WRONG002', { count: 5 }));
    await assertFails(attempt(as(GUEST), GUEST, 'GUESTCODE', { count: 6 }));
    await assertFails(as(GUEST).ref('tickets/GUESTCODE').get());
    await assertFails(redeem(as(GUEST), GUEST, 'GUESTCODE'));
  });

  test('the right code on the fifth try still works', async () => {
    await lockedAt(GUEST, 4);
    await assertSucceeds(redeem(as(GUEST), GUEST, 'GUESTCODE'));
    await env.withSecurityRulesDisabled(async (ctx) => {
      if ((await ctx.database().ref(`attempts/${GUEST}`).get()).exists()) throw new Error('attempts should be cleared after a successful redemption');
    });
  });

  test('the counter cannot be cleared or faked by its owner', async () => {
    await lockedAt(GUEST, 5);
    await assertFails(as(GUEST).ref(`attempts/${GUEST}`).remove());
    await assertFails(attempt(as(GUEST), GUEST, 'AAAAAAAA', { count: 1 }));
    await env.clearDatabase();
    await assertFails(attempt(as(STRANGER), STRANGER, 'AAAAAAAA', { email: 'boss@example.com' }));
    await assertFails(attempt(as(STRANGER), STRANGER, 'AAAAAAAA', { ts: Date.now() }));
    await assertFails(attempt(as(STRANGER), STRANGER, 'AAAAAAAA', { extra: 1 }));
    await assertFails(attempt(as(STRANGER), STRANGER, ''));
  });

  test('nobody else can read or write someone\'s counter', async () => {
    await lockedAt(GUEST, 2);
    await assertFails(as(STRANGER).ref(`attempts/${GUEST}`).get());
    await assertFails(attempt(as(STRANGER), GUEST, 'AAAAAAAA', { count: 3 }));
    await assertFails(as(STRANGER).ref(`attempts/${GUEST}`).remove());
    await assertFails(as(GUEST).ref('attempts').get());
    await assertSucceeds(as(GUEST).ref(`attempts/${GUEST}`).get());
  });

  test('a blocked user cannot record guesses', async () => {
    await assertFails(attempt(as(BLOCKED), BLOCKED, 'BLOCKCODE'));
  });

  test('the admin sees all counters and can unlock someone', async () => {
    await lockedAt(GUEST, 5);
    await assertSucceeds(as(ADMIN).ref('attempts').get());
    await assertSucceeds(as(ADMIN).ref(`attempts/${GUEST}`).remove());
    await assertSucceeds(redeem(as(GUEST), GUEST, 'GUESTCODE'));
  });
});

describe('home phone debug log', () => {
  const upload = (db, overrides = {}) => db.ref('debug/home').set({ ts: SERVER_TS, device: 'SM-A715F', lines: ['line one', 'line two'], ...overrides });

  test('only the home phone can upload it and only the admin can read it', async () => {
    await assertSucceeds(upload(as(HOME)));
    await assertSucceeds(as(ADMIN).ref('debug/home').get());
    await assertFails(as(HOME).ref('debug/home').get());
    await assertFails(as(FAMILY).ref('debug').get());
    await assertFails(upload(as(FAMILY)));
    await assertFails(upload(as(ADMIN)));
    await assertFails(upload(anon()));
  });

  test('size and shape are bounded', async () => {
    await assertFails(upload(as(HOME), { lines: ['x'.repeat(301)] }));
    await assertFails(upload(as(HOME), { lines: { 1000: 'too many' } }));
    await assertFails(upload(as(HOME), { lines: { name: 'not an index' } }));
    await assertFails(upload(as(HOME), { ts: Date.now() }));
    await assertFails(upload(as(HOME), { extra: 'field' }));
    await assertFails(upload(as(HOME), { device: 'x'.repeat(80) }));
  });
});
