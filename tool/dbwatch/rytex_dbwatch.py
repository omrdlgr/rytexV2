#!/usr/bin/env python3
"""RYTEX veritabanı nöbetçisi — günlük sağlık kontrolü + dış yedek.

NEDEN VAR
---------
Üretim verisi Fly'da TEK MAKİNEDE, TEK SQLite dosyasında duruyor; volume
tek makineye bağlanabildiği için yatay kopya yok. Fly günlük snapshot
alıyor ama saklama süresi **5 gün** ve snapshot'lar aynı sağlayıcıda.
İki boşluk kalıyor:

  1. Sessiz bozulma 5 günden geç fark edilirse TÜM snapshot'lar bozuk
     kopyayı taşır.
  2. Fly hesabına erişim kaybedilirse yedek de gider.

Bu betik ikisini de kapatır: her gün dışarıya tutarlı bir kopya çeker,
UZUN saklar (günlük 30, haftalık 52) ve düne göre sapma arar.

FLY'DA DEĞİL, EVDE ÇALIŞIR. Fly'ın içinde çalışan bir nöbetçi, Fly
düştüğünde birlikte düşer.

İKİ TUZAK (ölçülerek bulundu, 2026-08-22)
-----------------------------------------
1. DOSYAYI KOPYALAMAK YETMEZ. WAL modunda yazımlar önce `-wal` dosyasına
   gider; `rytex.db` 86 KB iken tutarlı kopya 118 KB çıktı — aradaki
   32 KB düz kopyada KAYBOLURDU. Bu yüzden sunucuda `VACUUM INTO`
   çalıştırılıp o dosya çekiliyor. Kilitlemez, okuyucuyu engellemez.

2. SALT OKUMA KONTROLÜ YETMEZ. `integrity_check` bozulmayı görür ama
   "disk doldu / mount salt-okunur" durumunu görmez. Bu yüzden ayrı bir
   `health_canary` tablosuna yazılıp GERİ OKUNUYOR. Kullanıcı verisine
   dokunmaz; tablo bu betiğe ait, uygulama şemasına karışmasın diye
   burada yaratılıyor.

Çalıştır:  python3 rytex_dbwatch.py          (systemd timer günlük tetikler)
           python3 rytex_dbwatch.py --dry    (Telegram'a yazmaz)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

APP = os.environ.get("FLY_APP", "rytex-backend")
VOLUME = os.environ.get("FLY_VOLUME", "")
BACKUP_DIR = Path(os.environ.get("RYTEX_BACKUP_DIR", "~/rytex-backups")).expanduser()
STATE = BACKUP_DIR / "state.json"
REMOTE_DB = "/data/rytex.db"
REMOTE_TMP = "/data/_dbwatch.db"

TG_TOKEN = os.environ.get("TG_TOKEN", "")
TG_CHAT = os.environ.get("TG_CHAT", "")
# Doldurulursa yedek `age` ile şifrelenir. İçerikte ham sağlık verisi YOK
# (bloblar uçtan uca şifreli) ama phoneHash'ler ve partnerlik grafiği var.
AGE_RECIPIENT = os.environ.get("RYTEX_AGE_RECIPIENT", "")

DAILY_KEEP = 30
WEEKLY_KEEP = 52
SNAPSHOT_MAX_AGE_H = 26          # günlükte 24 saat + gecikme payı

# Düşmesi BEKLENMEYEN tablolar. users hesap silmeyle düşebilir ama sıçrama
# şüphelidir; sparks/shares kullanıcı eylemiyle düşer, alarm üretmez.
WATCHED = ["users", "partnerships", "entitlements", "public_keys"]
COUNTED = WATCHED + ["sparks", "shares", "partner_requests", "push_tokens"]


def sh(args: list[str], timeout: int = 180) -> str:
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:3])}… çıkış {r.returncode}: "
                           f"{(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


# ── 1. Sunucu tarafı: kanarya + hızlı kontrol + tutarlı kopya ───────────
# TEK SATIR ve YALNIZ TEK TIRNAK — bilerek (2026-08-22).
# `fly ssh console -C` verilen komutu uzak kabuktan geçiriyor; çok satırlı
# metinde `\n` kaçışları yolda düşüp `nconst ...` gibi bozuk kod üretti.
# Çift tırnak da aynı katmanlarda yeniyor, o yüzden VACUUM INTO'nun tırnağı
# String.fromCharCode(39) ile kuruluyor.
_Q = "String.fromCharCode(39)"
NODE = (
    "const D=require('better-sqlite3'); const fs=require('fs'); "
    "const db=new D('%(db)s'); "
    "db.exec('CREATE TABLE IF NOT EXISTS health_canary (id INTEGER PRIMARY KEY"
    " CHECK (id=1), token TEXT NOT NULL, written_at INTEGER NOT NULL)'); "
    "const tok='%(tok)s'; "
    "db.prepare('INSERT INTO health_canary (id,token,written_at) VALUES (1,?,?)"
    " ON CONFLICT(id) DO UPDATE SET token=excluded.token,"
    " written_at=excluded.written_at').run(tok, Date.now()); "
    "const back=db.prepare('SELECT token FROM health_canary WHERE id=1').get(); "
    "console.log('CANARY='+(back && back.token===tok)); "
    "console.log('QUICK='+db.pragma('quick_check',{simple:true})); "
    "try{fs.unlinkSync('%(tmp)s')}catch(e){} "
    "db.exec('VACUUM INTO ' + " + _Q + " + '%(tmp)s' + " + _Q + "); "
    "console.log('BYTES='+fs.statSync('%(tmp)s').size);"
)


def remote_step(token: str) -> dict:
    script = NODE % {"db": REMOTE_DB, "tmp": REMOTE_TMP, "tok": token}
    out = sh(["fly", "ssh", "console", "--app", APP, "-C",
              "node -e " + json.dumps(script)])
    got = {}
    for line in out.splitlines():
        if "=" in line and line.split("=", 1)[0] in ("CANARY", "QUICK", "BYTES"):
            k, v = line.strip().split("=", 1)
            got[k] = v
    for k in ("CANARY", "QUICK", "BYTES"):
        if k not in got:
            raise RuntimeError(f"sunucu adımı {k} döndürmedi: {out[-200:]}")
    return got


def fetch(dest: Path) -> Path:
    """Önce `.part`'a indirir; doğrulama geçince çağıran taraf yerine koyar.

    İKİ SEBEP: (1) `fly ssh sftp get` VAR OLAN DOSYANIN ÜSTÜNE YAZMIYOR —
    aynı gün ikinci çalıştırma "already there" ile patlıyordu. (2) Yarım
    inen dosya "bugünün yedeği" diye durmasın; doğrulanmadan adı almaz.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    part.unlink(missing_ok=True)
    try:
        sh(["fly", "ssh", "sftp", "get", REMOTE_TMP, str(part), "--app", APP])
    finally:
        # Sunucudaki geçici dosya HER durumda silinir, indirme patlasa bile;
        # yoksa volume'de birikir.
        try:
            sh(["fly", "ssh", "console", "--app", APP, "-C",
                f"rm -f {REMOTE_TMP}"], timeout=90)
        except RuntimeError:
            pass
    return part


