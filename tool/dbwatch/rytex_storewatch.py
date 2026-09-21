#!/usr/bin/env python3
"""MAĞAZA NÖBETÇİSİ — yeni yorum ve yıldız geldiğinde Telegram'a haber verir.

    python3 rytex_storewatch.py [--dry] [--selftest]

DB nöbetçisinden (`rytex_dbwatch.py`) AYRI bir betik, bilinçli: o betik yedek
alıyor, Fly'a bağlanıyor ve dakikalarca sürebiliyor; mağaza yoklaması ise
saniyeler sürüyor ve onun hatasından etkilenmemeli. Ortak olan yalnız `.env`
(aynı Telegram botu) ve yedek dizini (state dosyası).

────────────────────────────────────────────────────────────────────────────
🔴 EN ÖNEMLİ BULGU (2026-09-21'de ölçüldü): YILDIZ ve YORUM AYRI KAYNAKTA.

ASC'nin `customerReviews` ucu **yıldız-only puanları HİÇ döndürmüyor**.
8 Eylül'de RYTEX'e 5 yıldız gelmişti ve o uç `total: 0` diyordu — yalnız ona
bakan bir nöbetçi "puan yok" der ve o puanı asla görmezdi. Yıldızlar açık
`itunes.apple.com/lookup` ucundan geliyor ve orada gerçekten görünüyor
(RYTEX `tr`: ort 5.0, n=1).

⚠️ VE YILDIZLAR STOREFRONT BAZINDA: aynı anda `us` 0, `tr` 5.0 diyor. Tek
ülkeye bakan nöbetçi kördür. Bu yüzden ülke listesi üzerinden dönülüyor.
────────────────────────────────────────────────────────────────────────────

NE ZAMAN MESAJ GİDER:
  • yeni yorum (App Store metinli / Play) → ANINDA
  • yıldız sayısı ya da ortalaması değişti  → ANINDA
  • günde bir kez → yıldız raporu (değişiklik olmasa da)
Hiçbiri yoksa SESSİZ. Gürültü, gerçek haberi öldürür.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

BACKUP_DIR = Path(os.environ.get("RYTEX_BACKUP_DIR", "~/rytex-backups")).expanduser()
STATE = BACKUP_DIR / "storewatch-state.json"

TG_TOKEN = os.environ.get("TG_TOKEN", "")
TG_CHAT = os.environ.get("TG_CHAT", "")

# Günlük yıldız raporunun saati (yerel). DB nöbetçisiyle aynı saate denk
# gelmesin diye 11; ikisi aynı dakikada iki mesaj atarsa biri gözden kaçıyor.
DAILY_HOUR = int(os.environ.get("STOREWATCH_DAILY_HOUR", "11"))

# ⚠️ DAR YETKİLİ ANAHTARLAR (bkz. dosya başındaki güvenlik notu).
# ASC: "Customer Support" rolü yorumları okumaya YETER ve sürüm yayınlayamaz.
# Play: yalnız "Reply to reviews" izinli ayrı servis hesabı.
# Tanımlı değilse SESSİZCE ATLANMAZ — sorun olarak bildirilir.
ASC_KEY_ID = os.environ.get("ASC_REVIEW_KEY_ID", "")
ASC_ISSUER = os.environ.get("ASC_REVIEW_ISSUER", "")
ASC_KEY_FILE = os.environ.get("ASC_REVIEW_KEY_FILE", "")
PLAY_SA = os.environ.get("PLAY_REVIEW_SA", "")

ASC_B = "https://api.appstoreconnect.apple.com/v1"

# İzlenen uygulamalar. ISS'in Play sürümü YOK (Play hesabında tek paket adı
# kayıtlı: com.rytex.app) — `play` alanı None ise o tarafa hiç bakılmaz.
APPS = [
    {"key": "rytex", "ad": "RYTEX", "ikon": "📱",
     "asc_id": "6788542298", "play": "com.rytex.app"},
    {"key": "iss", "ad": "Space Station Alarm", "ikon": "🛰",
     "asc_id": "6793333020", "play": None},
]

# SAAT BAŞI bakılan ülkeler: RC'de kullanıcımız olanlar + 14 dilimizin
# pazarları. 175 storefront'u saat başı yoklamak anlamsız; puan buralardan
# gelmezse günlük geniş tarama yakalar.
CORE = ["us", "tr", "gb", "de", "fr", "es", "it", "nl", "se", "no",
        "pl", "ru", "ua", "br", "mx", "jp", "cn", "ca", "au"]

# GÜNDE BİR KEZ bakılan geniş liste (çekirdeğe ek).
WIDE = CORE + [
    "ch", "at", "be", "dk", "fi", "ie", "nz", "pt", "gr", "cz", "hu", "ro",
    "il", "za", "kr", "tw", "hk", "sg", "ar", "cl", "co", "pe", "uy",
    "in", "id", "ph", "th", "vn", "my", "sa", "ae", "eg", "ng", "ke",
]

# State'te tutulacak en fazla yorum kimliği. Sınırsız büyürse dosya şişer;
# 500 yorum bizim hacmimizde yıllara denk gelir.
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


# ── Yıldızlar: açık iTunes ucu, kimlik bilgisi GEREKMİYOR ───────────────────
def stars(asc_id: str, ulkeler: list[str]) -> tuple[dict, list[str]]:
    """Storefront başına (adet, ortalama). Tek ülkenin hatası TURU DÜŞÜRMEZ.

    ⚠️ Bu uç CDN önbellekli: sürüm dizisinde saatlerce gecikme ÖLÇÜLMÜŞTÜ
    (12 Eylül, yayın sonrası iTunes hâlâ eski sürümü gösteriyordu). Yani
    "anında" değil, "birkaç saat içinde" bekle.
    """
    out: dict[str, dict] = {}
    hata: list[str] = []
    for cc in ulkeler:
        try:
            d = _get_json(f"https://itunes.apple.com/lookup?id={asc_id}&country={cc}")
            res = d.get("results") or []
            if not res:
                continue                      # o ülkede satışta değil
            r = res[0]
            n = int(r.get("userRatingCount") or 0)
            if n:                             # 0 puanlı ülkeyi state'e yazma
                out[cc] = {"n": n, "avg": round(float(r.get("averageUserRating") or 0), 2)}
        except Exception as e:                # noqa: BLE001
            hata.append(f"{cc}:{type(e).__name__}")
        time.sleep(0.25)                      # ucu dövmeyelim
    return out, hata


# ── App Store yorumları: ASC API ────────────────────────────────────────────
def asc_reviews(asc_id: str) -> list[dict]:
    if not (ASC_KEY_ID and ASC_ISSUER and ASC_KEY_FILE):
        raise RuntimeError("ASC yorum anahtarı tanımsız")
    import jwt                                # noqa: PLC0415
    key = Path(ASC_KEY_FILE).expanduser().read_text()
    tok = jwt.encode({"iss": ASC_ISSUER, "iat": int(time.time()),
                      "exp": int(time.time()) + 900, "aud": "appstoreconnect-v1"},
                     key, algorithm="ES256", headers={"kid": ASC_KEY_ID})
    d = _get_json(
        f"{ASC_B}/apps/{asc_id}/customerReviews?limit=50&sort=-createdDate",
        {"Authorization": "Bearer " + tok})
    out = []
    for x in d.get("data", []):
        a = x["attributes"]
        out.append({
            "id": x["id"], "magaza": "App Store",
            "yildiz": a.get("rating"), "ulke": (a.get("territory") or "").lower(),
            "baslik": a.get("title") or "", "metin": a.get("body") or "",
            "kisi": a.get("reviewerNickname") or "", "tarih": (a.get("createdDate") or "")[:10],
        })
    return out


# ── Play yorumları ──────────────────────────────────────────────────────────
def play_reviews(pkg: str) -> list[dict]:
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
            "tarih": datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d") if ts else "",
        })
    return out


def yorum_blogu(r: dict) -> list[str]:
    """Tek yorumun Telegram gövdesi. Metin KIRPILIYOR (Telegram 4096 sınırı)."""
    yildiz = "★" * int(r["yildiz"] or 0) + "☆" * (5 - int(r["yildiz"] or 0))
    bas = f"  {yildiz} <b>{r['yildiz']}</b> · {r['magaza']}"
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


def yildiz_farki(eski: dict, yeni: dict) -> list[str]:
    """Değişen storefront'lar. ⚠️ ESKİ YOKSA FARK ÜRETİLMEZ: ilk koşuda
    mevcut tüm puanlar "yeni geldi" diye bildirilirse sahte alarm olur."""
    if not eski:
        return []
    out = []
    for cc in sorted(set(eski) | set(yeni)):
        a, b = eski.get(cc), yeni.get(cc)
        if a == b:
            continue
        if a is None:
            out.append(f"  🆕 {cc.upper()}: ilk puan — {b['avg']} ({b['n']} oy)")
        elif b is None:
            out.append(f"  ⚠️ {cc.upper()}: puan kayboldu ({a['n']} oy idi)")
        else:
            ok = "↑" if b["avg"] > a["avg"] else ("↓" if b["avg"] < a["avg"] else "→")
            out.append(f"  {cc.upper()}: {a['avg']} → {b['avg']} {ok} "
                       f"· oy {a['n']} → {b['n']}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="Telegram'a gönderme")
    ap.add_argument("--selftest", action="store_true",
                    help="sahte yorum + sahte yıldız değişimi enjekte et (dişi testi)")
    args = ap.parse_args()

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    st = {}
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text())
        except Exception:                     # noqa: BLE001
            st = {}                           # bozuk state = sıfırdan, ama sessiz değil
            log("UYARI: state okunamadı, sıfırlandı")

    simdi = datetime.now()
    gunluk = (simdi.hour == DAILY_HOUR and st.get("last_daily") != simdi.strftime("%Y-%m-%d"))
    ulkeler = WIDE if gunluk else CORE

    gorulen = set(st.get("seen_reviews", []))
    eski_yildiz = st.get("stars", {})
    yeni_yildiz: dict[str, dict] = {}
    sorunlar: list[str] = []
    govde: list[str] = []
    yeni_yorum_sayisi = 0
    yildiz_degisti = False

    for app in APPS:
        bolum: list[str] = []

        # 1) yorumlar
        yeni_yorumlar = []
        try:
            for r in asc_reviews(app["asc_id"]):
                if r["id"] and f"as:{r['id']}" not in gorulen:
                    yeni_yorumlar.append(r)
        except Exception as e:                # noqa: BLE001
            sorunlar.append(f"{app['ad']}: App Store yorumları okunamadı — "
                            f"{type(e).__name__}: {str(e)[:100]}")
        if app["play"]:
            try:
                for r in play_reviews(app["play"]):
                    if r["id"] and f"play:{r['id']}" not in gorulen:
                        yeni_yorumlar.append(r)
            except Exception as e:            # noqa: BLE001
                sorunlar.append(f"{app['ad']}: Play yorumları okunamadı — "
                                f"{type(e).__name__}: {str(e)[:100]}")

        if args.selftest and app["key"] == "rytex":
            yeni_yorumlar.append({
                "id": "SELFTEST", "magaza": "App Store", "yildiz": 2,
                "ulke": "de", "baslik": "Dişi testi",
                "metin": "Bu sahte bir yorumdur; mesaj yolunun çalıştığını kanıtlar.",
                "kisi": "selftest", "tarih": simdi.strftime("%Y-%m-%d")})

        for r in yeni_yorumlar:
            bolum += yorum_blogu(r) + [""]
            if r["id"] != "SELFTEST":
                gorulen.add(("play:" if r["magaza"] == "Play" else "as:") + r["id"])
        yeni_yorum_sayisi += len(yeni_yorumlar)

        # 2) yıldızlar
        sn, hata = stars(app["asc_id"], ulkeler)
        if hata and len(hata) > len(ulkeler) // 2:
            sorunlar.append(f"{app['ad']}: yıldız okuması çoğunlukla başarısız "
                            f"({len(hata)}/{len(ulkeler)})")
        yeni_yildiz[app["asc_id"]] = sn
        onceki = eski_yildiz.get(app["asc_id"], {})
        if args.selftest:
            onceki = {k: {"n": max(0, v["n"] - 1), "avg": 5.0} for k, v in sn.items()} or \
                     {"xx": {"n": 1, "avg": 3.0}}
        fark = yildiz_farki(onceki, sn)
        if fark:
            yildiz_degisti = True
            bolum += ["  <b>yıldız değişimi</b>"] + fark + [""]

        if gunluk:
            toplam = sum(v["n"] for v in sn.values())
            if toplam:
                ort = sum(v["avg"] * v["n"] for v in sn.values()) / toplam
                bolum.append(f"  <b>puan:</b> {ort:.2f} ortalama · {toplam} oy")
                for cc, v in sorted(sn.items(), key=lambda x: -x[1]["n"]):
                    bolum.append(f"    {cc.upper()}: {v['avg']} ({v['n']})")
            else:
                bolum.append("  <b>puan:</b> henüz yok")
            bolum.append("")

        if bolum:
            govde += [f"{app['ikon']} <b>{app['ad']}</b>"] + bolum

    # ⚠️ AYNI SORUN SAAT BAŞI TEKRARLANMAZ. Bu betik anahtarsız kurulabiliyor
    # (yıldızlar kimlik istemiyor, yorumlar istiyor) ve o durumda her koşu
    # "anahtar tanımsız" derdi — günde 24 mesaj, gerçek haberi öldürür.
    # İmza sorunun TÜRÜNDEN çıkar, metninden değil: rakamlar maskeleniyor,
    # yoksa "12/19 başarısız" bir sonraki saat "13/19" olup yeni sorun sanılır.
    # (DB nöbetçisindeki 2026-09-06 dersinin aynısı.)
    sig = "|".join(sorted(re.sub(r"\d+", "#", x) for x in sorunlar))
    tekrar = bool(sorunlar) and sig == st.get("problem_sig", "")
    gonder = bool(yeni_yorum_sayisi or yildiz_degisti or gunluk
                  or (sorunlar and not tekrar))
    if gonder:
        bas = ("💬 YENİ YORUM" if yeni_yorum_sayisi else
               "⭐ YILDIZ DEĞİŞTİ" if yildiz_degisti else
               "🔴 MAĞAZA NÖBETÇİSİ — SORUN" if sorunlar and not gunluk else
               "⭐ Mağaza raporu")
        mesaj = [bas, simdi.strftime("%d.%m.%Y %H:%M"), ""]
        if sorunlar:
            mesaj += ["<b>Sorunlar</b>"] + [f"• {s}" for s in sorunlar] + [""]
        mesaj += govde
        metin = "\n".join(mesaj)[:4000]
        telegram(metin, args.dry)
        print(metin)
    else:
        log("değişiklik yok, sessiz")

    # State — selftest gerçek durumu BOZMAZ.
    if not args.selftest:
        # İmza her koşuda yazılır (sorun yoksa boşalır) — böylece sorun
        # kapanınca bir sonraki oluşumunda yeniden bildirilir.
        st["problem_sig"] = sig
        st["seen_reviews"] = sorted(gorulen)[-SEEN_CAP:]
        st["stars"] = yeni_yildiz
        if gunluk:
            st["last_daily"] = simdi.strftime("%Y-%m-%d")
        STATE.write_text(json.dumps(st, indent=1))
    return 1 if sorunlar else 0


if __name__ == "__main__":
    raise SystemExit(main())
