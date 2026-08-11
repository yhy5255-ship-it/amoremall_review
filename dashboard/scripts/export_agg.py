# -*- coding: utf-8 -*-
"""
Pulls the raw ad-performance sheet via a Google service account and aggregates
it into dashboard/data.json, which app.js loads in the browser.

Usage:
    python scripts/export_agg.py

Requires:
    pip install google-api-python-client google-auth

Set the service account key path via the GOOGLE_SERVICE_ACCOUNT_KEY env var,
or edit KEY_PATH below. The account only needs Viewer access to the sheet.

Aggregation is day-level (keyed by the "일" column, not the "주차" text column) -
app.js re-aggregates on top of this into whatever A/B date range the user picks,
which can span month tabs (e.g. 6/29~7/5 covering both a June and a July tab).
The "주차" label is kept per row as "weekLabel" for display/preset purposes only;
it is not part of the grouping key.
"""
import os
import re
import sys
import io
import json
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from google.oauth2 import service_account
from googleapiclient.discovery import build

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

KEY_PATH = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY", r"c:\Users\wisebirds\.secrets\arctic-plate-468205-n6-a485ae6332e7.json")
SPREADSHEET_ID = "1-vb3s2ewP1Kl_v3_PGHWrON3mLA6N1OGmyN_NhSC86M"
MONTH_TAB_RE = re.compile(r"^\d{4}$")  # "2607", "2608", ... - excludes "Index" and other reference tabs
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(SCRIPT_DIR, "..", "data.json")

creds = service_account.Credentials.from_service_account_file(
    KEY_PATH, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"]
)
service = build("sheets", "v4", credentials=creds)

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ALT_DATE_RE = re.compile(r"^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$")


def num(s):
    if not s:
        return 0.0
    try:
        return float(str(s).replace(",", "").replace("%", ""))
    except ValueError:
        return 0.0


def normalize_date(d):
    """The sheet's "일" column is already YYYY-MM-DD in practice, but this
    normalizes common variants (2026/7/1, 2026.07.01) and rejects anything else
    so a malformed date can't silently corrupt date-range filtering downstream."""
    d = (d or "").strip()
    if DATE_RE.match(d):
        return d
    m = ALT_DATE_RE.match(d)
    if m:
        y, mo, da = m.groups()
        return f"{y}-{int(mo):02d}-{int(da):02d}"
    return ""


