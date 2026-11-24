import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Share, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { ref, onValue, set, remove, query, limitToLast, serverTimestamp } from 'firebase/database';
import { db, WEB_URL } from '../config';
import {
  generateTicketCode, formatCode, formatDuration, isAdmin, confirmWithDevice, logEvent, TICKET_REDEEM_WINDOW_MS,
} from '../access';

const EVENT_LABELS = {
  'requested': '🙋 Requested access',
  'requested-home': '🏠 Requested to be home phone',
  'home-changed': '🏠 Home phone changed',
  'home-online': '🟢 Home phone online',
  'home-stopped': '🔴 Home phone stopped',
  'home-paused': '⏸ Home phone paused (screen off)',
  'home-resumed': '▶️ Home phone resumed',
  'camera-on': '📷 Camera on',
  'camera-off': '📷 Camera off',
  'code-created': '🎟 Code sent',
  'redeemed': '✅ Code redeemed',
  'no-access': '⛔ Tried without access',
  'watch-start': '👁 Started watching',
  'watch-stop': '⏹ Stopped watching',
  'revoked': '↩️ Access revoked',
  'blocked': '🚫 Blocked',
  'unblocked': '🔓 Unblocked',
};

const HOUR = 60 * 60 * 1000;
const DURATIONS = [
  { label: '1 hour', ms: HOUR },
  { label: '1 day', ms: 24 * HOUR },
  { label: '7 days', ms: 7 * 24 * HOUR },
  { label: '30 days', ms: 30 * 24 * HOUR },
];

// For events the home phone or admin logs about someone else, the viewer's name is in detail
const ABOUT_OTHERS = new Set(['watch-start', 'watch-stop', 'revoked', 'blocked', 'unblocked', 'home-changed']);

function describeActor(e) {
  if (ABOUT_OTHERS.has(e.event)) return e.detail ?? e.subject ?? '';
  return [e.email, e.detail].filter(Boolean).join(' · ');
}

