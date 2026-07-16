import { pushTokens } from '../db.js';
import { authenticateRequest } from '../token.js';
import { sendPush } from '../firebase.js';

// Push token kaydı + gizli bildirim gönderimi (SPARK, 2026-07-16).
// GİZLİLİK: push'ta içerik YOK — yalnız jenerik "yeni bildirim" metni.
// SPARK içeriği uçtan uca şifreli kutuda kalır; FCM/Apple yalnız
// "bu cihaza bir şey geldi" olgusunu görür.

// Jenerik bildirim gövdesi — istemcinin kayıtta bildirdiği dile göre.
const PUSH_BODY = {
  tr: 'Yeni bir bildirimin var.',
  en: 'You have a new notification.',
  es: 'Tienes una notificación nueva.',
  de: 'Du hast eine neue Benachrichtigung.',
  fr: 'Tu as une nouvelle notification.',
  it: 'Hai una nuova notifica.',
  pt: 'Você tem uma nova notificação.',
  pl: 'Masz nowe powiadomienie.',
  ja: '新しい通知があります。',
  zh: '你有一条新通知。',
  ru: 'У тебя новое уведомление.',
};

/// [toHash] kullanıcısına jenerik gizli bildirim gönderir. Dönüş: FCM kabul
/// etti mi (true) — gönderene dürüst beklenti kurmak için (/spark cevabındaki
/// 'pushed'). ASLA fırlatmaz; token yoksa/başarısızsa false.
export async function notifyUser(toHash) {
  try {
    const rec = pushTokens.get(toHash);
    if (!rec) return false;
    const body = PUSH_BODY[rec.lang] || PUSH_BODY.en;
    const res = await sendPush(rec.token, { title: 'RYTEX', body });
    if (res === 'invalid_token') {
      pushTokens.deleteByToken(rec.token);
      return false;
    }
    return res === 'ok';
  } catch {
    return false;
  }
}

export default async function pushRoutes(fastify) {
  // Token kaydı/güncellemesi. POST /api/push-token  Body: { token, lang? }
  fastify.post('/push-token', {
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', minLength: 16, maxLength: 512 },
          lang: { type: 'string', minLength: 2, maxLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    pushTokens.set(claims.sub, request.body.token, request.body.lang);
    return reply.send({ status: 'ok' });
  });
}
