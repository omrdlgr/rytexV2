// Hak uzlaştırması: RevenueCat'e sor, gerçeği veritabanına yaz.
//
// Webhook "olay geldiğinde" çalışır; bu ise "kimlik kesinleştiğinde" çalışır.
// İkisi birbirinin yerine geçmez — RC bazı geçişler için hiç olay göndermiyor
// (bkz. revenuecat_api.js başlığı).
import { entitlements } from './db.js';
import { fetchEntitlement, isConfigured } from './revenuecat_api.js';

/// Bir kimliğin hakkını RevenueCat'ten okuyup DB'ye yazar.
///
/// ASLA throw ETMEZ ve ASLA await edilmek zorunda değildir — çağıran akış
/// (giriş, webhook) RevenueCat'e bağımlı hale gelmemeli.
///
/// Dönüş: yazıldıysa yazılan nesne, yazılmadıysa null.
export async function reconcileEntitlement(customerId, log) {
  if (!isConfigured()) return null;
  if (typeof customerId !== 'string' || !customerId) return null;

  try {
    const truth = await fetchEntitlement(customerId, log);
    // null = BİLİNMİYOR. Mevcut satıra dokunma: RC'ye ulaşamadığımız için
    // ödeme yapan kullanıcının hakkını silmek en kötü sonuç olurdu.
    if (!truth) return null;

    entitlements.upsert({
      phoneHash: customerId,
      active: truth.active,
      expiresAt: truth.expiresAt,
      productId: truth.productId,
      source: truth.source,
      eventType: 'API_RECONCILE',
      environment: truth.environment,
    });
    log?.info(
      {
        customer: customerId.slice(0, 12),
        active: truth.active,
        environment: truth.environment,
      },
      'Hak RevenueCat API ile uzlastirildi',
    );
    return truth;
  } catch (err) {
    log?.warn({ err: err.message }, 'Hak uzlastirmasi basarisiz (yutuldu)');
    return null;
  }
}