# ── 2. Yerel doğrulama ─────────────────────────────────────────────────
def verify(path: Path) -> tuple[str, dict]:
    """Tam integrity_check yerelde koşulur — DB küçük, sunucuyu meşgul etme."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        counts = {}
        for t in COUNTED:
            try:
                counts[t] = con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            except sqlite3.Error:
                counts[t] = None      # tablo yok — şema değişmiş olabilir
        return integrity, counts
    finally:
        con.close()


def drift(now: dict, prev: dict | None) -> list[str]:
    """Düne göre sapma. Bekleyeni değil, BEKLENMEYENİ arar: izlenen
    tabloların satır sayısı düşerse veri kaybı şüphesi vardır."""
    if not prev:
        return []
    out = []
    for t in WATCHED:
        a, b = prev.get(t), now.get(t)
        if isinstance(a, int) and isinstance(b, int) and b < a:
            out.append(f"{t}: {a} → {b} (DÜŞTÜ)")
    if now.get("users") is None:
        out.append("users tablosu okunamadı — şema bozulmuş olabilir")
    return out


# ── 3. Fly snapshot tazeliği ───────────────────────────────────────────
def snapshot_age_hours() -> float | None:
    vol = VOLUME
    if not vol:
        out = sh(["fly", "volumes", "list", "--app", APP, "--json"])
        vols = json.loads(out)
        if not vols:
            return None
        vol = vols[0]["id"]
    snaps = json.loads(sh(["fly", "volumes", "snapshots", "list", vol,
                           "--app", APP, "--json"]))
    if not snaps:
        return None
    newest = max(s["created_at"] for s in snaps)
    ts = datetime.fromisoformat(newest.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - ts).total_seconds() / 3600


# ── 4. Saklama ─────────────────────────────────────────────────────────
def retain() -> int:
    """Günlük 30, haftalık (pazartesi) 52. Fly'ın 5 günü yalnız felaket
    kurtarması içindir; sessiz bozulmaya karşı koruma BU uzun arşiv."""
    files = sorted(BACKUP_DIR.glob("rytex-*.db*"))
    keep: set[Path] = set(files[-DAILY_KEEP:])
    weekly = [f for f in files if _date_of(f) and _date_of(f).weekday() == 0]
    keep |= set(weekly[-WEEKLY_KEEP:])
    removed = 0
    for f in files:
        if f not in keep:
            f.unlink()
            removed += 1
    return removed


def _date_of(p: Path):
    try:
        return datetime.strptime(p.name.split("-", 1)[1][:10], "%Y-%m-%d")
    except (ValueError, IndexError):
        return None


def encrypt(path: Path) -> Path:
    if not AGE_RECIPIENT or not shutil.which("age"):
        return path
    enc = path.with_suffix(path.suffix + ".age")
    sh(["age", "-r", AGE_RECIPIENT, "-o", str(enc), str(path)])
    path.unlink()
    return enc


# ── 5. Rapor ───────────────────────────────────────────────────────────
def telegram(text: str, dry: bool) -> None:
    if dry or not TG_TOKEN or not TG_CHAT:
        print("[telegram atlandı]\n" + text)
        return
    data = urllib.parse.urlencode({
        "chat_id": TG_CHAT, "text": text, "parse_mode": "HTML",
        "disable_web_page_preview": "true"}).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="Telegram'a yazma")
    args = ap.parse_args()

    started = datetime.now(timezone.utc)
    day = started.strftime("%Y-%m-%d")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []
    lines: list[str] = []

    try:
        token = os.urandom(8).hex()
        r = remote_step(token)
        if r["CANARY"] != "true":
            problems.append("KANARYA: yazılan değer geri okunamadı")
        if r["QUICK"] != "ok":
            problems.append(f"QUICK_CHECK: {r['QUICK']}")

        dest = BACKUP_DIR / f"rytex-{day}.db"
        part = fetch(dest)
        size = part.stat().st_size
        if size != int(r["BYTES"]):
            problems.append(f"BOYUT UYUŞMUYOR: sunucu {r['BYTES']}, yerel {size}")

        integrity, counts = verify(part)
        if integrity != "ok":
            problems.append(f"INTEGRITY: {integrity[:120]}")
        # Doğrulama bitti — ancak şimdi "bugünün yedeği" adını alır.
        dest.unlink(missing_ok=True)
        part.replace(dest)

        prev = json.loads(STATE.read_text())["counts"] if STATE.exists() else None
        problems += drift(counts, prev)

        age_h = snapshot_age_hours()
        if age_h is None:
            problems.append("Fly snapshot BULUNAMADI")
        elif age_h > SNAPSHOT_MAX_AGE_H:
            problems.append(f"Fly snapshot bayat: {age_h:.0f} saat")

        final = encrypt(dest)
        removed = retain()
        STATE.write_text(json.dumps(
            {"at": started.isoformat(), "counts": counts}, indent=1))

        lines.append(f"kayıt: {', '.join(f'{k} {v}' for k, v in counts.items() if v)}")
        lines.append(f"yedek: {final.name} · {size / 1024:.0f} KB"
                     + (" · şifreli" if final.suffix == ".age" else ""))
        lines.append(f"snapshot: {age_h:.0f} sa önce" if age_h is not None else "snapshot: yok")
        lines.append(f"arşiv: {len(list(BACKUP_DIR.glob('rytex-*.db*')))} dosya"
                     + (f" (-{removed})" if removed else ""))
    except Exception as e:                                  # noqa: BLE001
        problems.append(f"ÇALIŞMA HATASI: {type(e).__name__}: {e}")

    ok = not problems
    head = "✅ RYTEX DB nöbeti temiz" if ok else "🔴 RYTEX DB nöbeti — SORUN"
    body = [head, started.strftime("%d.%m.%Y %H:%M UTC"), ""]
    if problems:
        body += ["<b>Sorunlar</b>"] + [f"• {p}" for p in problems] + [""]
    body += lines
    telegram("\n".join(body), args.dry)
    print("\n".join(body))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
