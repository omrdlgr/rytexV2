import { createHash } from 'node:crypto';
import { activeSessions, userStore, pushTokens, partnerships, deleteAccount } from '../db.js';
import { newSession, revokeToken, authenticateRequest } from '../token.js';
import { verifyPhoneToken } from '../firebase.js';
import { reconcileEntitlement } from '../entitlement_sync.js';
import { peers } from './partner.js';

// Frontend phoneHashOf ile AYNI: SHA-256(E.164 numara), hex.
function phoneHashOf(phoneE164) {
  return createHash('sha256').update(phoneE164, 'utf8').digest('hex');
}

export default async function authRoutes(fastify) {
  // ⚠️ POST /register ve POST /login KALDIRILDI (2026-08-11, güvenlik).
  //
  // AÇIK: /register yalnız {phoneHash, password} istiyordu — telefonun
  // başvurana ait olduğuna dair HİÇBİR kanıt aramıyordu — ve o phoneHash
  // için geçerli JWT dönüyordu. phoneHash = SHA-256(E.164) ve cep numarası
  // uzayı küçük olduğu için saldırgan herkesin hash'ini önceden
  // hesaplayabilir. Kurban henüz kayıtlı değilse saldırgan onun kimliğiyle
  // token alır, ardından PUT /keys ile KENDİ açık anahtarını kurbanınmış
  // gibi yayınlar; kurbanın partneri veri paylaştığında şifreleme
  // saldırganın anahtarıyla yapılır ve sağlık verisi çözülebilir.
  // Uçtan uca şifrelemenin tüm garantisi JWT'deki `sub`'ın telefon
  // sahipliğini kanıtlamasına dayanıyordu; bu uç o varsayımı kırıyordu.
  //
  // Uçlar ZATEN ÖLÜ KODDU: istemci hiçbir ekrandan çağırmıyor, kimlik
  // doğrulama tamamen /verify-phone (Firebase ID token) üzerinden.
  // Kaldırılması bcrypt bağımlılığını da düşürdü (tar CRITICAL zinciri).
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

    // 🔴 TEK AKTİF OTURUM: yeni cihazda giriş, ESKİ cihazın oturumunu kapatır.
    //
    // Tetikleyici eski cihazdan çıkış DEĞİL, buradaki yeni giriş — yani
    // telefon çalındıysa/bozulduysa da çalışır; eski cihaza dokunmak, hatta
    // açık olması gerekmiyor. Eskiden JWT 30 gün geçerliydi ve çalınan cihaz
    // o süre boyunca partnerlerin sağlık verisini almaya devam ediyordu.
    //
    // İkinci sebep: X25519 özel anahtarı cihaz yerel; ikinci cihaz `PUT /keys`
    // ile ortak anahtarı ezip ilk cihazın yeni paylaşımları çözmesini SESSİZCE
    // bozuyordu (önbellekteki eski veri görünmeye devam ettiği için fark
    // edilmiyordu). Mimari zaten "bir kimlik = bir cihaz" varsayıyordu.
    const { token, jti, exp } = newSession(phoneHash);
    const prev = activeSessions.replace(phoneHash, jti, exp);
    if (prev) revokeToken(prev); // {jti, exp} — logout ile aynı yol

    // Hak uzlaştırması — girişte RevenueCat'e GERÇEK durumu sor.
    //
    // Webhook tek başına yetmiyor: kullanıcı uygulamayı silip kurunca hak
    // anonim kimliğe taşınıyor, tekrar giriş yapınca phoneHash'e dönüyor ve
    // RC bu geri dönüş için OLAY GÖNDERMİYOR (canlıda doğrulandı). Girişten
    // daha iyi bir uzlaştırma anı yok: kimlik tam da burada kesinleşiyor.
    //
    // Yanıtı BEKLETMİYORUZ: giriş RevenueCat'e bağımlı hale gelmemeli.
    // Hata yutulmaz, loglanır; 'bilinmiyor' durumunda satıra dokunulmaz.
    reconcileEntitlement(phoneHash, request.log);

    return reply.send({ token, phoneHash });
  });

  // POST /api/logout — mevcut token'ı iptal eder (B7 revocation).
  // Header: Authorization: Bearer <token>
  fastify.post('/logout', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    revokeToken(claims);
    // Aktif oturum kaydını da düş — yoksa bir sonraki girişte ZATEN iptal
    // edilmiş bir jti yeniden iptal listesine yazılırdı (zararsız ama kirli).
    activeSessions.clear(claims.sub);
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