function personLabel(p) {
  return p.email ? `${p.name} (${p.email})` : p.name;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AdminScreen() {
  const [state, setState] = useState('checking'); // checking | locked | unlocked | denied
  const [error, setError] = useState(null);
  const [grants, setGrants] = useState({});
  const [tickets, setTickets] = useState({});
  const [sessions, setSessions] = useState({});
  const [blocked, setBlocked] = useState({});
  const [log, setLog] = useState({});
  const [requests, setRequests] = useState({});
  const [codeFor, setCodeFor] = useState(null); // uid whose duration picker is open
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    isAdmin().then(ok => {
      if (!ok) { setState('denied'); return; }
      setState('locked');
      unlock();
    });
  }, []);

  useEffect(() => {
    if (state !== 'unlocked') return;
    const onErr = (e) => setError(e.message);
    const unsubs = [
      onValue(ref(db, '/grants'), s => setGrants(s.val() || {}), onErr),
      onValue(ref(db, '/tickets'), s => setTickets(s.val() || {}), onErr),
      onValue(ref(db, '/sessions'), s => setSessions(s.val() || {}), onErr),
      onValue(ref(db, '/blocked'), s => setBlocked(s.val() || {}), onErr),
      onValue(ref(db, '/requests'), s => setRequests(s.val() || {}), onErr),
      onValue(query(ref(db, '/log'), limitToLast(50)), s => setLog(s.val() || {}), onErr),
    ];
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => { unsubs.forEach(u => u()); clearInterval(timer); };
  }, [state]);

  async function guarded(prompt, action) {
    setError(null);
    try {
      if (!(await confirmWithDevice(prompt))) return;
      await action();
    } catch (e) {
      setError(e?.message ?? String(e));
    }
  }

  function unlock() {
    guarded('Unlock PetTV admin', async () => setState('unlocked'));
  }

  // The code only works for the requesting account; send it through a contact you already trust for that person
  function sendCode(req, duration) {
    guarded(`Send ${req.name} a ${duration.label} code`, async () => {
      const code = generateTicketCode();
      await set(ref(db, `/tickets/${code}`), {
        uid: req.uid,
        name: req.name,
        email: req.email,
        expires: Date.now() + TICKET_REDEEM_WINDOW_MS,
        accessMs: duration.ms,
        createdAt: Date.now(),
      });
      logEvent('code-created', { subject: req.uid, detail: `${req.name} (${req.email}): code ${formatCode(code)}, ${formatDuration(duration.ms)}` });
      setCodeFor(null);
      await Share.share({
        message:
          `PetTV access code: ${formatCode(code)}\n` +
          `Enter it within 10 minutes (${WEB_URL}). Access lasts ${duration.label}.`,
      });
    });
  }

  function makeHome(req) {
    Alert.alert(
      'Change home phone',
      `Make ${req.name} (${req.email}) the home phone? The current home phone stops streaming.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Make home', style: 'destructive', onPress: () => guarded('Change home phone', async () => {
            await set(ref(db, '/home'), { uid: req.uid });
            await remove(ref(db, `/requests/${req.uid}`));
            logEvent('home-changed', { subject: req.uid, detail: `${req.name} (${req.email})` });
          }),
        },
      ],
    );
  }

  function dismissRequest(uid) {
    guarded('Dismiss request', () => remove(ref(db, `/requests/${uid}`)));
  }

  function revoke(p) {
    Alert.alert('Revoke access', `Stop ${personLabel(p)} from watching? A live stream ends right away.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke', style: 'destructive', onPress: () => guarded('Revoke access', async () => {
          await remove(ref(db, `/grants/${p.uid}`));
          logEvent('revoked', { subject: p.uid, detail: personLabel(p).slice(0, 199) });
        }),
      },
    ]);
  }

  // Blocking overrides the whitelist and codes; the home phone cuts a live stream as soon as this lands
  function block(p) {
    Alert.alert('Block viewer', `Block ${personLabel(p)}? Their stream ends now and they can't watch or redeem codes until unblocked.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block', style: 'destructive', onPress: () => guarded('Block viewer', async () => {
          await set(ref(db, `/blocked/${p.uid}`), {
            name: String(p.name).slice(0, 199),
            ...(p.email ? { email: p.email } : {}),
            ts: serverTimestamp(),
          });
          await remove(ref(db, `/grants/${p.uid}`));
          logEvent('blocked', { subject: p.uid, detail: personLabel(p).slice(0, 199) });
        }),
      },
    ]);
  }

  function unblock(p) {
    guarded('Unblock viewer', async () => {
      await remove(ref(db, `/blocked/${p.uid}`));
      logEvent('unblocked', { subject: p.uid, detail: personLabel(p).slice(0, 199) });
    });
  }

  function cancelTicket(code) {
    guarded('Cancel access code', () => remove(ref(db, `/tickets/${code}`)));
  }

  if (state === 'checking') {
    return <View style={styles.center}><ActivityIndicator color="#4A90E2" /></View>;
  }

  if (state === 'denied') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>This account is not the PetTV admin.</Text>
        <TouchableOpacity onPress={() => router.replace('/role-picker')}>
          <Text style={styles.link}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (state === 'locked') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Admin locked</Text>
        {!!error && <Text style={styles.errorText}>{error}</Text>}
        <TouchableOpacity style={styles.primaryBtn} onPress={unlock}>
          <Text style={styles.primaryText}>Unlock</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.replace('/role-picker')}>
          <Text style={styles.link}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const activeGrants = Object.entries(grants)
    .map(([uid, g]) => ({ uid, ...g, until: g.redeemedAt + g.accessMs }))
    .filter(g => g.until > now)
    .sort((a, b) => a.until - b.until);
  const openTickets = Object.entries(tickets)
    .map(([code, t]) => ({ code, ...t }))
    .filter(t => t.expires > now);
  const watching = Object.entries(sessions)
    .filter(([, s]) => s && s.request)
    .map(([uid, s]) => ({ uid, name: s.name || uid, email: s.email, device: s.device }));
  const blockedList = Object.entries(blocked).map(([uid, b]) => ({ uid, ...b }));
  const pending = Object.entries(requests)
    .filter(([uid]) => !blocked[uid])
    .map(([uid, r]) => ({ uid, ...r }))
    .sort((a, b) => b.ts - a.ts);
  const activity = Object.values(log).sort((a, b) => b.ts - a.ts);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.title}>PetTV Admin</Text>
      {!!error && <Text style={styles.errorText}>{error}</Text>}

      <Text style={styles.section}>Watching now ({watching.length})</Text>
      {watching.length === 0 && <Text style={styles.hint}>No one is watching.</Text>}
      {watching.map(w => (
        <View key={w.uid} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>{w.name}</Text>
            {!!(w.email || w.device) && (
              <Text style={styles.rowSub} numberOfLines={2}>{[w.email, w.device].filter(Boolean).join(' · ')}</Text>
            )}
          </View>
          <TouchableOpacity style={styles.dangerBtn} onPress={() => block(w)}>
            <Text style={styles.dangerText}>Block</Text>
          </TouchableOpacity>
        </View>
      ))}

      <Text style={styles.section}>Pending requests ({pending.length})</Text>
      {pending.length === 0 && <Text style={styles.hint}>No one is waiting for access.</Text>}
      {pending.map(r => (
        <View key={r.uid} style={styles.requestCard}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>{r.type === 'home' ? '🏠 ' : ''}{r.name}</Text>
            <Text style={styles.rowSub} numberOfLines={1}>
              {r.type === 'home' ? 'wants to be the home phone · ' : ''}{r.email} · {fmtTime(r.ts)}
            </Text>
          </View>
          {r.type === 'home' ? (
            <View style={styles.durationRow}>
              <TouchableOpacity style={styles.durationBtn} onPress={() => makeHome(r)}>
                <Text style={styles.durationText}>Make home phone</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.neutralBtn} onPress={() => dismissRequest(r.uid)}>
                <Text style={styles.neutralText}>Dismiss</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dangerBtn} onPress={() => block(r)}>
                <Text style={styles.dangerText}>Block</Text>
              </TouchableOpacity>
            </View>
          ) : codeFor === r.uid ? (
            <>
              <Text style={styles.hint}>Code valid 10 minutes, only for this account. Access lasts:</Text>
              <View style={styles.durationRow}>
                {DURATIONS.map(d => (
                  <TouchableOpacity key={d.label} style={styles.durationBtn} onPress={() => sendCode(r, d)}>
                    <Text style={styles.durationText}>{d.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : (
            <View style={styles.durationRow}>
              <TouchableOpacity style={styles.durationBtn} onPress={() => setCodeFor(r.uid)}>
                <Text style={styles.durationText}>Send code</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.neutralBtn} onPress={() => dismissRequest(r.uid)}>
                <Text style={styles.neutralText}>Dismiss</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dangerBtn} onPress={() => block(r)}>
                <Text style={styles.dangerText}>Block</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      ))}

      <Text style={styles.section}>Access granted ({activeGrants.length})</Text>
      {activeGrants.length === 0 && <Text style={styles.hint}>No one has temporary access.</Text>}
      {activeGrants.map(g => (
        <View key={g.uid} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>{g.name}</Text>
            <Text style={styles.rowSub} numberOfLines={1}>{g.email ? `${g.email} · ` : ''}until {fmtTime(g.until)}</Text>
          </View>
          <TouchableOpacity style={styles.dangerBtn} onPress={() => revoke(g)}>
            <Text style={styles.dangerText}>Revoke</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dangerBtn} onPress={() => block(g)}>
            <Text style={styles.dangerText}>Block</Text>
          </TouchableOpacity>
        </View>
      ))}

      <Text style={styles.section}>Unused codes ({openTickets.length})</Text>
      {openTickets.length === 0 && <Text style={styles.hint}>None waiting.</Text>}
      {openTickets.map(t => (
        <View key={t.code} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{formatCode(t.code)}{t.name ? ` · ${t.name}` : ''}</Text>
            <Text style={styles.rowSub} numberOfLines={1}>{t.email ? `${t.email} · ` : ''}use by {fmtTime(t.expires)}</Text>
          </View>
          <TouchableOpacity style={styles.dangerBtn} onPress={() => cancelTicket(t.code)}>
            <Text style={styles.dangerText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ))}

      <Text style={styles.section}>Blocked ({blockedList.length})</Text>
      {blockedList.length === 0 && <Text style={styles.hint}>No one is blocked.</Text>}
      {blockedList.map(b => (
        <View key={b.uid} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>{b.name}</Text>
            <Text style={styles.rowSub} numberOfLines={1}>{b.email ? `${b.email} · ` : ''}since {fmtTime(b.ts)}</Text>
          </View>
          <TouchableOpacity style={styles.neutralBtn} onPress={() => unblock(b)}>
            <Text style={styles.neutralText}>Unblock</Text>
          </TouchableOpacity>
        </View>
      ))}

      <Text style={styles.section}>Activity (last 50)</Text>
      {activity.length === 0 && <Text style={styles.hint}>Nothing yet.</Text>}
      {activity.map((e, i) => (
        <View key={i} style={styles.logRow}>
          <Text style={styles.logTime}>{fmtTime(e.ts)}</Text>
          <Text style={styles.logEvent}>{EVENT_LABELS[e.event] ?? e.event}</Text>
          <Text style={styles.logWho} numberOfLines={2}>{describeActor(e)}</Text>
        </View>
      ))}

      <TouchableOpacity style={styles.doneBtn} onPress={() => router.replace('/role-picker')}>
        <Text style={styles.link}>Done</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, padding: 24, backgroundColor: '#fff' },
  scroll: { flex: 1, backgroundColor: '#fff' },
  container: { padding: 24, paddingTop: 56, gap: 12 },
  title: { fontSize: 26, fontWeight: '700', color: '#1a1a1a' },
  section: { fontSize: 13, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16 },
  hint: { fontSize: 14, color: '#888' },
  errorText: { fontSize: 14, color: '#c0392b', textAlign: 'center' },
  durationRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  durationBtn: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: '#4A90E2' },
  durationText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: '#F4F6F8' },
  requestCard: { gap: 10, padding: 12, borderRadius: 12, backgroundColor: '#FFF8E6' },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  rowSub: { fontSize: 13, color: '#777' },
  dangerBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: '#FDECEA' },
  dangerText: { color: '#c0392b', fontWeight: '600' },
  neutralBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: '#E8F0FB' },
  neutralText: { color: '#4A90E2', fontWeight: '600' },
  logRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd', gap: 2 },
  logTime: { fontSize: 12, color: '#999' },
  logEvent: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  logWho: { fontSize: 13, color: '#555' },
  primaryBtn: { paddingHorizontal: 36, paddingVertical: 14, borderRadius: 12, backgroundColor: '#4A90E2' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  doneBtn: { alignItems: 'center', marginTop: 24 },
  link: { color: '#4A90E2', fontSize: 16, fontWeight: '600' },
});
