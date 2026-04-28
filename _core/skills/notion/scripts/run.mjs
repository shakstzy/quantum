#!/usr/bin/env node
// notion skill CLI. Native fetch, no deps. Token from macOS Keychain.
// Usage: node run.mjs <verb> [args...]
// Verbs: whoami, search, page-get, page-create, block-append, db-query, db-get

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const KEYCHAIN_SERVICE = "quantum-notion";
const ACCOUNT = process.env.NOTION_ACCOUNT || "default";
const NOTION_VERSION = process.env.NOTION_VERSION || "2022-06-28";
const API = "https://api.notion.com/v1";

function getToken() {
  try {
    return execFileSync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", ACCOUNT, "-w",
    ], { encoding: "utf8" }).trim();
  } catch {
    die(`No token in Keychain for service="${KEYCHAIN_SERVICE}" account="${ACCOUNT}".\nStore with:\n  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${ACCOUNT} -w "ntn_..." -U`);
  }
}

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}

function normalizeId(id) {
  if (!id) die("id required");
  const raw = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(raw)) die(`bad notion id: ${id} (expected 32 hex chars, dashed or not)`);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

async function notion(method, path, body) {
  const token = getToken();
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`notion ${method} ${path} ${res.status}: ${json.code || ""} ${json.message || text}`);
    err.body = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

