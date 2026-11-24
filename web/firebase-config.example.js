// Copy to firebase-config.js (git-ignored) and fill in your Firebase *Web app* config
// (Firebase console → Project settings → Your apps → Web app).
export const firebaseConfig = {
  apiKey: 'YOUR_WEB_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT_ID',
  appId: 'YOUR_WEB_APP_ID',
};

// Secret folder the viewer page is deployed under (the bare domain serves a 404).
// Use a long random string, e.g. 32 lowercase letters and digits.
export const webPath = 'LONG_RANDOM_FOLDER_NAME';
