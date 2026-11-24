import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { signOut } from 'firebase/auth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { ref, onValue } from 'firebase/database';
import { auth, db } from '../config';
import {
  hasViewerAccess, redeemTicket, isAdmin, logEvent, requestAccess, isHomeAccount,
} from '../access';

const KNOWN_ERRORS = ['Invalid or expired code', 'This code was issued for a different account'];

function fmtTime(ms) {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function RolePickerScreen() {
  const [picking, setPicking] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [needCode, setNeedCode] = useState(false);
  const [needHome, setNeedHome] = useState(false);
  const [myRequest, setMyRequest] = useState(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(null);

  useEffect(() => {
    isAdmin().then(setAdmin);
  }, []);

  // Live, so the request button re-enables as soon as the admin dismisses or answers the request
  useEffect(() => {
    if (!needCode && !needHome) return;
    return onValue(ref(db, `/requests/${auth.currentUser.uid}`), s => setMyRequest(s.val()), () => setMyRequest(null));
  }, [needCode, needHome]);

  async function enter(role) {
    await AsyncStorage.setItem('role', role);
    router.replace(role === 'home' ? '/home-mode' : '/viewer-mode');
  }

  async function pickRole(role) {
    if (picking) return;
    setPicking(true);
    try {
      if (role === 'home' && !(await isHomeAccount())) {
        setNeedHome(true);
        setPicking(false);
        return;
      }
      if (role === 'viewer') {
        const user = auth.currentUser;
        if (!(await hasViewerAccess(user.uid))) {
          logEvent('no-access', { detail: 'Android app' });
          setNeedCode(true);
          setPicking(false);
          return;
        }
      }
      await enter(role);
    } catch {
      setPicking(false);
    }
  }

  // Google sign-out too, otherwise the next sign-in silently reuses the same account
  async function signOutAll() {
    setPicking(true);
    await AsyncStorage.removeItem('role');
    await GoogleSignin.signOut().catch(() => {});
    await signOut(auth);
    router.replace('/');
  }

  async function submitCode() {
    setCodeError(null);
    setPicking(true);
    try {
      await redeemTicket(code);
      await enter('viewer');
    } catch (e) {
      setCodeError(KNOWN_ERRORS.includes(e?.message) ? e.message : 'Code not accepted. Ask the owner for a new one.');
      setPicking(false);
    }
  }

  async function sendRequest(type = 'viewer') {
    setCodeError(null);
    setPicking(true);
    try {
      await requestAccess(type);
    } catch (e) {
      setCodeError('Could not send the request: ' + (e?.message ?? String(e)));
    }
    setPicking(false);
  }

  // One request per account at a time (the rules refuse a second one), so any pending request dims the button
  const pending = !!myRequest;
  const requestButton = (type, label) => (
    <TouchableOpacity
      style={[styles.primaryBtn, (pending || picking) && styles.dimmedBtn]}
      onPress={() => sendRequest(type)}
      disabled={pending || picking}
    >
      <Text style={styles.primaryText}>{pending ? 'Request sent — waiting for the owner' : label}</Text>
    </TouchableOpacity>
  );

  if (needHome) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Not the home phone</Text>
        <Text style={styles.subtitle}>
          {myRequest?.type === 'home'
            ? `Request sent ${fmtTime(myRequest.ts)}. Once the owner approves, pick "Home phone" again.`
            : `${auth.currentUser?.email} isn't the registered home account. The owner must approve it first.`}
        </Text>
        {requestButton('home', 'Request to be the home phone')}
        {!!codeError && <Text style={styles.error}>{codeError}</Text>}
        <TouchableOpacity onPress={() => { setNeedHome(false); setCodeError(null); }}>
          <Text style={styles.link}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={signOutAll} disabled={picking}>
          <Text style={styles.link}>Use a different Google account</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (needCode) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Access needed</Text>
        <Text style={styles.subtitle}>
          {myRequest?.type === 'viewer'
            ? `Request sent ${fmtTime(myRequest.ts)}. The owner will send you a code. Enter it below.`
            : `${auth.currentUser?.email} doesn't have access. Request it, then enter the code the owner sends you.`}
        </Text>
        {requestButton('viewer', 'Request access')}
        <TextInput
          style={styles.codeInput}
          value={code}
          onChangeText={setCode}
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
        />
        {!!codeError && <Text style={styles.error}>{codeError}</Text>}
        {picking ? <ActivityIndicator color="#4A90E2" /> : (
          <TouchableOpacity style={styles.primaryBtn} onPress={submitCode} disabled={code.trim().length < 8}>
            <Text style={styles.primaryText}>Unlock</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => { setNeedCode(false); setCode(''); setCodeError(null); }}>
          <Text style={styles.link}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={signOutAll} disabled={picking}>
          <Text style={styles.link}>Use a different Google account</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Which device is this?</Text>
      <Text style={styles.subtitle}>You only need to pick once.</Text>

      <TouchableOpacity style={[styles.card, styles.cardHome]} onPress={() => pickRole('home')} disabled={picking}>
        <Text style={styles.cardEmoji}>🏠</Text>
        <Text style={styles.cardTitle}>Home phone</Text>
        <Text style={styles.cardDesc}>Stays home, streams the camera</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.card, styles.cardViewer]} onPress={() => pickRole('viewer')} disabled={picking}>
        <Text style={styles.cardEmoji}>📱</Text>
        <Text style={styles.cardTitle}>My phone</Text>
        <Text style={styles.cardDesc}>Watch from anywhere</Text>
      </TouchableOpacity>

      {admin && (
        <TouchableOpacity style={[styles.card, styles.cardAdmin]} onPress={() => router.push('/admin-mode')} disabled={picking}>
          <Text style={styles.cardEmoji}>🔐</Text>
          <Text style={styles.cardTitle}>Admin</Text>
          <Text style={styles.cardDesc}>Access codes and who can watch</Text>
        </TouchableOpacity>
      )}

      <View style={styles.account}>
        <Text style={styles.accountText} numberOfLines={1}>{auth.currentUser?.email}</Text>
        <TouchableOpacity onPress={signOutAll} disabled={picking}>
          <Text style={styles.link}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    gap: 16,
  },
  title: { fontSize: 26, fontWeight: '700', color: '#1a1a1a', textAlign: 'center' },
  subtitle: { fontSize: 15, color: '#666', marginBottom: 16, textAlign: 'center' },
  card: { width: '100%', borderRadius: 16, padding: 24, alignItems: 'center', gap: 6 },
  cardHome: { backgroundColor: '#EAF4FF' },
  cardViewer: { backgroundColor: '#F0FFF4' },
  cardAdmin: { backgroundColor: '#F5F0FF' },
  cardEmoji: { fontSize: 36 },
  cardTitle: { fontSize: 20, fontWeight: '600', color: '#1a1a1a' },
  cardDesc: { fontSize: 14, color: '#555', textAlign: 'center' },
  codeInput: {
    width: '100%',
    fontSize: 24,
    letterSpacing: 4,
    textAlign: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  error: { color: '#c0392b', fontSize: 14, textAlign: 'center' },
  primaryBtn: { paddingHorizontal: 36, paddingVertical: 14, borderRadius: 12, backgroundColor: '#27ae60' },
  dimmedBtn: { opacity: 0.45 },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  link: { color: '#4A90E2', fontSize: 16, fontWeight: '600' },
  account: { position: 'absolute', bottom: 36, left: 24, right: 24, alignItems: 'center', gap: 6 },
  accountText: { fontSize: 13, color: '#888' },
});
