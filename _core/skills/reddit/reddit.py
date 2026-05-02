#!/usr/bin/env python3
"""Reddit CLI for terse, context-friendly Reddit reads.

Stdlib only. Hits Reddit's public JSON API (read-only, no auth).
Default output is compact markdown; --json dumps cleaned structured data.

Subcommands: search, hot, new, top, post, user
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_UA = "reddit-cli/1.0 (read-only; ULTRON local)"
BASE = "https://www.reddit.com"


def fetch(path, params, ua):
    p = dict(params or {})
    p["raw_json"] = 1
    qs = "?" + urllib.parse.urlencode({k: v for k, v in p.items() if v is not None})
    url = f"{BASE}{path}.json{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                time.sleep(2 ** attempt)
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
    if endpoint == "top":
        params["t"] = args.time
    data = fetch(f"/r/{args.subreddit}/{endpoint}", params, args.ua)
    posts = extract_posts(data)
    if args.json:
        print(json.dumps(posts, indent=2))
        return
    suffix = f" ({args.time})" if endpoint == "top" else ""
    print(f"# r/{args.subreddit} — {endpoint}{suffix}")
    print()
    if not posts:
        print("(no results)")
        return
    for i, p in enumerate(posts, 1):
        print(fmt_post(p, i))
        print()


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
    for c in comments:
        line = fmt_comment(c, 0, args.depth)
        if line:
            print(line)
            shown += 1
            if shown >= args.top:
                break
    if shown == 0:
        print("(no comments)")


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
    p = argparse.ArgumentParser(prog="reddit", description="Reddit CLI (stdlib, no auth)")
    p.add_argument("--ua", default=DEFAULT_UA, help="User-Agent header")
    p.add_argument("--json", action="store_true", help="raw JSON output")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="search posts")
    s.add_argument("query")
    s.add_argument("--sub", help="restrict to subreddit")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--time", choices=["hour", "day", "week", "month", "year", "all"], default="all")
    s.add_argument("--sort", choices=["relevance", "hot", "top", "new", "comments"], default="relevance")
    s.set_defaults(fn=cmd_search)

    for ep in ("hot", "new", "top"):
        sp = sub.add_parser(ep, help=f"{ep} posts in subreddit")
        sp.add_argument("subreddit")
        sp.add_argument("--limit", type=int, default=10)
        if ep == "top":
            sp.add_argument("--time", choices=["hour", "day", "week", "month", "year", "all"], default="day")
        sp.set_defaults(fn=cmd_listing)

    pp = sub.add_parser("post", help="get a post + comments")
    pp.add_argument("id", help="post ID, full URL, or /r/.../comments/ID/...")
    pp.add_argument("--top", type=int, default=10, help="top N comments")
    pp.add_argument("--depth", type=int, default=2, help="max reply depth")
    pp.set_defaults(fn=cmd_post)

    up = sub.add_parser("user", help="user's recent posts or comments")
    up.add_argument("username")
    up.add_argument("--limit", type=int, default=10)
    up.add_argument("--kind", choices=["submitted", "comments"], default="submitted")
    up.set_defaults(fn=cmd_user)

    args = p.parse_args()
    try:
        args.fn(args)
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        print(f"reddit HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(2)
    except urllib.error.URLError as e:
        print(f"reddit network error: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
