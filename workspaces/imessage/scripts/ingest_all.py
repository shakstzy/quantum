#!/usr/bin/env python3
"""iMessage / SMS / RCS ingest from local chat.db.

- Reads ~/Library/Messages/chat.db read-only via a temp copy (avoids WAL contention).
- Classifies each chat once as keep|review based on heuristics (see CLAUDE.md).
- Kept messages: raw/imessage/YYYY-MM.ndjson (sharded by message month).
- Flagged messages: raw/imessage/_review-list.ndjson (with flag_reason).
- Watermark: raw/.ingest-log/imessage.watermark stores last processed message.ROWID.
- Resumable. Re-running only ingests new messages (ROWID > watermark) and reuses cached chat classifications.
- Text only. cache_has_attachments is preserved as has_attachment so flow stays readable.
- attributedBody-only messages are decoded via a typedstream regex; failures are logged and skipped.
"""
from __future__ import annotations

import argparse
import glob
import json
import pathlib
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[3]
RAW = ROOT / "raw" / "imessage"
LOG = ROOT / "raw" / ".ingest-log"
WATERMARK_FILE = LOG / "imessage.watermark"
CHAT_CLASS_FILE = LOG / "imessage.chat-class.json"
REVIEW_FILE = RAW / "_review-list.ndjson"

CHAT_DB = pathlib.Path.home() / "Library" / "Messages" / "chat.db"
ADDRESSBOOK_GLOB = str(
    pathlib.Path.home() / "Library" / "Application Support" / "AddressBook" / "Sources" / "*" / "AddressBook-v22.abcddb"
)

# Apple epoch: nanoseconds since 2001-01-01 UTC.
APPLE_EPOCH_OFFSET = 978307200  # seconds between 1970-01-01 and 2001-01-01

# Spam / 2FA heuristic regexes.
SHORTCODE_RE = re.compile(r"^\d{3,7}$")
NOREPLY_HANDLE_PARTS = (
    "noreply", "no-reply", "donotreply", "do-not-reply",
    "notifications@", "alerts@", "support@", "info@", "help@",
)
TWOFA_KEYWORDS_RE = re.compile(
    r"(verification code|your code is|use this code|\bOTP\b|one[- ]time|do not share|"
    r"\d+%\s*off|\$\d+\s*off|reply STOP|STOP to opt out|to unsubscribe|to opt[- ]out)",
    re.IGNORECASE,
)


def apple_ts_to_iso(apple_ts_ns: int | None) -> str | None:
    if not apple_ts_ns:
        return None
    secs = apple_ts_ns / 1_000_000_000 + APPLE_EPOCH_OFFSET
    return datetime.fromtimestamp(secs, tz=timezone.utc).isoformat()


def apple_ts_to_month(apple_ts_ns: int | None) -> str | None:
    if not apple_ts_ns:
        return None
    secs = apple_ts_ns / 1_000_000_000 + APPLE_EPOCH_OFFSET
    return datetime.fromtimestamp(secs, tz=timezone.utc).strftime("%Y-%m")


def parse_attributed_body(blob: bytes | None) -> str | None:
    """Best-effort decode of NSAttributedString typedstream blobs.

    Apple stores rich-text message bodies here when text is null. This parser handles
    the common case (single NSString segment with length-prefixed UTF-8). Returns None
    on anything weird; caller logs and skips.
    """
    if not blob:
        return None
    marker = b"NSString"
    idx = blob.find(marker)
    if idx < 0:
        return None
    # Find the start-of-string sentinel after NSString class metadata.
    start = blob.find(b"\x01+", idx)
    if start < 0:
        return None
    pos = start + 2
    if pos >= len(blob):
        return None
    length_byte = blob[pos]
    if length_byte == 0x81:
        if pos + 3 > len(blob):
            return None
        length = int.from_bytes(blob[pos + 1 : pos + 3], "little")
        pos += 3
    elif length_byte == 0x82:
        if pos + 5 > len(blob):
            return None
        length = int.from_bytes(blob[pos + 1 : pos + 5], "little")
        pos += 5
    else:
        length = length_byte
        pos += 1
    if length <= 0 or pos + length > len(blob):
        return None
    try:
        return blob[pos : pos + length].decode("utf-8", errors="replace")
    except Exception:
        return None


