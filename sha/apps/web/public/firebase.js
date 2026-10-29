/**
 * @file apps/web/public/firebase.js
 * Modular Firebase Configuration with Local Emulator Suite Support
 * Configured for Project: ecom-bd90e
 */

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

// 1. Firebase Configuration (Project: ecom-bd90e)
const firebaseConfig = {
 
};

// 2. Initialize Firebase App (prevent re-initializing if already initialized)
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// 3. Initialize Services
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// 4. Auto-detect if running locally on localhost
const isLocalhost = Boolean(
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' ||
   window.location.hostname === '127.0.0.1')
);

// Flag to ensure emulators are only connected once when using Emulator Suite
if (isLocalhost && window.USE_FIREBASE_EMULATORS && !window._FIREBASE_EMULATORS_CONNECTED_) {
  console.log('🔧 Connecting to Firebase Local Emulator Suite...');

  // Auth Emulator: port 9099
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });

  // Firestore Emulator: port 8080
  connectFirestoreEmulator(db, 'localhost', 8080);

  // Cloud Storage Emulator: port 9199
  connectStorageEmulator(storage, 'localhost', 9199);

  window._FIREBASE_EMULATORS_CONNECTED_ = true;
  console.log('✅ Connected to Local Emulators (Auth: 9099, Firestore: 8080, Storage: 9199)');
}

// 5. Export instances
export { app, auth, db, storage, firebaseConfig };
