#!/usr/bin/env bash
# Mağaza nöbetçisi sarmalayıcısı — cron bunu çağırır.
#
# DB nöbetçisinden AYRI cron satırı ve AYRI log, bilinçli: o betik yedek alıp
# Fly'a bağlanıyor ve dakikalarca sürebiliyor; biri diğerini bekletmemeli.
# Saat :30'da koşuyor — :00'daki DB turuyla çakışmasın, iki mesaj aynı dakikada
# düşerse biri gözden kaçıyor.
set -u
cd "$(dirname "$0")" || exit 1

LOG=store.log
ARCH=logs
KEEP=12

mkdir -p "$ARCH"
if [ -s "$LOG" ]; then
  M=$(date -r "$LOG" +%Y-%m)
  if [ "$M" != "$(date +%Y-%m)" ]; then
    gzip -c "$LOG" > "$ARCH/store-$M.log.gz" && : > "$LOG"
  fi
fi
ls -1t "$ARCH"/store-*.log.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

set -a
# shellcheck disable=SC1091
. ./.env
set +a

exec /usr/bin/python3 rytex_storewatch.py >> "$LOG" 2>&1
