"""Travis County (Austin, TX) CAD adapter.

Vendor: True Prodigy CAD (legacy 8.0.32 export format).
Bulk data: free download from https://traviscad.org/publicinformation
Refresh cadence: preliminary roll Apr-May, certified roll Jul-Aug, supps quarterly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

NAME = "travis"
STATE = "TX"
FIPS = "48453"

# Zips that fall predominantly in Travis County. Source: USPS + HUD crosswalk.
# A few zips straddle county lines (e.g. 78610 = mostly Hays); we accept some
# false-positives because the situs_zip in the parcel record is authoritative -
# the resolver only uses these to ROUTE which CAD to query, not to decide truth.
ZIPS = {
    "78610", "78613", "78617", "78641", "78645", "78652", "78653",
    "78660", "78664", "78669", "78691",
    "78701", "78702", "78703", "78704", "78705", "78712", "78717",
    "78719", "78721", "78722", "78723", "78724", "78725", "78726",
    "78727", "78728", "78729", "78730", "78731", "78732", "78733",
    "78734", "78735", "78736", "78737", "78738", "78739", "78741",
    "78742", "78744", "78745", "78746", "78747", "78748", "78749",
    "78750", "78751", "78752", "78753", "78754", "78756", "78757",
    "78758", "78759",
}

PUBINFO_URL = "https://traviscad.org/publicinformation"


@dataclass
class ExportInfo:
    url: str
    year: int
    kind: str  # "preliminary" | "certified" | "supp"


def find_latest_export() -> ExportInfo | None:
    """Scrape the public-info page for the most recent appraisal export.

    Prefers Certified > Preliminary > Supp, newer year over older.
    """
    try:
        from urllib.request import Request, urlopen
        req = Request(PUBINFO_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=30) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None

    # Pull all zip URLs in /wp-content/largefiles/...
    urls = re.findall(
        r'href="(https://traviscad\.org/wp-content/largefiles/[^"]+\.zip)"',
        html, flags=re.I,
    )
    candidates: list[ExportInfo] = []
    for u in urls:
        name = unquote(u.split("/")[-1])
        # Skip the schema layout doc
        if "Layout" in name:
            continue
        # Capture year (4 digits at start)
        ym = re.match(r"(\d{4})", name)
        if not ym:
            continue
        year = int(ym.group(1))
        lower = name.lower()
        if "certified appraisal export" in lower:
            kind = "certified"
        elif "preliminary appraisal export" in lower:
            kind = "preliminary"
        elif "special export" in lower:
            kind = "special"
        else:
            kind = "supp"
        candidates.append(ExportInfo(url=u, year=year, kind=kind))

    if not candidates:
        return None
    # Rank: newer year first, then certified > preliminary > special > supp
    rank = {"certified": 3, "preliminary": 2, "special": 1, "supp": 0}
    candidates.sort(key=lambda e: (e.year, rank.get(e.kind, 0)), reverse=True)
    return candidates[0]


# Filenames inside the export zip we care about.
PROP_FILE = "PROP.TXT"
IMP_DET_FILE = "IMP_DET.TXT"
LAND_DET_FILE = "LAND_DET.TXT"


def cache_dir() -> Path:
    return Path.home() / ".quantum" / "real-estate" / "cad" / NAME


def find_local_extract() -> Path | None:
    """If a zip has been extracted locally, return the dir containing PROP.TXT."""
    extracted = cache_dir() / "extracted"
    if (extracted / PROP_FILE).exists():
        return extracted
    return None