def normalize_phone(raw: str) -> str:
    """Normalize a phone string to E.164-ish form. Default region: US (+1)."""
    if not raw:
        return ""
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return ""
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return f"+{digits}"


def load_contacts_index() -> dict[str, str]:
    """Build a map of normalized phone / lowercased email -> display name from all
    AddressBook source DBs. Returns {} if Contacts not readable (no FDA, etc.)."""
    index: dict[str, str] = {}
    sources = glob.glob(ADDRESSBOOK_GLOB)
    if not sources:
        return index
    for db_path in sources:
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
        except sqlite3.OperationalError:
            continue
        try:
            rows = conn.execute(
                "SELECT r.Z_PK AS pk, r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, "
                "r.ZNICKNAME AS nick, r.ZORGANIZATION AS org "
                "FROM ZABCDRECORD r"
            ).fetchall()
            for r in rows:
                pk = r["pk"]
                parts = [r["first"], r["last"]]
                name = " ".join(p for p in parts if p).strip()
                if not name:
                    name = (r["nick"] or r["org"] or "").strip()
                if not name:
                    continue
                phones = conn.execute(
                    "SELECT ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZOWNER = ?", (pk,)
                ).fetchall()
                for p in phones:
                    n = normalize_phone(p["ZFULLNUMBER"] or "")
                    if n:
                        index.setdefault(n, name)
                emails = conn.execute(
                    "SELECT ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?", (pk,)
                ).fetchall()
                for e in emails:
                    addr = (e["ZADDRESS"] or "").strip().lower()
                    if addr:
                        index.setdefault(addr, name)
        finally:
            conn.close()
    return index


def resolve_handle(handle: str | None, contacts: dict[str, str]) -> str | None:
    """Look up a chat.db handle in the Contacts index. Returns name or None."""
    if not handle:
        return None
    h = handle.strip()
    # Strip suffixes like (smsft), (smsfp) that Apple appends to fallback handles.
    h = re.sub(r"\([a-z]+\)$", "", h)
    if "@" in h:
        return contacts.get(h.lower())
    if h.startswith("+") or h.isdigit():
        return contacts.get(normalize_phone(h))
    return None


def load_watermark() -> int:
    if WATERMARK_FILE.exists():
        try:
            return int(WATERMARK_FILE.read_text().strip() or "0")
        except ValueError:
            return 0
    return 0


def save_watermark(rowid: int) -> None:
    WATERMARK_FILE.write_text(str(rowid))


def load_chat_class() -> dict[str, dict]:
    if CHAT_CLASS_FILE.exists():
        try:
            return json.loads(CHAT_CLASS_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_chat_class(cache: dict[str, dict]) -> None:
    CHAT_CLASS_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True))


def classify_chat(handles: list[str], sample_messages: list[tuple[str | None, int]]) -> tuple[str, str]:
    """Return ('keep' | 'review', reason). sample_messages = [(text, is_from_me), ...]."""
    for h in handles:
        if not h:
            continue
        if SHORTCODE_RE.match(h.strip()):
            return "review", f"shortcode-handle:{h}"
        h_lower = h.lower()
        for token in NOREPLY_HANDLE_PARTS:
            if token in h_lower:
                return "review", f"noreply-handle:{h}"
    # Only run keyword check on 1:1 chats with all-inbound messages.
    if len(handles) == 1 and sample_messages:
        all_inbound = all(not is_from_me for _, is_from_me in sample_messages)
        if all_inbound:
            texts = [t for t, _ in sample_messages if t]
            if texts and all(TWOFA_KEYWORDS_RE.search(t) for t in texts):
                return "review", "all-inbound-2fa-promo-keywords"
    return "keep", "ok"


