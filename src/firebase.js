import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Firebase Admin — telefon doğrulama ID token'larını doğrular.
// FIREBASE_SERVICE_ACCOUNT_JSON: servis hesabı JSON'u (string). Yoksa
// telefon doğrulama devre dışı (verifyPhoneToken null döner).
// NOT: firebase-admin v14 ESM'de eski `admin.credential.cert` namespace'i
// YOK (undefined) — modüler API (firebase-admin/app) zorunlu.
let _app = null;

function app() {
  if (_app) return _app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const existing = getApps();
    if (existing.length > 0) {
      _app = existing[0];
      return _app;
    }
    _app = initializeApp({ credential: cert(JSON.parse(raw)) });
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
    const decoded = await getAuth(a).verifyIdToken(idToken);
    return decoded.phone_number || null;
  } catch (e) {
    console.error('[FIREBASE] verifyIdToken hata:', e.message);
    return null;
  }
}
