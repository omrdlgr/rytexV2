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
import re
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

RC_SECRET = os.environ.get("RC_SECRET", "")
FIREBASE_SA = os.environ.get("FIREBASE_SA", "")
FIREBASE_PROJECT = os.environ.get("FIREBASE_PROJECT", "rytex-78137")

# Ülke kodu → ad. Kod tek başına raporu okunmaz yapıyor; listede olmayan
# kod HAM haliyle basılır (yeni pazar sessizce kaybolmasın).
COUNTRY = {
    "TR": "Türkiye", "US": "ABD", "DE": "Almanya", "FR": "Fransa",
    "GB": "İngiltere", "NL": "Hollanda", "IT": "İtalya", "ES": "İspanya",
    "AZ": "Azerbaycan", "CA": "Kanada", "AU": "Avustralya", "MX": "Meksika",
    "BR": "Brezilya", "RU": "Rusya", "JP": "Japonya", "CN": "Çin",
    "PL": "Polonya", "PT": "Portekiz", "SE": "İsveç", "NO": "Norveç",
    "AT": "Avusturya", "BE": "Belçika", "CH": "İsviçre", "IE": "İrlanda",
    "NZ": "Y.Zelanda", "CY": "Kıbrıs", "TD": "Çad", "IN": "Hindistan",
    "CI": "Fildişi Sahili",          # 2026-08-28, allowlist dışı ilk kayıt
    "??": "bilinmiyor",
}


def _country(code: str) -> str:
    return COUNTRY.get(code, code)

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


# ── 2b. RC bayrağı, Firebase, gerçek satış ─────────────────────────────
def _get_json(url: str, headers: dict) -> dict:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def rc_flag() -> tuple[int, dict]:
    """RevenueCat müşterileri → ülke dağılımı.

    RC `last_seen_country` IP tabanlı; ASC storefront'a bakar. İkisi farklı
    şey ölçer ve TUTMAMASI normaldir (2026-08-19'da doğrulandı)."""
    if not RC_SECRET:
        return 0, {}
    h = {"Authorization": "Bearer " + RC_SECRET,
         "Content-Type": "application/json"}
    proj = _get_json("https://api.revenuecat.com/v2/projects", h)["items"][0]["id"]
    url = f"https://api.revenuecat.com/v2/projects/{proj}/customers?limit=100"
    items: list = []
    while url:
        d = _get_json(url, h)
        items += d["items"]
        nxt = d.get("next_page")
        url = ("https://api.revenuecat.com" + nxt) if nxt else None
    dist: dict = {}
    for i in items:
        c = i.get("last_seen_country") or "??"
        dist[c] = dist.get(c, 0) + 1
    return len(items), dist


def _google_token() -> str:
    import jwt                                            # noqa: PLC0415
    with open(FIREBASE_SA, encoding="utf-8") as f:
        sa = json.load(f)
    now = int(datetime.now(timezone.utc).timestamp())
    assertion = jwt.encode(
        {"iss": sa["client_email"],
         "scope": "https://www.googleapis.com/auth/cloud-platform",
         "aud": "https://oauth2.googleapis.com/token",
         "iat": now, "exp": now + 3600},
        sa["private_key"], algorithm="RS256")
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion}).encode()
    with urllib.request.urlopen("https://oauth2.googleapis.com/token",
                                body, timeout=45) as r:
        return json.load(r)["access_token"]


def firebase_stats() -> tuple[int, list]:
    """Telefonla GERÇEKTEN giriş yapan sayısı + SMS bölge listesi.

    Firebase Auth kullanıcısı ancak SMS doğrulaması BAŞARILI olunca yaratılır
    — yani bu sayı "SMS zinciri çalışıyor mu"nun tek doğrudan kanıtı."""
    if not FIREBASE_SA or not os.path.exists(FIREBASE_SA):
        return -1, []
    tok = _google_token()
    h = {"Authorization": "Bearer " + tok}
    users = _get_json(
        f"https://identitytoolkit.googleapis.com/v1/projects/"
        f"{FIREBASE_PROJECT}/accounts:batchGet?maxResults=500", h).get("users", [])
    cfg = _get_json(
        f"https://identitytoolkit.googleapis.com/admin/v2/projects/"
        f"{FIREBASE_PROJECT}/config", h)
    regions = (cfg.get("smsRegionConfig", {})
                  .get("allowlistOnly", {}).get("allowedRegions", []))
    return len(users), sorted(regions)


