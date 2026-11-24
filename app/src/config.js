import { initializeApp, getApps } from 'firebase/app';
import { getAuth, initializeAuth, getReactNativePersistence } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDatabase } from 'firebase/database';
import { firebaseConfig, WEB_CLIENT_ID } from './firebase-config';

const firstInit = getApps().length === 0;
const app = firstInit ? initializeApp(firebaseConfig) : getApps()[0];

// Without explicit persistence, React Native auth is memory-only and the home phone
// would need a manual sign-in after every restart
export const auth = firstInit
  ? initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) })
  : getAuth(app);
export const db = getDatabase(app);
export const DB_URL = firebaseConfig.databaseURL;
// The bare domain serves a 404; the viewer page lives under an unguessable folder in web/
export const WEB_URL = `https://${firebaseConfig.projectId}.web.app/6taqyspk98h9euuc/`;
export { WEB_CLIENT_ID };
