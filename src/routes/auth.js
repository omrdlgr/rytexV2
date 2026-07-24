import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { userStore, pushTokens, partnerships, deleteAccount } from '../db.js';
import { signToken, revokeToken, authenticateRequest } from '../token.js';
import { verifyPhoneToken } from '../firebase.js';
import { peers } from './partner.js';

const SALT_ROUNDS = 12;

// Frontend phoneHashOf ile AYNI: SHA-256(E.164 numara), hex.
function phoneHashOf(phoneE164) {
  return createHash('sha256').update(phoneE164, 'utf8').digest('hex');
}

export default async function authRoutes(fastify) {
  // POST /api/register
  // Body: { phoneHash: string, password: string }
  fastify.post('/register', {
    // Brute-force/spam koruması: IP başına dakikada 5 deneme
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['phoneHash', 'password'],
        properties: {
          phoneHash: { type: 'string', minLength: 8 },
          password: { type: 'string', minLength: 6 },
        },
      },
    },
  }, async (request, reply) => {
    const { phoneHash, password } = request.body;

    if (userStore.has(phoneHash)) {
      return reply.code(409).send({ error: 'already_registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    userStore.create(phoneHash, passwordHash);

    const token = signToken(phoneHash);
    return reply.code(201).send({ token });
  });

  // POST /api/login
  // Body: { phoneHash: string, password: string }
  fastify.post('/login', {
    // Brute-force koruması: IP başına dakikada 5 deneme
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['phoneHash', 'password'],
        properties: {
          // minLength register ile tutarlı (B7) — şema doğrulama simetrisi
          phoneHash: { type: 'string', minLength: 8 },
          password: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { phoneHash, password } = request.body;

    const user = userStore.get(phoneHash);
    if (!user) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = signToken(phoneHash);
    return reply.send({ token });
  });

  // POST /api/verify-phone — Firebase telefon doğrulaması.
  // Body: { idToken }  → Firebase ID token doğrulanır, phone_number'dan
  // phoneHash türetilir, kullanıcı yoksa oluşturulur, bizim JWT döner.
  fastify.post('/verify-phone', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['idToken'],
        properties: { idToken: { type: 'string', minLength: 20 } },
      },
    },
  }, async (request, reply) => {
    const phone = await verifyPhoneToken(request.body.idToken);
    if (!phone) {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    const phoneHash = phoneHashOf(phone);
    userStore.ensurePhone(phoneHash);
    const token = signToken(phoneHash);
    return reply.send({ token, phoneHash });
  });

  // POST /api/logout — mevcut token'ı iptal eder (B7 revocation).
  // Header: Authorization: Bearer <token>
  fastify.post('/logout', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    revokeToken(claims);
    // Çıkan kullanıcıya artık push gitmesin (cihaz başkasına geçebilir).
    pushTokens.delete(claims.sub);
    return reply.send({ status: 'logged_out' });
  });

  // DELETE /api/account — hesabın TÜM sunucu kaydını siler.
  // Apple App Store Guideline 5.1.1(v): hesap oluşturma varsa uygulama
  // İÇİNDEN hesap silme zorunlu. Header: Authorization: Bearer <token>
  //
  // Sıra önemli: partner listesi silmeden ÖNCE alınır, yoksa kimi
  // bilgilendireceğimizi kaybederiz. Silme sonrası online partnerler
  // 'partner:removed' alır (disconnect ile aynı olay → istemci mevcut
  // eşitleme yolunu kullanır); offline olanlar bir sonraki
  // /partner/list eşitlemesinde yakalar.
  fastify.delete('/account', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    const userHash = claims.sub;
    const affected = partnerships.listFor(userHash);

    deleteAccount(userHash);
    revokeToken(claims);

    const io = fastify.io;
    if (io) {
      for (const partnerHash of affected) {
        const peer = peers.get(partnerHash);
        if (peer?.socketId) {
          io.to(peer.socketId).emit('partner:removed', { from: userHash });
        }
      }
    }
    // Silinen kullanıcının kendi soketi de artık geçersiz token taşıyor.
    peers.delete(userHash);

    return reply.send({ status: 'account_deleted', partnersNotified: affected.length });
  });
}
