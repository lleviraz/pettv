import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { firebaseConfig, WEB_CLIENT_ID } from './firebase-config';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db = getDatabase(app);
export const DB_URL = firebaseConfig.databaseURL;
export const WEB_URL = `https://${firebaseConfig.projectId}.web.app`;
export { WEB_CLIENT_ID };
