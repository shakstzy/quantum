"""Banned-niche regex filter.

Patterns live HERE as the canonical source of truth (the markdown file
`shared/policy/banned-niches.md` is human-readable documentation that should
mirror this list, but the Python list wins because regexes contain `|`
characters that break naive markdown table parsing).

Update both files together when adding a category.
"""
from __future__ import annotations

import re

# (category, regex). Case-insensitive.
PATTERNS: list[tuple[str, str]] = [
    ("gambling-sportsbook",
     r"bet365|draftkings|fanduel|stake\.com|sportsbook|casino|roulette|poker|slot machine|odds boost|free bet"),
    ("crypto-trading",
     r"\b(pump|moon|altcoin shill|to the moon|10x gem|next.{0,5}bitcoin|presale|crypto signal|memecoin)\b"),
    ("get-rich-quick",
     r"passive income|get rich|guaranteed (returns|profit|income)|make .{0,5}\$\d{3,5}.{0,10}(per |a |/) ?(day|week|hour)"),
    ("medical-supplement-claims",
     r"\b(cure|treats?|reverses?|prevents?)\s+(diabetes|cancer|alzheimer|depression)\b|nootropic|miracle pill|hormone optimize"),
    ("financial-advice-no-disclaimer",
     r"buy this stock|guaranteed return|insider tip|day trade|swing trade.{0,30}(this|now)"),
    ("adult-onlyfans",
     r"\bonlyfans\b|\bof model\b|sugar daddy|sugar baby|\bescort\b|nsfw promotion"),
    ("manosphere-redpill",
     r"\bred pill\b|alpha male|sigma grindset|female nature|hypergamy.{0,30}(women|female)|\bMGTOW\b"),
    ("conspiracy-misinfo",
     r"vaccines? cause|plandemic|false flag|new world order|deep state|elite agenda"),
    ("weight-loss-claims",
     r"lose \d+ pounds|weight loss (secret|hack|trick)|drop body fat in.{0,20}days"),
    ("political-paid-endorsement",
     r"vote for|don't vote|endorsing.{0,20}(candidate|president)"),
]

_COMPILED = [(cat, re.compile(p, re.IGNORECASE)) for cat, p in PATTERNS]


def is_banned(text: str) -> tuple[bool, list[str]]:
    if not text:
        return False, []
    hits: list[str] = []
    for cat, pat in _COMPILED:
        if pat.search(text):
            hits.append(cat)
    return (len(hits) > 0), hits


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        b, hits = is_banned(" ".join(sys.argv[1:]))
        print(f"banned={b} categories={hits}")
    else:
        print(f"loaded {len(_COMPILED)} patterns")
        for cat, _ in PATTERNS:
            print(f"  {cat}")
