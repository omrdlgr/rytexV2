#!/usr/bin/env bash
# Nöbetçi sarmalayıcısı — cron bunu çağırır.
#
# NEDEN AYRI DOSYA: cron satırı env yükleme + log yönlendirme + arşivleme
# ile okunmaz hale gelmişti; tek tırnak hatası sessizce her koşuyu düşürür
# ve bunu ancak rapor gelmeyince fark ederdik.
set -u
cd "$(dirname "$0")" || exit 1

LOG=run.log
ARCH=logs
KEEP=24                      # 24 aylık arşiv

# AYLIK DÖNDÜRME: log dosyasının ayı geçmiş aya aitse sıkıştırıp arşivle,
# yenisini boş başlat. Kırpmak yerine arşivlemek: bir yıllık log ~7 MB,
# gzip'te ~500 KB. Saklamanın maliyeti yok, atmanın bedeli var — geçmişe
# bakmak gerektiğinde elde bir şey kalmıyor.
mkdir -p "$ARCH"
if [ -s "$LOG" ]; then
  M=$(date -r "$LOG" +%Y-%m)
  if [ "$M" != "$(date +%Y-%m)" ]; then
    gzip -c "$LOG" > "$ARCH/run-$M.log.gz" && : > "$LOG"
  fi
fi
ls -1t "$ARCH"/run-*.log.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

set -a
# shellcheck disable=SC1091
. ./.env
set +a
# ⚠️ TEK ÖRNEK KİLİDİ. Saha bulgusu 2026-09-21: elle koşu ile cron
# AYNI SANİYEDE çalıştı, ikisi de state'i yazılmadan önce okudu ve
# AYNI mesaj Telegram'a İKİ KEZ düştü. Susturma mantığı doğruydu,
# eksik olan kilitti. Asıl tehlike elle koşu değil: bir tur takılırsa
# bir sonraki saat üstüne biner ve yedek/state bozulabilir.
exec 9>/tmp/rytex-dbwatch.lock
if ! flock -n 9; then
  echo "$(date +%F\ %T) [atlandı: önceki DB turu hâlâ çalışıyor]" >> "$LOG"
  exit 0
fi

exec /usr/bin/python3 rytex_dbwatch.py --quiet >> "$LOG" 2>&1
