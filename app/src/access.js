import { ref, get, update, push, serverTimestamp } from 'firebase/database';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { auth, db } from './config';

// No 0/O, 1/I/L so codes survive being read aloud or retyped
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TICKET_REDEEM_WINDOW_MS = 10 * 60 * 1000;

export function generateTicketCode() {
  let out = '';
  while (out.length < 8) {
    for (const b of Crypto.getRandomBytes(16)) {
      // Reject bytes past the largest multiple of the alphabet size to avoid modulo bias
      if (b < 248 && out.length < 8) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

export function normalizeCode(input) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function formatDuration(ms) {
  const hours = Math.round(ms / 3600000);
  return hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
}

function logEntry(event, extra = {}) {
  const user = auth.currentUser;
  return { uid: user.uid, email: user.email ?? 'unknown', event, ts: serverTimestamp(), ...extra };
}

export function logEvent(event, extra) {
  return push(ref(db, '/log'), logEntry(event, extra)).catch(() => {});
}

export async function hasViewerAccess(uid) {
  const [wl, grant] = await Promise.all([
    get(ref(db, `/whitelist/${uid}`)).catch(() => null),
    get(ref(db, `/grants/${uid}`)).catch(() => null),
  ]);
  if (wl?.val()) return true;
  const g = grant?.val();
  return !!g && g.redeemedAt + g.accessMs > Date.now();
}

// Grant write and ticket delete must be one atomic update: the rules only allow
// the grant if the ticket disappears in the same write, which makes tickets single-use
export async function redeemTicket(rawCode) {
  const code = normalizeCode(rawCode);
  const user = auth.currentUser;
  const snap = await get(ref(db, `/tickets/${code}`)).catch(() => null);
  const ticket = snap?.val();
  if (!ticket || ticket.expires < Date.now()) throw new Error('Invalid or expired code');
  if (ticket.uid !== user.uid) throw new Error('This code was issued for a different account');
  const logKey = push(ref(db, '/log')).key;
  await update(ref(db), {
    [`log/${logKey}`]: logEntry('redeemed', { detail: `code ${formatCode(code)}, ${formatDuration(ticket.accessMs)}` }),
    [`requests/${user.uid}`]: null,
    [`grants/${user.uid}`]: {
      code,
      redeemedAt: serverTimestamp(),
      accessMs: ticket.accessMs,
      name: (user.displayName || user.email || 'Viewer').slice(0, 99),
      email: user.email,
    },
    [`tickets/${code}`]: null,
  });
}

// The rules require email to match the verified Google email, so the admin always sees the real address
export async function requestAccess(type = 'viewer') {
  const user = auth.currentUser;
  await update(ref(db), {
    [`requests/${user.uid}`]: {
      name: (user.displayName || user.email || 'Viewer').slice(0, 99),
      email: user.email,
      type,
      ts: serverTimestamp(),
    },
    [`log/${push(ref(db, '/log')).key}`]: logEntry(type === 'home' ? 'requested-home' : 'requested', { detail: 'Android app' }),
  });
}

export async function isHomeAccount() {
  const snap = await get(ref(db, '/home/uid')).catch(() => null);
  return !!snap && snap.val() === auth.currentUser?.uid;
}

export async function isAdmin() {
  const snap = await get(ref(db, '/admin/uid')).catch(() => null);
  return !!snap && snap.val() === auth.currentUser?.uid;
}

const CANCELLED = new Set(['user_cancel', 'system_cancel', 'app_cancel']);

// Returns false only when the user cancels; other failures throw so the caller can show why.
// err.code === 'no-lock' means the phone has no screen lock, so there is nothing to check against.
export async function confirmWithDevice(promptMessage) {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) {
    const err = new Error('Set up a screen lock or fingerprint on this phone first');
    err.code = 'no-lock';
    throw err;
  }
  const result = await LocalAuthentication.authenticateAsync({ promptMessage });
  if (result.success) return true;
  if (CANCELLED.has(result.error)) return false;
  console.warn('Device check failed:', result.error, result.warning);
  throw new Error(`Device check failed (${result.error}${result.warning ? `: ${result.warning}` : ''})`);
}
