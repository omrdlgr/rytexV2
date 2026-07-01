import admin from 'firebase-admin';

// Firebase Admin — telefon doğrulama ID token'larını doğrular.
// FIREBASE_SERVICE_ACCOUNT_JSON: servis hesabı JSON'u (string). Yoksa
// telefon doğrulama devre dışı (verifyPhoneToken null döner).
let _app = null;

function app() {
  if (_app) return _app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const cred = JSON.parse(raw);
    _app = admin.initializeApp({ credential: admin.credential.cert(cred) });
    return _app;
  } catch (e) {
    console.error('[FIREBASE] init hata:', e.message);
    return null;
  }
}

/// ID token'ı doğrular → doğrulanmış phone_number (E.164) döner; geçersizse null.
export async function verifyPhoneToken(idToken) {
  const a = app();
  if (!a) return null;
  try {
    const decoded = await admin.auth(a).verifyIdToken(idToken);
    return decoded.phone_number || null;
  } catch (e) {
    console.error('[FIREBASE] verifyIdToken hata:', e.message);
    return null;
  }
}
