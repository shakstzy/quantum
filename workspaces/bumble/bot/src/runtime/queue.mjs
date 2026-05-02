import { mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { OB_DRAFTS, OB_PENDING, OB_APPROVED, OB_SENT, OB_EXPIRED, OB_AUTO_SENT } from "./paths.mjs";

const STAGE_DIRS = {
  drafts: OB_DRAFTS,
  pending: OB_PENDING,
  approved: OB_APPROVED,
  sent: OB_SENT,
  expired: OB_EXPIRED,
  "auto-sent": OB_AUTO_SENT,
};

function fmFence(meta) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta)) lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  lines.push("---");
  return lines.join("\n");
}

function parseFm(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
      try { v = JSON.parse(v); } catch { /* keep string */ }
    }
    meta[k] = v;
  }
  return { meta, body: m[2] };
}

export async function writeQueueItem({ stage, id, meta, body }) {
  const dir = STAGE_DIRS[stage];
  if (!dir) throw new Error(`unknown stage: ${stage}`);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${id}.md`);
  await writeFile(path, `${fmFence(meta)}\n\n${body}\n`);
  return path;
}

export async function listQueue(stage) {
  const dir = STAGE_DIRS[stage];
  if (!dir) throw new Error(`unknown stage: ${stage}`);
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const items = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const path = resolve(dir, f);
    const content = await readFile(path, "utf8");
    const { meta, body } = parseFm(content);
    items.push({ id: f.replace(/\.md$/, ""), path, meta, body });
  }
  return items.sort((a, b) => (a.meta.created || "").localeCompare(b.meta.created || ""));
}

export async function moveQueueItem(id, fromStage, toStage) {
  const fromDir = STAGE_DIRS[fromStage];
  const toDir = STAGE_DIRS[toStage];
  if (!fromDir || !toDir) throw new Error(`unknown stage`);
  await mkdir(toDir, { recursive: true });
  const fromPath = resolve(fromDir, `${id}.md`);
  const toPath = resolve(toDir, `${id}.md`);
  await rename(fromPath, toPath);
  return toPath;
}

export async function readQueueItem(stage, id) {
  const dir = STAGE_DIRS[stage];
  const path = resolve(dir, `${id}.md`);
  const content = await readFile(path, "utf8");
  const { meta, body } = parseFm(content);
  return { id, path, meta, body };
}

export function extractDraftedReply(body) {
  const m = body.match(/##\s*Drafted reply\s*\n([\s\S]*?)(?:\n##|$)/);
  return m ? m[1].trim() : body.trim();
}

export async function expireOldPending() {
  const items = await listQueue("pending");
  const now = Date.now();
  let expired = 0;
  for (const it of items) {
    const exp = it.meta.expires;
    if (!exp) continue;
    if (new Date(exp).getTime() < now) {
      await moveQueueItem(it.id, "pending", "expired");
      expired += 1;
    }
  }
  return expired;
}