def export_tab(tab_name):
    # Open-ended row bound (no fixed upper row number) - the sheet grows every
    # week, and a hardcoded last-row number silently truncates new weeks once
    # the sheet outgrows it (this happened: sheet has 10,000+ rows now, the
    # previous "A4:BL4441" bound was silently dropping everything after row 4441).
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID, range=f"{tab_name}!A4:BL"
    ).execute()
    values = result.get("values", [])
    if not values:
        return None
    header = values[0]
    rows = values[1:]
    idx = {h: i for i, h in enumerate(header) if h}

    def col(name, r):
        i = idx.get(name)
        if i is None or i >= len(r):
            return ""
        return r[i]

    groups = {}
    promo_groups = {}
    campaign_groups = {}
    week_labels_seen = set()
    skipped_bad_date = 0

    for r in rows:
        goal = col("목표", r)
        if not goal:
            continue
        date = normalize_date(col("일", r))
        if not date:
            skipped_bad_date += 1
            continue
        week_label = col("주차", r)
        if week_label:
            week_labels_seen.add(week_label)

        # Column mapping confirmed against the source sheet:
        #   impr=G click=H views=K spend=AK(Gross) purchaseConv=AI gmv=AJ
        #   install=W(Airbridge) firstPurchase=BC signup=BH
        #   promoFull=AE brand=AF promo=AG material=AW
        spend = num(col("지출 금액 (Gross)", r))       # AK
        gmv = num(col("GMV", r))                        # AJ
        impr = num(col("노출", r))                       # G
        click = num(col("클릭", r))                       # H
        views = num(col("조회수", r))                     # K
        install = num(col("Airbridge 앱 설치", r))        # W
        purchase_conv = num(col("총 구매전환", r))         # AI
        first_purchase = num(col("첫구매", r))            # BC
        first_purchase_rev = num(col("첫구매 매출", r))
        signup = num(col("회원가입", r))                  # BH

        # optimization (AO, "Product / optimization") is part of the key, not just a
        # stored field - two rows that otherwise share a key but differ only by this
        # value would silently merge into one row and lose one of the two values,
        # which breaks the "new media/optimization this week" detection in app.js
        # (it needs every distinct value that ever appeared, not just the last one).
        optimization = col("Product / optimization", r)
        key = (
            date, col("Channel", r), goal, col("Media", r),
            col("브랜드", r), col("기획전명", r), col("기획전 상태", r),
            col("기획전 시작날짜", r), col("기획전 종료날짜", r), optimization,
        )
        g = groups.get(key)
        if g is None:
            g = {
                "date": date, "weekLabel": week_label, "channel": col("Channel", r), "goal": goal,
                "media": col("Media", r), "brand": col("브랜드", r),
                "promo": col("기획전명", r), "status": col("기획전 상태", r),
                "promoStart": col("기획전 시작날짜", r), "promoEnd": col("기획전 종료날짜", r),
                "optimization": optimization,
                "spend": 0.0, "gmv": 0.0, "impr": 0.0, "click": 0.0, "views": 0.0,
                "firstPurchase": 0.0, "firstPurchaseRev": 0.0, "signup": 0.0,
                "install": 0.0, "purchaseConv": 0.0,
            }
            groups[key] = g
        g["spend"] += spend
        g["gmv"] += gmv
        g["impr"] += impr
        g["click"] += click
        g["views"] += views
        g["firstPurchase"] += first_purchase
        g["firstPurchaseRev"] += first_purchase_rev
        g["signup"] += signup
        g["install"] += install
        g["purchaseConv"] += purchase_conv

        # Secondary aggregation for the "우수 기획전" leaderboard:
        # AE(full label incl. launch date)/AF(brand)/AG(promo)/AW(creative material)
        pkey = (
            date, goal, col("브랜드/기획전명", r), col("브랜드", r), col("기획전명", r),
            col("소재명", r), col("기획전 상태", r), col("기획전 시작날짜", r), col("기획전 종료날짜", r),
        )
        pg = promo_groups.get(pkey)
        if pg is None:
            pg = {
                "date": date, "weekLabel": week_label, "goal": goal, "promoFull": col("브랜드/기획전명", r),
                "brand": col("브랜드", r), "promo": col("기획전명", r), "material": col("소재명", r),
                "status": col("기획전 상태", r), "promoStart": col("기획전 시작날짜", r),
                "promoEnd": col("기획전 종료날짜", r),
                "spend": 0.0, "gmv": 0.0, "impr": 0.0, "click": 0.0, "views": 0.0,
                "firstPurchase": 0.0, "signup": 0.0, "install": 0.0, "purchaseConv": 0.0,
            }
            promo_groups[pkey] = pg
        pg["spend"] += spend
        pg["gmv"] += gmv
        pg["impr"] += impr
        pg["click"] += click
        pg["views"] += views
        pg["firstPurchase"] += first_purchase
        pg["signup"] += signup
        pg["install"] += install
        pg["purchaseConv"] += purchase_conv

        # Campaign/group-level aggregation for the monthly "캠페인 세팅 변화" diff.
        # Media here must be the canonical "Media" column (AN, e.g. "Google"), not the
        # raw "매체" column (B, e.g. "Google AC"/"Google ACe"/"Google pMax") - confirmed
        # against the live sheet that AN is what groups/promoGroups already key media on
        # (groupByMedia, UNSUPPORTED_FP_SU_MEDIA etc. all expect the canonical names).
        # rawMedia (B) is kept as a separate display/filter field - the setting-diff
        # feature excludes noisy always-rotating sub-accounts (K_KPF/Google AC/Google
        # ACe) by this raw value, since they collapse into indistinguishable canonical
        # media once grouped.
        ckey = (date, col("Media", r), col("캠페인이름", r), col("광고그룹 이름", r))
        cg = campaign_groups.get(ckey)
        if cg is None:
            cg = {
                "date": date, "weekLabel": week_label, "goal": goal,
                "media": col("Media", r), "rawMedia": col("매체", r),
                "campaign": col("캠페인이름", r), "group": col("광고그룹 이름", r),
                "spend": 0.0, "gmv": 0.0, "impr": 0.0, "click": 0.0, "views": 0.0,
                "firstPurchase": 0.0, "signup": 0.0, "install": 0.0, "purchaseConv": 0.0,
            }
            campaign_groups[ckey] = cg
        cg["spend"] += spend
        cg["gmv"] += gmv
        cg["impr"] += impr
        cg["click"] += click
        cg["views"] += views
        cg["firstPurchase"] += first_purchase
        cg["signup"] += signup
        cg["install"] += install
        cg["purchaseConv"] += purchase_conv

    if skipped_bad_date:
        print(f"  {tab_name}: skipped {skipped_bad_date} row(s) with an unparseable '일' value")

    # "주차" presets kept only as display/shortcut convenience - not used for grouping.
    week_range = defaultdict(list)
    for g in groups.values():
        if g["weekLabel"]:
            week_range[g["weekLabel"]].append(g["date"])
    weeks = []
    for w in sorted(week_labels_seen, key=lambda x: int(x.replace("주차", "").split("월")[-1].strip()) if "주차" in x else 0):
        ds = week_range.get(w, [])
        weeks.append({"label": w, "start": min(ds) if ds else "", "end": max(ds) if ds else ""})

    all_dates = [g["date"] for g in groups.values()]
    date_range = {"start": min(all_dates), "end": max(all_dates)} if all_dates else {"start": "", "end": ""}

    return {
        "tab": tab_name, "dateRange": date_range, "weeks": weeks,
        "groups": list(groups.values()), "promoGroups": list(promo_groups.values()),
        "campaignGroups": list(campaign_groups.values()),
    }


def discover_month_tabs():
    """New monthly tabs (2608, 2609, ...) keep getting added to the sheet over
    time, so tabs are discovered automatically instead of relying on a hardcoded
    list someone has to remember to update every month."""
    meta = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID, includeGridData=False).execute()
    titles = [s["properties"]["title"] for s in meta.get("sheets", [])]
    return sorted(t for t in titles if MONTH_TAB_RE.match(t))


KST = timezone(timedelta(hours=9))


def main():
    tabs = discover_month_tabs()
    print("discovered month tabs:", tabs)
    data = {"tabs": {}, "generatedAt": datetime.now(KST).isoformat()}
    for tab in tabs:
        tab_data = export_tab(tab)
        if tab_data:
            data["tabs"][tab] = tab_data
            print(f"{tab}: {len(tab_data['groups'])} groups, {len(tab_data['promoGroups'])} promoGroups, "
                  f"{len(tab_data['campaignGroups'])} campaignGroups, "
                  f"dateRange={tab_data['dateRange']}, weeks={[w['label'] for w in tab_data['weeks']]}")
        else:
            print(f"{tab}: no data found (tab missing or empty?)")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print("wrote", os.path.abspath(OUT_PATH))


if __name__ == "__main__":
    main()
