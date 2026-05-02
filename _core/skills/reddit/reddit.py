#!/usr/bin/env python3
"""Reddit CLI for terse, context-friendly Reddit reads.

Stdlib only. Hits Reddit's JSON API. Anonymous by default (~10 req/min);
optional OAuth via env vars REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET lifts
to ~60 req/min using the application-only client_credentials flow.

Default output is compact markdown; --json dumps cleaned structured data.

Subcommands: search, hot, new, top, controversial, rising, post, user, info
"""

import argparse
import base64
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_UA = "reddit-cli/1.1 (read-only; ULTRON local)"
ANON_BASE = "https://www.reddit.com"
OAUTH_BASE = "https://oauth.reddit.com"
TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
TOKEN_CACHE = pathlib.Path.home() / ".cache" / "reddit-cli" / "token.json"


def _get_oauth_token(ua):
    """Return a bearer token via client_credentials, cached on disk.

    Returns None when no creds in env (caller falls back to anonymous)."""
    cid = os.environ.get("REDDIT_CLIENT_ID")
    sec = os.environ.get("REDDIT_CLIENT_SECRET")
    if not (cid and sec):
        return None
    # cached token (10s safety buffer before expiry)
    if TOKEN_CACHE.exists():
        try:
            cached = json.loads(TOKEN_CACHE.read_text())
            if cached.get("expires_at", 0) - 10 > time.time():
                return cached["access_token"]
        except Exception:
            pass
    auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body,
        headers={"Authorization": f"Basic {auth}", "User-Agent": ua,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        tok = json.loads(r.read())
    tok["expires_at"] = time.time() + tok.get("expires_in", 3600)
    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(json.dumps(tok))
    TOKEN_CACHE.chmod(0o600)
    return tok["access_token"]


def fetch(path, params, ua):
    p = dict(params or {})
    p["raw_json"] = 1
    qs = "?" + urllib.parse.urlencode({k: v for k, v in p.items() if v is not None})
    token = _get_oauth_token(ua)
    base = OAUTH_BASE if token else ANON_BASE
    suffix = "" if token else ".json"  # oauth.reddit.com returns JSON without suffix
    url = f"{base}{path}{suffix}{qs}"
    headers = {"User-Agent": ua, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                # respect Retry-After if Reddit sent one
                retry = e.headers.get("Retry-After")
                delay = int(retry) if retry and retry.isdigit() else 2 ** attempt
                time.sleep(min(delay, 30))
                continue
            raise


def ago(ts):
    if not ts:
        return "?"
    delta = max(0, time.time() - ts)
    for unit, secs in (("y", 31536000), ("mo", 2592000), ("w", 604800),
                       ("d", 86400), ("h", 3600), ("m", 60)):
        if delta >= secs:
            return f"{int(delta // secs)}{unit}"
    return f"{int(delta)}s"


def trim(text, n):
    text = (text or "").strip()
    if len(text) <= n:
        return text
    return text[:n].rsplit(" ", 1)[0] + "…"


def fmt_post(p, idx=None):
    sub = p.get("subreddit", "")
    title = (p.get("title") or "").strip()
    score = p.get("score", 0)
    nc = p.get("num_comments", 0)
    author = p.get("author") or "[deleted]"
    when = ago(p.get("created_utc"))
    perm = p.get("permalink", "")
    url = p.get("url_overridden_by_dest") or p.get("url", "")
    pid = p.get("id", "")
    text = p.get("selftext") or ""
    flair = p.get("link_flair_text") or ""
    out = []
    out.append(f"## {idx}. {title}" if idx is not None else f"# {title}")
    meta = [f"r/{sub}", f"u/{author}", f"{score}↑", f"{nc}c", when]
    if flair:
        meta.append(f"[{flair}]")
    out.append(" · ".join(meta))
    out.append(f"id: {pid} | https://reddit.com{perm}")
    if url and not url.startswith("https://www.reddit.com") and not url.startswith("https://reddit.com"):
        out.append(f"link: {url}")
    if text:
        out.append("")
        out.append(trim(text, 400))
    return "\n".join(out)


def fmt_comment(c, depth, max_depth):
    if c.get("kind") != "t1":
        return ""
    d = c.get("data", {})
    body = (d.get("body") or "").strip()
    if not body or body in ("[deleted]", "[removed]"):
        return ""
    author = d.get("author") or "[deleted]"
    score = d.get("score", 0)
    pad = "  " * depth + "- "
    body_disp = trim(body.replace("\n", " "), 500)
    out = [f"{pad}**u/{author}** ({score}↑): {body_disp}"]
    if depth < max_depth:
        replies = d.get("replies")
        if isinstance(replies, dict):
            for child in replies.get("data", {}).get("children", []):
                line = fmt_comment(child, depth + 1, max_depth)
                if line:
                    out.append(line)
    return "\n".join(out)


def extract_posts(data):
    return [c["data"] for c in data.get("data", {}).get("children", []) if c.get("kind") == "t3"]


def cmd_search(args):
    params = {"q": args.query, "limit": args.limit, "sort": args.sort, "t": args.time}
    path = f"/r/{args.sub}/search" if args.sub else "/search"
    if args.sub:
        params["restrict_sr"] = "on"
    data = fetch(path, params, args.ua)
    posts = extract_posts(data)
    if args.json:
        print(json.dumps(posts, indent=2))
        return
    print(f"# search: {args.query}" + (f" in r/{args.sub}" if args.sub else ""))
    print()
    if not posts:
        print("(no results)")
        return
    for i, p in enumerate(posts, 1):
        print(fmt_post(p, i))
        print()


def cmd_listing(args):
    endpoint = args.cmd
    params = {"limit": args.limit}
    if endpoint in ("top", "controversial"):
        params["t"] = args.time
    data = fetch(f"/r/{args.subreddit}/{endpoint}", params, args.ua)
    posts = extract_posts(data)
    if args.json:
        print(json.dumps(posts, indent=2))
        return
    suffix = f" ({args.time})" if endpoint in ("top", "controversial") else ""
    print(f"# r/{args.subreddit} — {endpoint}{suffix}")
    print()
    if not posts:
        print("(no results)")
        return
    for i, p in enumerate(posts, 1):
        print(fmt_post(p, i))
        print()


def cmd_info(args):
    """Subreddit metadata: subscribers, description, type, NSFW, created."""
    data = fetch(f"/r/{args.subreddit}/about", {}, args.ua)
    d = data.get("data", {}) if isinstance(data, dict) else {}
    if not d:
        print(f"r/{args.subreddit} not found or inaccessible", file=sys.stderr)
        sys.exit(1)
    if args.json:
        print(json.dumps(d, indent=2))
        return
    name = d.get("display_name_prefixed") or f"r/{args.subreddit}"
    title = d.get("title", "")
    subs = d.get("subscribers", 0)
    active = d.get("active_user_count")
    created = ago(d.get("created_utc"))
    nsfw = "NSFW" if d.get("over18") else ""
    sub_type = d.get("subreddit_type", "public")
    desc = (d.get("public_description") or d.get("description") or "").strip()
    print(f"# {name}")
    if title:
        print(f"**{title}**")
    bits = [f"{subs:,} subscribers"]
    if active is not None:
        bits.append(f"{active:,} online")
    bits.append(f"created {created} ago")
    bits.append(sub_type)
    if nsfw:
        bits.append(nsfw)
    print(" · ".join(bits))
    print(f"https://reddit.com/r/{args.subreddit}")
    if desc:
        print()
        print(trim(desc, 800))


def parse_post_id(s):
    m = re.search(r"comments/([a-z0-9]+)", s)
    if m:
        return m.group(1)
    return s.strip().lstrip("/").split("/")[-1] or s.strip()


def cmd_post(args):
    pid = parse_post_id(args.id)
    params = {"limit": max(args.top * 2, 20), "depth": args.depth + 1, "sort": "top"}
    data = fetch(f"/comments/{pid}", params, args.ua)
    if not isinstance(data, list) or len(data) < 2:
        print(f"no data for post id={pid}", file=sys.stderr)
        sys.exit(1)
    children = data[0].get("data", {}).get("children", [])
    if not children:
        print(f"post {pid} not found", file=sys.stderr)
        sys.exit(1)
    post = children[0]["data"]
    comments = data[1].get("data", {}).get("children", [])
    if args.json:
        print(json.dumps({"post": post, "comments": comments}, indent=2))
        return
    print(fmt_post(post))
    print()
    print("---")
    print()
    print(f"## top {args.top} comments (depth {args.depth})")
    print()
    shown = 0
    link_re = re.compile(r"https?://[^\s)\]]+")
    links = []
    for c in comments:
        line = fmt_comment(c, 0, args.depth)
        if line:
            print(line)
            if args.links:
                links.extend(link_re.findall(line))
            shown += 1
            if shown >= args.top:
                break
    if shown == 0:
        print("(no comments)")
    if args.links and links:
        print()
        print("## links extracted from comments")
        # dedupe preserving order, drop reddit-internal
        seen = set()
        for u in links:
            if u in seen or "reddit.com" in u:
                continue
            seen.add(u)
            print(f"- {u}")


def cmd_user(args):
    params = {"limit": args.limit}
    data = fetch(f"/user/{args.username}/{args.kind}", params, args.ua)
    posts = extract_posts(data) if args.kind == "submitted" else [
        c["data"] for c in data.get("data", {}).get("children", [])
    ]
    if args.json:
        print(json.dumps(posts, indent=2))
        return
    print(f"# u/{args.username} — {args.kind}")
    print()
    if not posts:
        print("(no results)")
        return
    if args.kind == "submitted":
        for i, p in enumerate(posts, 1):
            print(fmt_post(p, i))
            print()
    else:
        for i, c in enumerate(posts, 1):
            body = trim((c.get("body") or "").replace("\n", " "), 300)
            sub = c.get("subreddit", "")
            score = c.get("score", 0)
            when = ago(c.get("created_utc"))
            perm = c.get("permalink", "")
            print(f"{i}. r/{sub} · {score}↑ · {when}")
            print(f"   {body}")
            print(f"   https://reddit.com{perm}")
            print()


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--ua", default=DEFAULT_UA, help="User-Agent header")
    common.add_argument("--json", action="store_true", help="raw JSON output")

    p = argparse.ArgumentParser(prog="reddit", description="Reddit CLI (stdlib, no auth)", parents=[common])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="search posts", parents=[common])
    s.add_argument("query")
    s.add_argument("--sub", help="restrict to subreddit")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--time", choices=["hour", "day", "week", "month", "year", "all"], default="all")
    s.add_argument("--sort", choices=["relevance", "hot", "top", "new", "comments"], default="relevance")
    s.set_defaults(fn=cmd_search)

    for ep in ("hot", "new", "top", "controversial", "rising"):
        sp = sub.add_parser(ep, help=f"{ep} posts in subreddit", parents=[common])
        sp.add_argument("subreddit")
        sp.add_argument("--limit", type=int, default=10)
        if ep in ("top", "controversial"):
            sp.add_argument("--time", choices=["hour", "day", "week", "month", "year", "all"], default="day")
        sp.set_defaults(fn=cmd_listing)

    pp = sub.add_parser("post", help="get a post + comments", parents=[common])
    pp.add_argument("id", help="post ID, full URL, or /r/.../comments/ID/...")
    pp.add_argument("--top", type=int, default=10, help="top N comments")
    pp.add_argument("--depth", type=int, default=2, help="max reply depth")
    pp.add_argument("--links", action="store_true", help="extract URLs from shown comments")
    pp.set_defaults(fn=cmd_post)

    up = sub.add_parser("user", help="user's recent posts or comments", parents=[common])
    up.add_argument("username")
    up.add_argument("--limit", type=int, default=10)
    up.add_argument("--kind", choices=["submitted", "comments"], default="submitted")
    up.set_defaults(fn=cmd_user)

    ip = sub.add_parser("info", help="subreddit metadata (about page)", parents=[common])
    ip.add_argument("subreddit")
    ip.set_defaults(fn=cmd_info)

    args = p.parse_args()
    try:
        args.fn(args)
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        hint = ""
        if e.code == 404:
            hint = " (subreddit/post not found, or sub is banned)"
        elif e.code == 403:
            hint = " (private, quarantined, or requires login)"
        elif e.code == 451:
            hint = " (legally restricted)"
        elif e.code == 429:
            hint = " (rate-limited; set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET for 6x cap)"
        print(f"reddit HTTP {e.code}{hint}: {body}", file=sys.stderr)
        sys.exit(2)
    except urllib.error.URLError as e:
        print(f"reddit network error: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
