/**
 * Template for local development.
 * Production builds fetch config from Google Secret Manager at build time.
 */
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
  vapidKey: 'YOUR_WEB_PUSH_CERTIFICATE_KEY',
};
