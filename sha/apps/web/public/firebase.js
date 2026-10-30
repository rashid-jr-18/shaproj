/**
 * @file apps/web/public/firebase.js
 * Modular Firebase Configuration with Local Emulator Suite Support
 * Dynamically loaded strictly from Backend Environment (.env) - ZERO HARDCODING
 */

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

/**
 * Dynamically fetches Firebase configuration strictly from the Backend .env endpoint
 */
export async function getFirebaseConfig() {
  if (typeof window !== 'undefined' && window.HIRA_FIREBASE_CONFIG && window.HIRA_FIREBASE_CONFIG.apiKey) {
    return window.HIRA_FIREBASE_CONFIG;
  }
  try {
    const res = await fetch('/api/v1/auth/firebase-config');
    const json = await res.json();
    if (json.success && json.data) {
      if (typeof window !== 'undefined') {
        window.HIRA_FIREBASE_CONFIG = json.data;
      }
      return json.data;
    }
  } catch (err) {
    console.warn('[Firebase] Notice: Config will load from environment when available.', err.message);
  }
  return {};
}

let appInstance = null;
let authInstance = null;
let dbInstance = null;
let storageInstance = null;

/**
 * Initializes Firebase services from .env config and connects to Local Emulators if on localhost
 */
export async function initFirebaseServices() {
  if (appInstance) {
    return { app: appInstance, auth: authInstance, db: dbInstance, storage: storageInstance };
  }

  const config = await getFirebaseConfig();
  if (!config || !config.apiKey) {
    return { app: null, auth: null, db: null, storage: null };
  }

  appInstance = !getApps().length ? initializeApp(config) : getApp();
  authInstance = getAuth(appInstance);
  dbInstance = getFirestore(appInstance);
  storageInstance = getStorage(appInstance);

  const isLocalhost = Boolean(
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
     window.location.hostname === '127.0.0.1')
  );

  // Connect to Local Emulator Suite when enabled on localhost
  if (isLocalhost && window.USE_FIREBASE_EMULATORS && !window._FIREBASE_EMULATORS_CONNECTED_) {
    console.log('🔧 Connecting to Firebase Local Emulator Suite...');
    connectAuthEmulator(authInstance, 'http://localhost:9099', { disableWarnings: true });
    connectFirestoreEmulator(dbInstance, 'localhost', 8080);
    connectStorageEmulator(storageInstance, 'localhost', 9199);
    window._FIREBASE_EMULATORS_CONNECTED_ = true;
    console.log('✅ Connected to Local Emulators (Auth: 9099, Firestore: 8080, Storage: 9199)');
  }

  return { app: appInstance, auth: authInstance, db: dbInstance, storage: storageInstance };
}

export { appInstance as app, authInstance as auth, dbInstance as db, storageInstance as storage };
