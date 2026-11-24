import { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { onAuthStateChanged, GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import { GoogleSignin, GoogleSigninButton } from '@react-native-google-signin/google-signin';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, WEB_CLIENT_ID } from '../config';

GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });

export default function SignInScreen() {
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const role = await AsyncStorage.getItem('role');
        if (role === 'home') router.replace('/home-mode');
        else if (role === 'viewer') router.replace('/viewer-mode');
        else router.replace('/role-picker');
      } else {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  async function signIn() {
    setError(null);
    setSigningIn(true);
    try {
      await GoogleSignin.hasPlayServices();
      const { data } = await GoogleSignin.signIn();
      const credential = GoogleAuthProvider.credential(data.idToken);
      await signInWithCredential(auth, credential);
      // onAuthStateChanged above will redirect
    } catch (e) {
      console.warn('Sign-in failed:', e?.code, e?.message);
      setError(`Sign-in failed (${e?.code ?? 'unknown'}): ${e?.message ?? String(e)}`);
      setSigningIn(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#4A90E2" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Image source={require('../../assets/images/tako.jpg')} style={styles.hero} />
      <Text style={styles.title}>PetTV</Text>
      <Text style={styles.subtitle}>Watch your pet from anywhere</Text>

      <GoogleSigninButton
        style={styles.button}
        size={GoogleSigninButton.Size.Wide}
        color={GoogleSigninButton.Color.Dark}
        onPress={signIn}
        disabled={signingIn}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    gap: 16,
  },
  hero: {
    width: 210,
    height: 280,
    borderRadius: 28,
  },
  title: {
    fontSize: 40,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 24,
  },
  button: {
    width: 240,
    height: 48,
  },
  error: {
    color: '#c0392b',
    fontSize: 14,
    textAlign: 'center',
  },
});
