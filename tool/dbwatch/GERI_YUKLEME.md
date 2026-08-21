# Geri yükleme prosedürü

**Prova yapıldı: 2026-08-22, başarılı.** Aşağıdaki adımlar o provada
birebir çalıştırıldı; ezberden yazılmadı.

## Önce: hangi kaynaktan?

| Kaynak | Tazelik | Nerede |
|---|---|---|
| Yerel şifreli yedek | 10:00 / 21:00 | `141:~/rytex-backups/` + `AppleDev/rytexDbYedek/` |
| Fly volume snapshot | günde 1, **5 gün saklanır** | Fly |

Veri kaybı penceresi: yalnız Fly ile **24 saate kadar**, bizim yedekle **~13 saat**.

## A) Yerel yedekten (hızlı yol)

```bash
age -d -i age-key.txt rytex-YYYY-MM-DD.db.age > rytex.db
sqlite3 rytex.db "PRAGMA integrity_check;"      # 'ok' bekleniyor
fly ssh sftp shell -a rytex-backend             # put ile /data/rytex.db üzerine
```
⚠️ Yazmadan ÖNCE makineyi durdur; canlı DB'nin üstüne yazmak WAL ile çakışır.

⚠️ Anahtar kaybolursa şifreli yedek **açılamaz**. `age-key.txt` iki yerde:
`141:~/rytex-dbwatch/` ve `AppleDev/rytexDbYedek/`.

## B) Fly snapshot'tan (provası yapılan yol)

```bash
# 1. En taze snapshot
fly volumes snapshots list <VOL_ID> -a rytex-backend --json

# 2. Snapshot'tan YENİ volume (aynı uygulamada olmak ZORUNDA)
fly volumes create rytex_restore_test --snapshot-id <SNAP_ID> -r fra \
  -a rytex-backend -s 1 -n 1 -y

# 3. Geçici makine — SERVİSSİZ olmalı
fly machine run registry.fly.io/rytex-backend:<TAG> -a rytex-backend \
  --region fra --vm-memory 256 --volume <YENI_VOL>:/data \
  --restart no --name rytex-restore-drill sleep 600
```

🔴 **EN ÖNEMLİ ADIM — atlanırsa kullanıcılar eski veri görür:**

```bash
fly machine list -a rytex-backend --json | \
  python3 -c "import json,sys;[print(m['name'],len(m.get('config',{}).get('services') or [])) for m in json.load(sys.stdin)]"
```
Yeni makinede **servis sayısı 0 olmalı**. `fly machine run` fly.toml'daki
servisleri uygulamaz; 0 değilse Fly proxy'si oraya CANLI TRAFİK yollar —
derhal yok et.

```bash
# 4. Doğrula
fly ssh console -a rytex-backend --machine <YENI_ID> -C "node -e \"...integrity_check + count...\""

# 5. TEMİZLE — unutma, volume ücretli
fly machine destroy <YENI_ID> -a rytex-backend --force
fly volumes destroy <YENI_VOL> -y
```

## Provada öğrenilenler

- Snapshot **WAL dosyalarıyla** geliyor ve SQLite onları temiz kurtarıyor;
  blok seviyesi snapshot canlı SQLite için kullanılabilir. Varsayım değil,
  ölçüldü.
- `fly machine run` **digest** biçimini reddediyor
  (`invalid image identifier`); **tag** biçimi kullanılmalı.
- Geri yüklenen satır sayıları üretimle birebir tuttu.
