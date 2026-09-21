#!/usr/bin/env python3
"""MAĞAZA NÖBETÇİSİ — yeni yorum gelince Telegram'a haber verir.

    python3 rytex_storewatch.py [--dry] [--selftest]

TEK İŞİ VAR: yorum kaçırmamak (kullanıcı kararı 2026-09-21 — "gerçek ihtiyaç
yorumları kaçırmamak"). Yıldız takibi BİLEREK ÇIKARILDI: yıldız-only puandan
düzeltilecek bilgi çıkmıyor (sayının oynadığını görürsün, sebebini göremezsin)
ve Apple puanı global vermediği için storefront başına taranması gerekiyordu —
taşıdığı bilgiye göre pahalı bir karmaşıklıktı. Kullanıcı yıldızları kendisi
izliyor.

DB nöbetçisinden (rytex_dbwatch.py) AYRI betik, bilinçli: o betik yedek alıp
Fly'a bağlanıyor ve dakikalarca sürebiliyor; bu tur saniyeler sürüyor ve onun
hatasından etkilenmemeli. Ortak olan yalnız .env ve state dizini.

⚠️ SESSİZLİK İKİ ANLAMA GELMESİN: bu betik yorum yokken hiç mesaj atmıyor,
öldüğünde de sessiz olurdu. Her koşuda `last_run` damgası yazılıyor; DB
nöbetçisi onu okuyup bayatladıysa SORUN olarak bildiriyor.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

BACKUP_DIR = Path(os.environ.get("RYTEX_BACKUP_DIR", "~/rytex-backups")).expanduser()
STATE = BACKUP_DIR / "storewatch-state.json"

TG_TOKEN = os.environ.get("TG_TOKEN", "")
TG_CHAT = os.environ.get("TG_CHAT", "")

# Kapsama denetiminin saati (yerel). Günde bir kez koşar.
AUDIT_HOUR = int(os.environ.get("STOREWATCH_AUDIT_HOUR", "11"))

# ⚠️ DAR YETKİLİ ANAHTARLAR. Elimizdeki geniş anahtarlar bilerek
# KULLANILMIYOR: ASC anahtarımız sürüm yayınlayabiliyor, play-publisher.json
# AAB yükleyebiliyor — ikisini de bu makineye koymak, RevenueCat için dar
# hesap açma kararının (2026-09-20) tersi olurdu.
#   ASC : rol "Customer Support" — yorum okur/cevaplar, sürüm YAYINLAYAMAZ
#   Play: yalnız "Reply to reviews" izinli servis hesabı
# Tanımlı değilse SESSİZCE ATLANMAZ, görünür sorun olarak bildirilir.
ASC_KEY_ID = os.environ.get("ASC_REVIEW_KEY_ID", "")
ASC_ISSUER = os.environ.get("ASC_REVIEW_ISSUER", "")
ASC_KEY_FILE = os.environ.get("ASC_REVIEW_KEY_FILE", "")
PLAY_SA = os.environ.get("PLAY_REVIEW_SA", "")

ASC_B = "https://api.appstoreconnect.apple.com/v1"

# ISS'in Play sürümü YOK (Play hesabında kayıtlı tek paket: com.rytex.app).
APPS = [
    {"ad": "RYTEX", "ikon": "📱", "asc_id": "6788542298", "play": "com.rytex.app"},
    {"ad": "Space Station Alarm", "ikon": "🛰", "asc_id": "6793333020", "play": None},
]

# Kapsama denetiminde tek tek sorulan ülkeler.
# ⚠️ ÜÇ HARFLİ (alpha-3) OLMAK ZORUNDA: ASC iki harfliyi reddediyor —
# `filter[territory]=US` → HTTP 400 "'US' is not a valid filter value",
# `=USA` → 200 (2026-09-21'de ölçüldü). İlk yazımda alpha-2 kullanmıştım ve
# denetim HTTPError veriyordu; hatayı denetimin kendisi açığa çıkardı.
AUDIT_TERRITORIES = ["USA", "TUR", "GBR", "DEU", "FRA", "ESP", "ITA", "NLD",
                     "SWE", "NOR", "POL", "RUS", "UKR", "BRA", "MEX", "JPN",
                     "CAN", "AUS"]

SEEN_CAP = 500


def log(*a) -> None:
    print(datetime.now().strftime("[%H:%M:%S]"), *a, flush=True)


def telegram(text: str, dry: bool) -> None:
    if dry or not TG_TOKEN or not TG_CHAT:
        log("[telegram atlandı]")
        return
    data = urllib.parse.urlencode({
        "chat_id": TG_CHAT, "text": text, "parse_mode": "HTML",
        "disable_web_page_preview": "true"}).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def _get_json(url: str, headers: dict | None = None, timeout: int = 25) -> dict:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _asc_token() -> str:
    if not (ASC_KEY_ID and ASC_ISSUER and ASC_KEY_FILE):
        raise RuntimeError("ASC yorum anahtarı tanımsız")
    import jwt                                # noqa: PLC0415
    key = Path(ASC_KEY_FILE).expanduser().read_text()
    return jwt.encode({"iss": ASC_ISSUER, "iat": int(time.time()),
                       "exp": int(time.time()) + 900, "aud": "appstoreconnect-v1"},
                      key, algorithm="ES256", headers={"kid": ASC_KEY_ID})


def asc_reviews(asc_id: str, territory: str = "") -> list[dict]:
    """App Store yorumları. `territory` verilirse yalnız o ülke."""
    url = f"{ASC_B}/apps/{asc_id}/customerReviews?limit=50&sort=-createdDate"
    if territory:
        url += f"&filter[territory]={territory}"
    d = _get_json(url, {"Authorization": "Bearer " + _asc_token()})
    out = []
    for x in d.get("data", []):
        a = x["attributes"]
        out.append({
            "id": x["id"], "magaza": "App Store", "yildiz": a.get("rating"),
            "ulke": (a.get("territory") or "").lower(),
            "baslik": a.get("title") or "", "metin": a.get("body") or "",
            "kisi": a.get("reviewerNickname") or "",
            "tarih": (a.get("createdDate") or "")[:10]})
    return out


def play_reviews(pkg: str) -> list[dict]:
    """Play yorumları. ⚠️ Play yalnız YAKIN DÖNEM yorumlarını döndürüyor;
    saatlik yoklamada sorun değil ama makine günlerce kapalı kalırsa arada
    gelen yorum bir daha görünmeyebilir."""
    if not PLAY_SA:
        raise RuntimeError("Play yorum servis hesabı tanımsız")
    import jwt                                # noqa: PLC0415
    sa = json.loads(Path(PLAY_SA).expanduser().read_text())
    now = int(time.time())
    assertion = jwt.encode(
        {"iss": sa["client_email"],
         "scope": "https://www.googleapis.com/auth/androidpublisher",
         "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 900},
        sa["private_key"], algorithm="RS256")
    tok = json.load(urllib.request.urlopen(
        "https://oauth2.googleapis.com/token",
        urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion}).encode()))["access_token"]
    d = _get_json(
        "https://androidpublisher.googleapis.com/androidpublisher/v3/"
        f"applications/{pkg}/reviews?maxResults=50",
        {"Authorization": "Bearer " + tok})
    out = []
    for r in d.get("reviews", []):
        c = (r.get("comments") or [{}])[0].get("userComment", {})
        ts = c.get("lastModified", {}).get("seconds")
        out.append({
            "id": r.get("reviewId"), "magaza": "Play",
            "yildiz": c.get("starRating"),
            "ulke": (c.get("reviewerLanguage") or "").lower(),
            "baslik": "", "metin": c.get("text") or "",
            "kisi": r.get("authorName") or "",
            "tarih": datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d") if ts else ""})
    return out


def yorum_blogu(r: dict) -> list[str]:
    """Tek yorumun gövdesi. Metin kırpılıyor — Telegram sınırı 4096."""
    n = int(r["yildiz"] or 0)
    bas = f"  {'★' * n}{'☆' * (5 - n)} <b>{n}</b> · {r['magaza']}"
    if r["ulke"]:
        bas += f" · {r['ulke'].upper()}"
    if r["tarih"]:
        bas += f" · {r['tarih']}"
    satir = [bas]
    if r["baslik"]:
        satir.append(f"  <b>{html.escape(r['baslik'][:120])}</b>")
    if r["metin"]:
        m = r["metin"][:600] + ("…" if len(r["metin"]) > 600 else "")
        satir.append(f"  {html.escape(m)}")
    if r["kisi"]:
        satir.append(f"  <i>— {html.escape(r['kisi'][:40])}</i>")
    return satir


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--selftest", action="store_true",
                    help="sahte yorum enjekte et (dişi testi)")
    args = ap.parse_args()

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    st = {}
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text())
        except Exception:                     # noqa: BLE001
            log("UYARI: state okunamadı, sıfırlandı")

    simdi = datetime.now()
    denetim = (simdi.hour == AUDIT_HOUR
               and st.get("last_audit") != simdi.strftime("%Y-%m-%d"))
    gorulen = set(st.get("seen_reviews", []))
    sorunlar: list[str] = []
    govde: list[str] = []
    toplam_yeni = 0

    for app in APPS:
        yeni: list[dict] = []
        try:
            for r in asc_reviews(app["asc_id"]):
                if r["id"] and f"as:{r['id']}" not in gorulen:
                    yeni.append(r)
        except Exception as e:                # noqa: BLE001
            sorunlar.append(f"{app['ad']}: App Store yorumları okunamadı — "
                            f"{type(e).__name__}: {str(e)[:100]}")
        if app["play"]:
            try:
                for r in play_reviews(app["play"]):
                    if r["id"] and f"play:{r['id']}" not in gorulen:
                        yeni.append(r)
            except Exception as e:            # noqa: BLE001
                sorunlar.append(f"{app['ad']}: Play yorumları okunamadı — "
                                f"{type(e).__name__}: {str(e)[:100]}")

        # 🔴 KAPSAMA DENETİMİ — GÜNDE BİR KEZ.
        # Filtresiz `customerReviews` çağrısının TÜM ülkeleri döndürdüğü bir
        # VARSAYIM; sıfır yorum olduğu için kanıtlanamadı. Varsayım yanlışsa
        # nöbetçi sessizce yorum kaçırır — yani tek işini yapmaz. Bu yüzden
        # günde bir kez ülke ülke de çekip filtresiz sonuçla karşılaştırıyoruz.
        if denetim and not args.selftest:
            try:
                genis = {r["id"] for r in asc_reviews(app["asc_id"])}
                kacan = []
                for cc in AUDIT_TERRITORIES:
                    for r in asc_reviews(app["asc_id"], cc):
                        if r["id"] not in genis:
                            kacan.append(f"{cc}:{r['id'][:8]}")
                    time.sleep(0.15)
                if kacan:
                    sorunlar.append(
                        f"{app['ad']}: filtresiz yorum çağrısı {len(kacan)} yorumu "
                        f"KAÇIRIYOR ({', '.join(kacan[:3])}) — ülke ülke çekilmeli")
            except Exception as e:            # noqa: BLE001
                sorunlar.append(f"{app['ad']}: kapsama denetimi koşamadı — "
                                f"{type(e).__name__}")

        if args.selftest and app["ad"] == "RYTEX":
            yeni.append({"id": "SELFTEST", "magaza": "App Store", "yildiz": 2,
                         "ulke": "de", "baslik": "Dişi testi",
                         "metin": "Sahte yorum; mesaj yolunun çalıştığını kanıtlar.",
                         "kisi": "selftest", "tarih": simdi.strftime("%Y-%m-%d")})

        if yeni:
            govde.append(f"{app['ikon']} <b>{app['ad']}</b>")
            for r in yeni:
                govde += yorum_blogu(r) + [""]
                if r["id"] != "SELFTEST":
                    gorulen.add(("play:" if r["magaza"] == "Play" else "as:") + r["id"])
            toplam_yeni += len(yeni)

    # ⚠️ AYNI SORUN SAAT BAŞI TEKRARLANMAZ. Anahtarlar tanımsızken her koşu
    # aynı şeyi söylerdi = günde 24 mesaj, gerçek haberi öldürür. İmza sorunun
    # TÜRÜNDEN çıkar, metninden değil (rakamlar maskeli).
    sig = "|".join(sorted(re.sub(r"\d+", "#", x) for x in sorunlar))
    tekrar = bool(sorunlar) and sig == st.get("problem_sig", "")

    if toplam_yeni or (sorunlar and not tekrar):
        bas = (f"💬 YENİ YORUM ({toplam_yeni})" if toplam_yeni
               else "🔴 MAĞAZA NÖBETÇİSİ — SORUN")
        mesaj = [bas, simdi.strftime("%d.%m.%Y %H:%M"), ""]
        if sorunlar:
            mesaj += ["<b>Sorunlar</b>"] + [f"• {s}" for s in sorunlar] + [""]
        mesaj += govde
        metin = "\n".join(mesaj)[:4000]
        telegram(metin, args.dry)
        print(metin)
    else:
        log("yeni yorum yok, sessiz")

    if not args.selftest:
        # Yıldız takibi kaldırıldı — eski state'te kalan alan ölü veri, temizle.
        st.pop("stars", None)
        st.pop("last_daily", None)
        st["problem_sig"] = sig
        st["seen_reviews"] = sorted(gorulen)[-SEEN_CAP:]
        # Kalp atışı: bu betik yorum yokken hiç mesaj atmıyor, ölünce de
        # sessiz olurdu. DB nöbetçisi bu damgayı okuyup bayatlarsa bildirir.
        st["last_run"] = simdi.isoformat(timespec="seconds")
        if denetim:
            st["last_audit"] = simdi.strftime("%Y-%m-%d")
        STATE.write_text(json.dumps(st, indent=1))
    return 1 if sorunlar else 0


if __name__ == "__main__":
    raise SystemExit(main())
