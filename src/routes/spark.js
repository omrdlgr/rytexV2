import { sparks, partnerships } from '../db.js';
import { authenticateRequest } from '../token.js';
import { notifyUser } from './push.js';

// SPARK — mahremiyet isteği. Uçtan uca şifreli; sunucu içeriği OKUYAMAZ.
// Yalnız partner çiftleri arasında. Romantik-kova kuralı istemci tarafında
// (rol bilgisi sunucuda yok); sunucu yalnız partnership'i doğrular.
const ALLOWED_STATUS = ['accepted', 'not_today', 'suggest', 'maybe'];

export default async function sparkRoutes(fastify) {
  // SPARK gönder. POST /api/spark  Body: { to, blob }
  fastify.post('/spark', {
    // KENDI BUTCESI (2026-08-21). Rota bazli limit ayri sayacta tutulur,
    // yani ucuz GET yagmuru genel butceyi bitirse bile KULLANICININ BASLATTIGI
    // bu eylem 429 yemez. Saha vakasinda tam tersi olmustu: /keys istekleri
    // butceyi yiyor, sonra SPARK gonderimi ve cevabi reddediliyordu.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['to', 'blob'],
        properties: {
          to: { type: 'string', minLength: 8 },
          blob: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const { to, blob } = request.body;
    if (to === claims.sub) {
      return reply.code(400).send({ error: 'cannot_spark_self' });
    }
    if (!partnerships.isPartner(claims.sub, to)) {
      return reply.code(403).send({ error: 'not_partner' });
    }
    // BEKLEYEN-SPARK KAPISI (kullanıcı kararı 2026-09-07). Aynı kişiye,
    // cevap gelmeden ikinci SPARK gönderilemez.
    //
    // NEDEN SUNUCUDA: bu bir KÖTÜYE KULLANIM kapısı, istemci kapısı aşılabilir
    // (uç doğrudan çağrılabilir, eski sürümler kapıyı hiç bilmiyor). Bugüne
    // kadar tek fren dakikada 30'luk rate limit'ti — yani bir partner
    // DAKİKADA 30 bildirim ürettirebiliyordu. İki kişilik mahrem bir bağlamda
    // bu yalnız "spam" değil, taciz/baskı yüzeyi.
    //
    // Kapı en fazla TTL kadar (7 gün) kapalı kalır: cevapsız kayıt o süre
    // dolunca silinir ve yeni gönderim yeniden açılır.
    if (sparks.hasPendingTo(claims.sub, to)) {
      return reply.code(409).send({ error: 'spark_pending' });
    }
    const id = sparks.create(claims.sub, to, blob);
    // Alıcıya gizli push (jenerik metin, içeriksiz). Sonuç gönderene döner —
    // UI dürüst beklenti kurar ("bildirim yollandı" / "app'i açınca görecek").
    // notifyUser asla fırlatmaz; push hatası SPARK'ın kendisini etkilemez.
    const pushed = await notifyUser(to);
    return reply.code(201).send({ id, pushed });
  });

  // Bana ait SPARK'lar (gönderdiğim + aldığım). GET /api/sparks
  // Liste her app acilisinda + her gonderim/cevap sonrasi cekiliyor; kendi
  // butcesi olsun ki genel butce dolunca liste BOSALMASIN.
  fastify.get('/sparks', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    // Tembel temizlik: TTL'i dolan kayıtlar CEVAPLANMIŞ OLSUN OLMASIN silinir
    // (kullanıcı kararı 2026-09-07). Manuel silme kaldırıldığı için liste
    // temizliğini zaman yapıyor. Satır bazlı — 5 günlük kayıt durur.
    sparks.purgeStale();
    const list = sparks.forUser(claims.sub);
    // Bana GELEN'ler bu indirmede cihaza ulaşmış oldu → damgala. Cevap bu
    // isteğin listesinden SONRA damgalanır: gönderen 'ulaştı'yı bir sonraki
    // yenilemede görür (alıcı kendi ilk listesinde damgasız görür, sorun değil).
    sparks.markDelivered(claims.sub);
    return reply.send({ sparks: list });
  });

  // SPARK'a cevap ver (yalnız ALICI). POST /api/spark/respond
  // Body: { id, status, blob? }  status: accepted|not_today|suggest|maybe
  fastify.post('/spark/respond', {
    // Kendi butcesi — gerekcesi POST /spark'ta.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: ALLOWED_STATUS },
          blob: { type: 'string', maxLength: 4096 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const { id, status, blob } = request.body;
    const row = sparks.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // Yalnız isteğin ALICISI cevaplayabilir.
    if (row.to_hash !== claims.sub) {
      return reply.code(403).send({ error: 'not_recipient' });
    }
    // Süresi dolmuş isteğe cevap verilmez (istemci listeyi tazelesin).
    if (row.status === 'expired') {
      return reply.code(409).send({ error: 'expired' });
    }
    sparks.respond(id, status, blob ?? null);
    // Cevap da gönderene gizli push'la duyurulur (aynı jenerik metin).
    notifyUser(row.from_hash).catch(() => {});
    return reply.send({ status: 'ok' });
  });

  // SPARK sil — YENİ İSTEMCİDE YOK, yalnız ESKİ sürümler için duruyor.
  //
  // Manuel silme 2026-09-07'de kaldırıldı (kullanıcı: "silme karşı tarafta
  // ret gibi algılanabilir"); temizliği artık TTL yapıyor. Ama 1.2.2 sahada
  // ve o sürümde silme butonu VAR — ucu tamamen kaldırırsak o kullanıcılar
  // butona bastığında hata alır.
  //
  // 🔴 BEKLEYEN kayıt silinemez: aksi hâlde eski istemci `gönder → sil →
  // gönder` ile bekleyen-SPARK kapısını aşar ve her turda alıcıya push atar.
  // Yani bu uç artık YALNIZ bitmiş kayıtları temizler — eski istemcide
  // zaten silinmek istenen şey odur.
  // POST /api/spark/delete
  fastify.post('/spark/delete', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const row = sparks.get(request.body.id);
    if (!row) return reply.send({ status: 'ok' });
    if (row.from_hash !== claims.sub && row.to_hash !== claims.sub) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // Kapının kaçış deliğini kapatır (yukarıdaki gerekçe).
    if (row.status === 'pending') {
      return reply.code(409).send({ error: 'spark_pending' });
    }
    sparks.delete(request.body.id);
    return reply.send({ status: 'ok' });
  });
}
