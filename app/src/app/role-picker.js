import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { ref, get, push } from 'firebase/database';
import { auth, db } from '../config';

export default function RolePickerScreen() {
  const [picking, setPicking] = useState(false);

  async function pickRole(role) {
    if (picking) return;
    setPicking(true);
    try {
      if (role === 'viewer') {
        const uid = auth.currentUser?.uid;
        const snap = await get(ref(db, `/whitelist/${uid}`));
        if (!snap.val()) {
          await push(ref(db, '/log'), {
            uid,
            email: auth.currentUser?.email ?? null,
            event: 'blocked',
            ts: Date.now(),
          });
          Alert.alert('Access denied', 'Your account is not on the whitelist. Contact the owner.');
          setPicking(false);
          return;
        }
      }

      await AsyncStorage.setItem('role', role);
      router.replace(role === 'home' ? '/home-mode' : '/viewer-mode');
    } catch {
      setPicking(false);
    }
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
  subtitle: { fontSize: 15, color: '#666', marginBottom: 16 },
  card: { width: '100%', borderRadius: 16, padding: 24, alignItems: 'center', gap: 6 },
  cardHome: { backgroundColor: '#EAF4FF' },
  cardViewer: { backgroundColor: '#F0FFF4' },
  cardEmoji: { fontSize: 36 },
  cardTitle: { fontSize: 20, fontWeight: '600', color: '#1a1a1a' },
  cardDesc: { fontSize: 14, color: '#555', textAlign: 'center' },
});