def open_chat_db_readonly() -> tuple[sqlite3.Connection, pathlib.Path]:
    """Copy chat.db to a temp file and open it. Avoids WAL contention with the live Messages.app."""
    if not CHAT_DB.exists():
        sys.exit(f"chat.db not found at {CHAT_DB}")
    tmp_dir = pathlib.Path(tempfile.mkdtemp(prefix="quantum-imsg-"))
    tmp_db = tmp_dir / "chat.db"
    try:
        shutil.copy2(CHAT_DB, tmp_db)
    except PermissionError:
        sys.exit(
            "PermissionError reading chat.db. This binary lacks Full Disk Access.\n"
            "Run from an iTerm session (or via the Claude Code SessionStart hook),\n"
            "which inherits FDA from iTerm. launchd-spawned runs do NOT inherit FDA\n"
            "because /bin/bash is SIP-locked and direct python3 grants don't propagate."
        )
    # Also copy WAL/SHM if present so we get the latest committed state.
    for suffix in ("-wal", "-shm"):
        src = CHAT_DB.with_name(CHAT_DB.name + suffix)
        if src.exists():
            shutil.copy2(src, tmp_db.with_name(tmp_db.name + suffix))
    conn = sqlite3.connect(f"file:{tmp_db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn, tmp_dir


def fetch_chat_handles(conn: sqlite3.Connection, chat_rowid: int) -> list[str]:
    rows = conn.execute(
        "SELECT h.id AS handle "
        "FROM chat_handle_join chj "
        "JOIN handle h ON h.ROWID = chj.handle_id "
        "WHERE chj.chat_id = ?",
        (chat_rowid,),
    ).fetchall()
    return [r["handle"] for r in rows if r["handle"]]


def fetch_chat_meta(conn: sqlite3.Connection, chat_rowid: int) -> tuple[str, str | None]:
    """Return (chat_guid, display_name). display_name is Apple's group-chat title or None."""
    row = conn.execute(
        "SELECT guid, display_name FROM chat WHERE ROWID = ?", (chat_rowid,)
    ).fetchone()
    if not row:
        return ("", None)
    name = row["display_name"]
    if name is not None and not name.strip():
        name = None
    return (row["guid"], name)


def fetch_chat_sample(conn: sqlite3.Connection, chat_rowid: int, limit: int = 30) -> list[tuple[str | None, int]]:
    rows = conn.execute(
        "SELECT m.text, m.attributedBody, m.is_from_me "
        "FROM chat_message_join cmj "
        "JOIN message m ON m.ROWID = cmj.message_id "
        "WHERE cmj.chat_id = ? "
        "ORDER BY m.date DESC "
        "LIMIT ?",
        (chat_rowid, limit),
    ).fetchall()
    out: list[tuple[str | None, int]] = []
    for r in rows:
        t = r["text"]
        if not t and r["attributedBody"]:
            t = parse_attributed_body(r["attributedBody"])
        out.append((t, int(r["is_from_me"] or 0)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--full", action="store_true", help="Ignore watermark and reprocess all messages.")
    ap.add_argument("--limit", type=int, default=None, help="Max new messages to process this run (debug).")
    args = ap.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    LOG.mkdir(parents=True, exist_ok=True)

    watermark = 0 if args.full else load_watermark()
    chat_class = {} if args.full else load_chat_class()

    contacts = load_contacts_index()
    conn, tmp_dir = open_chat_db_readonly()
    started = time.time()
    print(
        f"watermark={watermark} chat_class_cached={len(chat_class)} contacts_indexed={len(contacts)}",
        file=sys.stderr,
    )

    try:
        # Open per-month shard handles lazily.
        shard_handles: dict[str, "object"] = {}
        review_handle = REVIEW_FILE.open("a", encoding="utf-8")

        kept_count = 0
        review_count = 0
        skipped_empty = 0
        skipped_attbody_decode_fail = 0
        per_month_counts: dict[str, int] = defaultdict(int)
        new_chats_classified = 0
        max_rowid_seen = watermark

        sql = (
            "SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, "
            "m.is_from_me, m.service, m.cache_has_attachments AS has_attachment, "
            "m.is_system_message, m.item_type, m.subject, "
            "h.id AS handle, "
            "cmj.chat_id AS chat_rowid "
            "FROM message m "
            "LEFT JOIN handle h ON h.ROWID = m.handle_id "
            "JOIN chat_message_join cmj ON cmj.message_id = m.ROWID "
            "WHERE m.ROWID > ? "
            "ORDER BY m.ROWID ASC"
        )
        if args.limit:
            sql += f" LIMIT {int(args.limit)}"

        # chat_rowid -> (handles, chat_guid, display_name, participant_names)
        chat_meta_cache: dict[int, tuple[list[str], str, str | None, list[str]]] = {}

        def get_meta(crid: int) -> tuple[list[str], str, str | None, list[str]]:
            if crid not in chat_meta_cache:
                handles = fetch_chat_handles(conn, crid)
                guid, display_name = fetch_chat_meta(conn, crid)
                names = [resolve_handle(h, contacts) or h for h in handles]
                chat_meta_cache[crid] = (handles, guid, display_name, names)
            return chat_meta_cache[crid]

        for r in conn.execute(sql, (watermark,)):
            rowid = int(r["rowid"])
            if rowid > max_rowid_seen:
                max_rowid_seen = rowid

            chat_rowid = r["chat_rowid"]
            if chat_rowid is None:
                continue
            chat_key = str(chat_rowid)

            # Decode body.
            text = r["text"]
            if not text and r["attributedBody"]:
                decoded = parse_attributed_body(r["attributedBody"])
                if decoded is None:
                    skipped_attbody_decode_fail += 1
                    continue
                text = decoded
            if not text:
                # No text at all (e.g., pure attachment, system event, sticker). Keep
                # in main shard with empty text only if attachment present, otherwise skip.
                if not r["has_attachment"]:
                    skipped_empty += 1
                    continue
                text = ""

            handles, chat_guid, chat_display_name, participant_names = get_meta(chat_rowid)

            # Classify chat if we haven't yet.
            if chat_key not in chat_class:
                sample = fetch_chat_sample(conn, chat_rowid)
                cls, reason = classify_chat(handles, sample)
                chat_class[chat_key] = {
                    "class": cls,
                    "reason": reason,
                    "handles": handles,
                    "first_seen_rowid": rowid,
                }
                new_chats_classified += 1

            cls_entry = chat_class[chat_key]
            sender_handle = r["handle"]
            sender_name = "Adithya" if r["is_from_me"] else (resolve_handle(sender_handle, contacts) if sender_handle else None)

            record = {
                "rowid": rowid,
                "guid": r["guid"],
                "chat_rowid": chat_rowid,
                "chat_guid": chat_guid,
                "chat_display_name": chat_display_name,
                "chat_handles": handles,
                "chat_participant_names": participant_names,
                "is_group": len(handles) > 1,
                "handle": sender_handle,
                "sender_name": sender_name,
                "is_from_me": bool(r["is_from_me"]),
                "service": r["service"],
                "subject": r["subject"],
                "text": text,
                "has_attachment": bool(r["has_attachment"]),
                "is_system_message": bool(r["is_system_message"]),
                "item_type": r["item_type"],
                "date_apple_ns": r["date"],
                "date_iso": apple_ts_to_iso(r["date"]),
            }

            if cls_entry["class"] == "review":
                record["flag_reason"] = cls_entry["reason"]
                review_handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                review_count += 1
            else:
                month = apple_ts_to_month(r["date"]) or "unknown"
                if month not in shard_handles:
                    shard_handles[month] = (RAW / f"{month}.ndjson").open("a", encoding="utf-8")
                shard_handles[month].write(json.dumps(record, ensure_ascii=False) + "\n")
                per_month_counts[month] += 1
                kept_count += 1

        for h in shard_handles.values():
            h.close()
        review_handle.close()

        save_chat_class(chat_class)
        if max_rowid_seen > watermark:
            save_watermark(max_rowid_seen)

        elapsed = time.time() - started
        print(
            f"done in {elapsed:.1f}s | kept={kept_count} review={review_count} "
            f"empty_skipped={skipped_empty} attbody_decode_fail={skipped_attbody_decode_fail} "
            f"new_chats={new_chats_classified} watermark={max_rowid_seen}",
            file=sys.stderr,
        )
        for month in sorted(per_month_counts):
            print(f"  {month}: {per_month_counts[month]}", file=sys.stderr)

        # Summary of review-list flags from this run's classifications.
        flag_summary: dict[str, int] = defaultdict(int)
        for entry in chat_class.values():
            if entry["class"] == "review":
                reason_root = entry["reason"].split(":", 1)[0]
                flag_summary[reason_root] += 1
        if flag_summary:
            print("review-list flag breakdown (all chats ever flagged):", file=sys.stderr)
            for k, v in sorted(flag_summary.items(), key=lambda x: -x[1]):
                print(f"  {k}: {v} chats", file=sys.stderr)
    finally:
        conn.close()
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