def sales(path: Path) -> tuple[int, int]:
    """GERÇEK PARA ile sandbox'ı ayırır.

    Ayrım kritik: 12 Ağustos'ta `environment` hiç okunmuyordu ve sandbox
    satın alması canlı DB'ye gerçek hak yazıyordu. Burada da sandbox'ı
    gerçek satış saymak bizi yanıltırdı."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT active, environment, source FROM entitlements").fetchall()
    except sqlite3.Error:
        return -1, -1
    finally:
        con.close()
    real = sum(1 for a, e, _ in rows
               if a and (e or "").upper() not in ("SANDBOX", ""))
    sand = sum(1 for a, e, _ in rows if a and (e or "").upper() == "SANDBOX")
    return real, sand


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
        # Metni BURADA basma: çağıran zaten basıyor, ikisi birden loga
        # raporu iki kez yazıyordu (saatlik koşuda log iki katı şişiyor).
        print("[telegram atlandı]")
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
    # Saatlik koşuda yedek HER SAAT alınır ama mesaj yalnız rapor saatinde
    # gider; aksi halde günde 24 bildirim olurdu. YENİ bir sorun saat
    # beklemez — geç fark edilen bozulma bu işin bütün amacını bozar. Ama
    # AYNI sorun tekrar bildirilmez: bir kez haber verilir, sürdüğü sürece
    # susulur, planlı raporda yeniden görünür.
    ap.add_argument("--quiet", action="store_true",
                    help="yalnız rapor saatinde veya YENİ sorun çıkınca gönder")
    args = ap.parse_args()

    started = datetime.now(timezone.utc)
    day = started.strftime("%Y-%m-%d")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []
    lines: list[str] = []

    # Önceki koşunun sorun imzası BURADA okunur, aşağıdaki tam state
    # yazımından ÖNCE — o yazım aynı dosyayı ezip imzayı siliyor.
    prev_sig = ""
    if STATE.exists():
        try:
            prev_sig = json.loads(STATE.read_text()).get("problem_sig", "")
        except Exception:                                   # noqa: BLE001
            pass                       # bozuk state = imza yok = bir kez bildir

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

        # Gerçek satış YEDEKTEN okunur — ek API yok, veri zaten elimizde.
        real, sand = sales(dest)

        prev_state = json.loads(STATE.read_text()) if STATE.exists() else {}
        rc_total, rc_dist = 0, {}
        fb_users, regions = -1, []
        try:
            rc_total, rc_dist = rc_flag()
        except Exception as e:                              # noqa: BLE001
            problems.append(f"RC okunamadı: {type(e).__name__}")
        try:
            fb_users, regions = firebase_stats()
        except Exception as e:                              # noqa: BLE001
            problems.append(f"Firebase okunamadı: {type(e).__name__}")

        outside = [c for c in rc_dist if c not in regions and c != "??"] \
            if regions else []
        if outside:
            problems.append("allowlist DIŞINDA trafik: "
                            + ", ".join(_country(c) for c in outside))

        final = encrypt(dest)
        removed = retain()
        STATE.write_text(json.dumps(
            {"at": started.isoformat(), "counts": counts, "rc": rc_total,
             "fb": fb_users, "real": real}, indent=1))

        def delta(key, now_val):
            old_val = prev_state.get(key)
            if not isinstance(old_val, int) or not isinstance(now_val, int):
                return ""
            d = now_val - old_val
            return f" (+{d})" if d > 0 else (f" ({d})" if d < 0 else "")

        # DÜZ SATIR, tablo değil (kullanıcı kararı 2026-08-22): Telegram
        # <pre> bloğunun üstüne kopyala ikonu bindirip sayıyı okunmaz
        # yapıyordu. Sıfır satır gizlenmez — "0 oldu" bilgisi de bilgidir.
        for k, v in counts.items():
            if v is not None:
                lines.append(f"{k}: {v}")
        lines.append(f"yedek: {final.name} · {size / 1024:.0f} KB"
                     + (" · şifreli" if final.suffix == ".age" else ""))
        lines.append(f"snapshot: {age_h:.0f} sa önce" if age_h is not None
                     else "snapshot: yok")
        lines.append(f"arşiv: {len(list(BACKUP_DIR.glob('rytex-*.db*')))} dosya"
                     + (f" (-{removed})" if removed else ""))
        if rc_total:
            top = sorted(rc_dist.items(), key=lambda x: -x[1])
            lines.append("")
            lines.append(f"🚩 RC {rc_total} müşteri{delta('rc', rc_total)}")
            for c, n in top:
                lines.append(f"{_country(c)}: {n}")
            lines.append(f"allowlist dışında: {len(outside)}")
        if real >= 0:
            # Sandbox raporda YOK (kullanıcı kararı 2026-08-22): gerçek para
            # sorusu soruluyor, sandbox o soruyu bulandırıyor. Ayrım kodda
            # duruyor, yalnız gösterilmiyor.
            lines.append(f"💳 gerçek satış: {real}{delta('real', real)}")
        if fb_users >= 0:
            lines.append(f"📱 telefonla giriş: {fb_users}{delta('fb', fb_users)}"
                         f" · SMS bölge: {len(regions)} ülke")
    except Exception as e:                                  # noqa: BLE001
        problems.append(f"ÇALIŞMA HATASI: {type(e).__name__}: {e}")

    ok = not problems
    head = "✅ RYTEX raporu" if ok else "🔴 RYTEX raporu — SORUN"
    # Yerel saat: makine Europe/Istanbul, rapor da o saatle okunuyor.
    body = [head, started.astimezone().strftime("%d.%m.%Y %H:%M"), ""]
    if problems:
        body += ["<b>Sorunlar</b>"] + [f"• {p}" for p in problems] + [""]
    body += lines
    hours = [int(h) for h in
             os.environ.get("REPORT_HOURS", "10,21").split(",") if h.strip()]
    scheduled = started.astimezone().hour in hours

    # AYNI SORUN SAAT BAŞI TEKRARLANMAZ (kullanıcı kararı 2026-09-06): sorun
    # ilk görüldüğünde bir kez bildirilir, sürdüğü sürece susulur, planlı
    # 10:00/21:00 raporunda zaten yeniden görünür.
    # İMZA SORUNUN TÜRÜNDEN ÇIKAR, METNİNDEN DEĞİL: "snapshot bayat: 8 saat"
    # bir sonraki saat "9 saat" olur, drift de "users: 9 → 8" üretir — ham
    # metin karşılaştırması her koşuda "yeni sorun" der ve susturma hiç
    # çalışmazdı. Rakamlar # ile değiştirilir, böylece yalnız sorun KÜMESİ
    # değişince (yeni kalem eklenince, allowlist listesine ülke girince)
    # yeniden bildirilir.
    sig = "|".join(sorted(re.sub(r"\d+", "#", p) for p in problems))
    repeat = bool(problems) and sig == prev_sig
    mute = args.quiet and not scheduled and (ok or repeat)
    # "Mesaj neden gelmedi" sorusunun cevabı log'da yazsın — susturma
    # eklendikten sonra sessizlik iki farklı şey demek oluyor.
    if mute:
        print("[susturuldu: " + ("sorun yok" if ok else "aynı sorun sürüyor")
              + "]")
    telegram("\n".join(body), args.dry or mute)
    print("\n".join(body))

    # İMZAYI YAZ — try'ın DIŞINDA olmak ZORUNDA: çalışma hatası da bir
    # sorundur ve o hata sürerken de susulmalı, oysa yukarıdaki tam state
    # yazımı hataya takılınca hiç çalışmıyor.
    st: dict = {}
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text())
        except Exception:                                   # noqa: BLE001
            st = {}
    st["problem_sig"] = sig
    STATE.write_text(json.dumps(st, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