async function paginate(method, path, body = {}, max = 1000) {
  const out = [];
  let cursor;
  for (;;) {
    const payload = { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const b = method === "GET"
      ? await notion("GET", path + (cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100"))
      : await notion(method, path, payload);
    out.push(...(b.results || []));
    if (!b.has_more || out.length >= max) break;
    cursor = b.next_cursor;
    if (!cursor) break;
  }
  return out.slice(0, max);
}

function readStdinSync() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

// Minimal markdown -> Notion blocks. Line-oriented. Supports:
// # / ## / ###  headings, "- " / "* " bullets, "1. " numbered, "> " quote, ``` code, blank = paragraph break.
// Everything else = paragraph text. Lines > 2000 chars get hard-split (Notion rich_text limit).
function mdToBlocks(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let inCode = false;
  let codeLang = "plain text";
  let codeBuf = [];
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    if (text) blocks.push(paragraph(text));
    para = [];
  };
  for (const rawLine of lines) {
    const line = rawLine;
    if (inCode) {
      if (line.trim() === "```") {
        blocks.push({
          object: "block", type: "code",
          code: { rich_text: rt(codeBuf.join("\n")), language: normalizeLang(codeLang) },
        });
        inCode = false; codeBuf = []; codeLang = "plain text";
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    if (line.startsWith("```")) { flushPara(); inCode = true; codeLang = line.slice(3).trim() || "plain text"; continue; }
    if (line.trim() === "") { flushPara(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flushPara(); blocks.push(heading(h[1].length, h[2])); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { flushPara(); blocks.push(listItem("bulleted_list_item", bullet[1])); continue; }
    const num = line.match(/^\s*\d+\.\s+(.*)$/);
    if (num) { flushPara(); blocks.push(listItem("numbered_list_item", num[1])); continue; }
    if (line.startsWith("> ")) { flushPara(); blocks.push({ object: "block", type: "quote", quote: { rich_text: rt(line.slice(2)) } }); continue; }
    para.push(line);
  }
  flushPara();
  if (inCode && codeBuf.length) blocks.push({ object: "block", type: "code", code: { rich_text: rt(codeBuf.join("\n")), language: normalizeLang(codeLang) } });
  return blocks;
}

function rt(text) {
  const CHUNK = 2000;
  const out = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    out.push({ type: "text", text: { content: text.slice(i, i + CHUNK) } });
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}
function paragraph(t) { return { object: "block", type: "paragraph", paragraph: { rich_text: rt(t) } }; }
function heading(level, t) { const key = `heading_${level}`; return { object: "block", type: key, [key]: { rich_text: rt(t) } }; }
function listItem(kind, t) { return { object: "block", type: kind, [kind]: { rich_text: rt(t) } }; }
function normalizeLang(l) {
  const ok = new Set(["abap","arduino","bash","basic","c","clojure","coffeescript","c++","c#","css","dart","diff","docker","elixir","elm","erlang","flow","fortran","f#","gherkin","glsl","go","graphql","groovy","haskell","html","java","javascript","json","julia","kotlin","latex","less","lisp","livescript","lua","makefile","markdown","markup","matlab","mermaid","nix","objective-c","ocaml","pascal","perl","php","plain text","powershell","prolog","protobuf","python","r","reason","ruby","rust","sass","scala","scheme","scss","shell","sql","swift","typescript","vb.net","verilog","vhdl","visual basic","webassembly","xml","yaml"]);
  const lc = (l || "plain text").toLowerCase();
  if (ok.has(lc)) return lc;
  if (lc === "ts") return "typescript";
  if (lc === "js") return "javascript";
  if (lc === "sh" || lc === "zsh") return "bash";
  if (lc === "py") return "python";
  return "plain text";
}

async function whoami() {
  const b = await notion("GET", "/users/me");
  console.log(JSON.stringify({
    ok: true, bot_id: b.id, name: b.name,
    workspace: b.bot?.workspace_name, workspace_id: b.bot?.workspace_id,
    notion_version: NOTION_VERSION, account: ACCOUNT,
  }, null, 2));
}

async function search(argv) {
  const filterIdx = argv.indexOf("--filter");
  const filter = filterIdx >= 0 ? argv[filterIdx + 1] : null;
  const query = argv.filter((a, i) => i !== filterIdx && i !== filterIdx + 1).join(" ");
  const body = { query, page_size: 20 };
  if (filter === "page" || filter === "database") body.filter = { property: "object", value: filter };
  const b = await notion("POST", "/search", body);
  const hits = (b.results || []).map(r => ({
    id: r.id,
    object: r.object,
    title: extractTitle(r),
    url: r.url,
    last_edited: r.last_edited_time,
    parent: r.parent,
    archived: r.archived,
  }));
  console.log(JSON.stringify({ query, filter, count: hits.length, hits }, null, 2));
}

function extractTitle(r) {
  if (r.object === "database") {
    return (r.title || []).map(t => t.plain_text).join("") || "(untitled db)";
  }
  const props = r.properties || {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === "title") return (p.title || []).map(t => t.plain_text).join("") || "(untitled)";
  }
  return "(untitled)";
}

async function pageGet(argv) {
  const id = normalizeId(argv[0]);
  const includeChildren = !argv.includes("--no-children");
  const page = await notion("GET", `/pages/${id}`);
  const out = {
    id: page.id,
    title: extractTitle(page),
    url: page.url,
    parent: page.parent,
    created: page.created_time,
    last_edited: page.last_edited_time,
    archived: page.archived,
    properties: page.properties,
  };
  if (includeChildren) out.children = await fetchChildrenRecursive(id);
  console.log(JSON.stringify(out, null, 2));
}

async function fetchChildrenRecursive(blockId, depth = 0, maxDepth = 3) {
  const children = await paginate("GET", `/blocks/${blockId}/children`);
  const out = [];
  for (const c of children) {
    const item = { id: c.id, type: c.type, text: blockText(c) };
    if (c.has_children && depth < maxDepth) item.children = await fetchChildrenRecursive(c.id, depth + 1, maxDepth);
    out.push(item);
  }
  return out;
}

function blockText(block) {
  const t = block[block.type];
  if (!t) return "";
  if (Array.isArray(t.rich_text)) return t.rich_text.map(r => r.plain_text).join("");
  if (Array.isArray(t.title)) return t.title.map(r => r.plain_text).join("");
  if (typeof t.title === "string") return t.title;  // child_page, child_database
  return "";
}

async function pageCreate(argv) {
  const [parentId, ...titleParts] = argv;
  const title = titleParts.join(" ");
  if (!parentId || !title) die("usage: page-create <parent-page-id> <title>  (body markdown on stdin, optional)");
  const parent = normalizeId(parentId);
  const bodyMd = process.stdin.isTTY ? "" : readStdinSync();
  const children = bodyMd ? mdToBlocks(bodyMd).slice(0, 100) : [];
  const payload = {
    parent: { page_id: parent },
    properties: { title: { title: rt(title) } },
    ...(children.length ? { children } : {}),
  };
  const b = await notion("POST", "/pages", payload);
  console.log(JSON.stringify({ ok: true, id: b.id, url: b.url, title }, null, 2));
}

async function blockAppend(argv) {
  const id = normalizeId(argv[0]);
  const bodyMd = process.stdin.isTTY ? argv.slice(1).join("\n") : readStdinSync();
  if (!bodyMd.trim()) die("markdown body required (argv or stdin)");
  const blocks = mdToBlocks(bodyMd);
  if (!blocks.length) die("no blocks parsed from input");
  let appended = 0;
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    await notion("PATCH", `/blocks/${id}/children`, { children: batch });
    appended += batch.length;
  }
  console.log(JSON.stringify({ ok: true, block_id: id, appended }, null, 2));
}

async function dbQuery(argv) {
  const id = normalizeId(argv[0]);
  const filterIdx = argv.indexOf("--filter");
  const sortIdx = argv.indexOf("--sort");
  const maxIdx = argv.indexOf("--max");
  const body = {};
  if (filterIdx >= 0) body.filter = JSON.parse(argv[filterIdx + 1]);
  if (sortIdx >= 0) body.sorts = JSON.parse(argv[sortIdx + 1]);
  const max = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 100;
  const results = await paginate("POST", `/databases/${id}/query`, body, max);
  const rows = results.map(r => ({
    id: r.id,
    url: r.url,
    last_edited: r.last_edited_time,
    properties: simplifyProps(r.properties),
  }));
  console.log(JSON.stringify({ database_id: id, count: rows.length, rows }, null, 2));
}

function simplifyProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    switch (v.type) {
      case "title": out[k] = (v.title || []).map(t => t.plain_text).join(""); break;
      case "rich_text": out[k] = (v.rich_text || []).map(t => t.plain_text).join(""); break;
      case "number": out[k] = v.number; break;
      case "select": out[k] = v.select?.name ?? null; break;
      case "multi_select": out[k] = (v.multi_select || []).map(s => s.name); break;
      case "date": out[k] = v.date ? { start: v.date.start, end: v.date.end } : null; break;
      case "checkbox": out[k] = v.checkbox; break;
      case "url": out[k] = v.url; break;
      case "email": out[k] = v.email; break;
      case "phone_number": out[k] = v.phone_number; break;
      case "people": out[k] = (v.people || []).map(p => ({ id: p.id, name: p.name })); break;
      case "relation": out[k] = (v.relation || []).map(r => r.id); break;
      case "status": out[k] = v.status?.name ?? null; break;
      case "created_time": out[k] = v.created_time; break;
      case "last_edited_time": out[k] = v.last_edited_time; break;
      default: out[k] = { type: v.type, raw: v };
    }
  }
  return out;
}

async function dbGet(argv) {
  const id = normalizeId(argv[0]);
  const b = await notion("GET", `/databases/${id}`);
  console.log(JSON.stringify({
    id: b.id,
    title: (b.title || []).map(t => t.plain_text).join(""),
    url: b.url,
    parent: b.parent,
    properties: Object.fromEntries(Object.entries(b.properties || {}).map(([k, v]) => [k, v.type])),
    last_edited: b.last_edited_time,
  }, null, 2));
}

const [, , verb, ...argv] = process.argv;
const verbs = {
  whoami,
  search,
  "page-get": pageGet,
  "page-create": pageCreate,
  "block-append": blockAppend,
  "db-query": dbQuery,
  "db-get": dbGet,
};

if (!verb || !verbs[verb]) {
  console.error(`Usage: node run.mjs <verb> [args...]
Verbs:
  whoami
  search <query...> [--filter page|database]
  page-get <id> [--no-children]
  page-create <parent-page-id> <title...>       (body markdown on stdin)
  block-append <page-or-block-id> [markdown...]  (or markdown on stdin)
  db-query <database-id> [--filter <json>] [--sort <json>] [--max N]
  db-get <database-id>

Env:
  NOTION_ACCOUNT     keychain account name (default: "default")
  NOTION_VERSION     Notion-Version header (default: 2022-06-28)

Notes:
  Integration only sees pages/databases you explicitly Connect to it
  (page ... Connections ... your integration). Searches and gets return
  404/empty for un-Connected resources.`);
  process.exit(verb ? 2 : 0);
}

try {
  await verbs[verb](argv);
} catch (e) {
  die(`[error] ${e.message}`, 1);
}
