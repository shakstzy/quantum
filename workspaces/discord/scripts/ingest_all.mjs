#!/usr/bin/env node
// ingest_all.mjs -- Discord DM ingest into raw/discord/.
//
// Pipeline per cron tick:
//   1. Open ONE Chrome session via the discord skill (CDP token capture).
//   2. List DM + group-DM channels.
//   3. For each channel: backfill (first run, last 30 days) OR incremental
//      (since stored last_message_id). Paced realistically.
//   4. Pre-filter bots and system messages -> review-list directly.
//   5. Batch remaining new messages through Gemma (local-llm skill) for
//      significance scoring. SIGNIFICANT -> month shard, NOISE -> review-list.
//   6. Update watermarks atomically. Append-only writes. Raw is immutable.
//
// Flags:
//   --dry-run    Print what would land, write nothing, leave watermarks alone
//   --max-channels=N   Cap channels per run (default unlimited)
//   --backfill-days=N  Override backfill horizon (default 30)
//   --no-gemma   Skip Gemma scoring; everything new goes to month shard
//                (use only for fixture-based dev or if Gemma daemon down)

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANTUM_ROOT = resolve(HERE, '..', '..', '..');
const SKILL_DIR = join(QUANTUM_ROOT, '_core', 'skills', 'discord');
const LOCAL_LLM_DIR = join(QUANTUM_ROOT, '_core', 'skills', 'local-llm');
const RAW_DIR = join(QUANTUM_ROOT, 'raw', 'discord');
const LOG_DIR = join(QUANTUM_ROOT, 'raw', '.ingest-log');
const WATERMARK_FILE = join(LOG_DIR, 'discord.channels.json');
const SIGNIFICANCE_LOG = join(LOG_DIR, 'discord.significance.ndjson');
const REVIEW_FILE = join(RAW_DIR, '_review-list.ndjson');
const FIXTURE_DIR = join(HERE, '..', '.dev-fixtures');

const args = parseArgs(process.argv.slice(2));
const DRY_RUN = !!args.flags['dry-run'];
const NO_GEMMA = !!args.flags['no-gemma'];
const MAX_CHANNELS = args.flags['max-channels'] ? Number(args.flags['max-channels']) : Infinity;
const BACKFILL_DAYS = args.flags['backfill-days'] ? Number(args.flags['backfill-days']) : 30;
const FIXTURE_MODE = !!args.flags['fixture'];

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function log(msg) { process.stderr.write(`[discord-ingest] ${msg}\n`); }

function jitter(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(r => setTimeout(r, ms));
}

function ensureDirs() {
  for (const d of [RAW_DIR, LOG_DIR, FIXTURE_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function readWatermarks() {
  if (!existsSync(WATERMARK_FILE)) return {};
  try { return JSON.parse(readFileSync(WATERMARK_FILE, 'utf8')); }
  catch { return {}; }
}

function writeWatermarks(obj) {
  writeFileSync(WATERMARK_FILE, JSON.stringify(obj, null, 2));
}

// Filesystem-safe slug for friend usernames. Discord usernames are already
// `[a-z0-9._]+` since the 2023 unique-username migration, but we sanitize
// anyway to defend against legacy handles or surprise unicode.
function slugify(s) {
  return (s || 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60);
}

// One file per conversation. Self-describing via a header line written once at
// file creation; subsequent pulls append messages only. Graphify clusters
// per-conversation, so file boundary = relationship boundary.
function channelFilePath(channelMeta, channelId) {
  if (channelMeta.kind === 'dm') {
    const friend = channelMeta.recipients?.[0];
    const slug = slugify(friend?.username || friend?.global_name || channelId);
    return join(RAW_DIR, 'dms', `${slug}--${channelId}.ndjson`);
  }
  return join(RAW_DIR, 'group-dms', `${channelId}.ndjson`);
}

function ensureChannelHeader(filePath, channelMeta, channelId) {
  if (existsSync(filePath)) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const header = {
    _type: 'channel_header',
    id: channelId,
    kind: channelMeta.kind,
    recipients: channelMeta.recipients,
    created_at: new Date().toISOString()
  };
  writeFileSync(filePath, JSON.stringify(header) + '\n');
}

function snowflakeToMs(id) {
  // Discord snowflake: ms since 2015-01-01 in upper 42 bits
  const DISCORD_EPOCH = 1420070400000n;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function snowflakeFromMs(ms) {
  const DISCORD_EPOCH = 1420070400000n;
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}

// Trim Discord message to graphify-relevant fields. Preserves full fidelity for
// content + author + threading; drops embed bloat, mentions arrays we don't
// need, etc. Channel meta lives in the file's header line, not on every msg.
function trimMessage(m) {
  const trimmed = {
    _type: 'message',
    id: m.id,
    channel_id: m.channel_id,
    timestamp: m.timestamp,
    edited_timestamp: m.edited_timestamp || null,
    type: m.type,
    author: {
      id: m.author?.id,
      username: m.author?.username,
      global_name: m.author?.global_name,
      bot: !!m.author?.bot
    },
    content: m.content || ''
  };
  if (m.attachments?.length) {
    trimmed.has_attachment = true;
    trimmed.attachments = m.attachments.map(a => ({
      id: a.id, filename: a.filename, url: a.url, size: a.size,
      content_type: a.content_type
    }));
  }
  if (m.referenced_message?.id) trimmed.reply_to = m.referenced_message.id;
  if (m.sticker_items?.length) trimmed.stickers = m.sticker_items.map(s => s.name);
  if (m.flags) trimmed.flags = m.flags;
  return trimmed;
}

// Cheap pre-filter: bots and non-default messages auto-route to review without
// burning Gemma cycles.
function preFilter(msg) {
  if (msg.author?.bot) return { skip: true, reason: 'bot_author' };
  // type 0 = DEFAULT, 19 = REPLY. Anything else (calls, joins, pins, system) is meta.
  if (msg.type !== 0 && msg.type !== 19) return { skip: true, reason: `system_type_${msg.type}` };
  // empty content + no attachment + no sticker = nothing to learn from
  const hasContent = (msg.content && msg.content.trim().length > 0);
  const hasAttach = msg.attachments?.length > 0 || msg.sticker_items?.length > 0;
  if (!hasContent && !hasAttach) return { skip: true, reason: 'empty' };
  return { skip: false };
}

async function scoreBatchWithGemma(askGemma, messages) {
  if (NO_GEMMA) return messages.map(m => ({ id: m.id, class: 'SIGNIFICANT', reason: 'gemma_skipped' }));
  if (messages.length === 0) return [];
  const prompt = [
    `You classify Discord messages for a personal knowledge graph.`,
    ``,
    `SIGNIFICANT = real conversation: people, places, projects, decisions, ideas, plans, opinions, events, work, relationships, technical discussion, news, questions worth answering, recommendations, anything that helps understand a person's life.`,
    ``,
    `NOISE = low-content fillers: "lol", "k", "ok", "nice", "yeah", single emoji, single reaction word, "gm"/"gn"/"ttyl", short laughter, link without context, sticker without text, gif drop, throwaway acknowledgements that carry no information.`,
    ``,
    `Bias: when the message clearly carries a fact, opinion, or question, mark SIGNIFICANT. When it is a content-free filler that adds nothing without prior context, mark NOISE.`,
    ``,
    `Reply with ONLY a JSON array, one object per input message in the same order:`,
    `[{"id": "<message_id>", "class": "SIGNIFICANT" | "NOISE", "reason": "<5 words max>"}]`,
    ``,
    `Messages to classify:`,
    JSON.stringify(messages.map(m => ({
      id: m.id,
      author: m.author?.global_name || m.author?.username || 'unknown',
      content: (m.content || '').slice(0, 400),
      has_attachment: !!m.attachments?.length || !!m.sticker_items?.length
    })), null, 2)
  ].join('\n');

  let raw;
  try {
    raw = await askGemma(prompt, { maxTokens: 1024, temperature: 0 });
  } catch (e) {
    log(`gemma error, falling back to KEEP: ${e.message}`);
    return messages.map(m => ({ id: m.id, class: 'SIGNIFICANT', reason: 'gemma_error_keep' }));
  }
  // Tolerant JSON parsing - Gemma sometimes wraps in markdown fences.
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log(`gemma returned non-JSON, falling back to KEEP`);
    return messages.map(m => ({ id: m.id, class: 'SIGNIFICANT', reason: 'gemma_parse_keep' }));
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const byId = new Map(parsed.map(p => [p.id, p]));
    return messages.map(m => byId.get(m.id) || { id: m.id, class: 'SIGNIFICANT', reason: 'gemma_missing_keep' });
  } catch (e) {
    log(`gemma JSON parse failed, falling back to KEEP: ${e.message}`);
    return messages.map(m => ({ id: m.id, class: 'SIGNIFICANT', reason: 'gemma_parsefail_keep' }));
  }
}

// Pull paginated messages from a channel. Used both for backfill and incremental.
async function pullChannelMessages(sess, channelId, { afterId = null, beforeMs = null, limit = 100, maxPages = 50 }) {
  const out = [];
  let cursor = afterId;
  for (let page = 0; page < maxPages; page++) {
    const query = { limit: String(limit) };
    if (cursor) query.after = cursor;
    const batch = await sess.call('GET', `/api/v9/channels/${channelId}/messages`, { query });
    if (!Array.isArray(batch) || batch.length === 0) break;
    // Discord returns newest-first. Reverse so we walk forward in time.
    const ordered = batch.slice().reverse();
    for (const m of ordered) {
      if (beforeMs && snowflakeToMs(m.id) < beforeMs) continue;
      out.push(m);
    }
    cursor = ordered[ordered.length - 1].id;
    // Within-channel pacing.
    await jitter(5000, 15000);
    if (batch.length < limit) break;
  }
  return out;
}

async function loadAskGemma() {
  const helpers = await import(join(LOCAL_LLM_DIR, 'scripts', 'gemma-helpers.mjs'));
  return helpers.askGemma;
}

async function main() {
  ensureDirs();

  const watermarks = readWatermarks();
  const isFirstRun = Object.keys(watermarks).length === 0;
  const backfillCutoffMs = isFirstRun ? Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000 : null;
  log(`mode: ${DRY_RUN ? 'DRY-RUN' : 'WRITE'} | gemma: ${NO_GEMMA ? 'OFF' : 'ON'} | first_run: ${isFirstRun} | backfill_days: ${isFirstRun ? BACKFILL_DAYS : 'N/A (incremental)'}`);

  // Load discord skill session.
  const { launchContext, pageApi, waitForCapturedToken } = await import(join(SKILL_DIR, 'scripts', 'browser.mjs'));
  const askGemma = NO_GEMMA ? null : await loadAskGemma();

  log('booting Chrome session...');
  const ctx = await launchContext({ visible: false });
  let stats = { channels: 0, msgs_pulled: 0, msgs_significant: 0, msgs_noise: 0, msgs_prefilter: 0, errors: 0 };
  try {
    await ctx.page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const tok = await waitForCapturedToken(ctx, { timeoutMs: 60000, probeEveryMs: 500 });
    if (!tok) {
      log('FATAL: no token captured; session expired. Run: node _core/skills/discord/scripts/run.mjs login');
      process.exit(3);
    }

    const call = async (method, path, opts = {}) => {
      const liveTok = ctx.getCapturedToken() || tok;
      // Lightweight in-flight retry loop for 429.
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await pageApi(ctx.page, method, path, { ...opts, token: liveTok });
        if (res.status === 429) {
          const retry = (res.body && res.body.retry_after) || 2;
          log(`429; sleeping ${retry}s`);
          await new Promise(r => setTimeout(r, retry * 1000));
          continue;
        }
        if (res.status === 401) {
          log('FATAL: 401 mid-pull. Token invalidated.');
          process.exit(3);
        }
        if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
        return res.body;
      }
      throw new Error(`${method} ${path}: rate-limited repeatedly, giving up`);
    };
    // Wrap into the shape pullChannelMessages expects.
    const sess = { call };

    log('listing DM + group-DM channels...');
    const channels = await call('GET', '/api/v9/users/@me/channels');
    const dms = (channels || []).filter(c => c.type === 1 || c.type === 3);
    log(`found ${dms.length} DM/group-DM channels`);

    let processed = 0;
    for (const ch of dms) {
      if (processed >= MAX_CHANNELS) { log(`max-channels cap hit (${MAX_CHANNELS}), stopping`); break; }
      processed++;
      stats.channels++;
      const channelMeta = {
        kind: ch.type === 1 ? 'dm' : 'group_dm',
        recipients: (ch.recipients || []).map(r => ({
          id: r.id, username: r.username, global_name: r.global_name
        }))
      };
      const friendName = ch.type === 1
        ? (ch.recipients?.[0]?.global_name || ch.recipients?.[0]?.username || ch.id)
        : `group(${(ch.recipients || []).map(r => r.username).join(',')})`;

      const watermark = watermarks[ch.id];
      const afterId = watermark || (backfillCutoffMs ? snowflakeFromMs(backfillCutoffMs) : null);

      log(`[${processed}/${dms.length}] ${friendName} (${ch.id}) | ${watermark ? 'incremental from ' + watermark : 'backfill ' + BACKFILL_DAYS + 'd'}`);

      let pulled;
      try {
        pulled = await pullChannelMessages(sess, ch.id, { afterId, beforeMs: null });
      } catch (e) {
        log(`  error: ${e.message}; skipping`);
        stats.errors++;
        await jitter(30000, 60000);
        continue;
      }

      stats.msgs_pulled += pulled.length;
      if (pulled.length === 0) {
        log(`  no new messages`);
        // Still pace between channels even if nothing came back.
        await jitter(isFirstRun ? 30000 : 1500, isFirstRun ? 60000 : 3000);
        continue;
      }

      // Pre-filter.
      const toScore = [];
      const prefiltered = [];
      for (const m of pulled) {
        const pf = preFilter(m);
        if (pf.skip) prefiltered.push({ msg: m, reason: pf.reason });
        else toScore.push(m);
      }
      stats.msgs_prefilter += prefiltered.length;

      // Score with Gemma in batches of 20.
      const scores = [];
      for (let i = 0; i < toScore.length; i += 20) {
        const batch = toScore.slice(i, i + 20);
        const batchScores = await scoreBatchWithGemma(askGemma, batch);
        scores.push(...batchScores);
      }
      const scoreById = new Map(scores.map(s => [s.id, s]));

      // Route + write. Sort chronologically so per-channel files stay ordered.
      const ordered = pulled.slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const channelFile = channelFilePath(channelMeta, ch.id);
      let newest = watermark || '0';
      let headerEnsured = false;

      for (const m of ordered) {
        if (BigInt(m.id) > BigInt(newest)) newest = m.id;
        const trimmed = trimMessage(m);
        const pf = preFilter(m);
        let cls, reason;
        if (pf.skip) { cls = 'NOISE'; reason = pf.reason; }
        else {
          const sc = scoreById.get(m.id) || { class: 'SIGNIFICANT', reason: 'fallback_keep' };
          cls = sc.class === 'NOISE' ? 'NOISE' : 'SIGNIFICANT';
          reason = sc.reason;
        }
        if (cls === 'SIGNIFICANT') stats.msgs_significant++; else stats.msgs_noise++;

        const sigEntry = { ts: new Date().toISOString(), channel_id: ch.id, message_id: m.id, class: cls, reason };

        if (DRY_RUN) {
          const sampleAuthor = trimmed.author?.global_name || trimmed.author?.username || 'unknown';
          const sampleContent = (trimmed.content || '').slice(0, 100).replace(/\n/g, ' ');
          const target = cls === 'SIGNIFICANT' ? channelFile.replace(QUANTUM_ROOT, '.') : REVIEW_FILE.replace(QUANTUM_ROOT, '.');
          process.stdout.write(`${cls.padEnd(11)} | ${sampleAuthor.slice(0, 14).padEnd(14)} | ${reason.padEnd(20).slice(0, 20)} | ${target.slice(-50)} | ${sampleContent}\n`);
        } else {
          if (cls === 'SIGNIFICANT') {
            if (!headerEnsured) { ensureChannelHeader(channelFile, channelMeta, ch.id); headerEnsured = true; }
            appendFileSync(channelFile, JSON.stringify(trimmed) + '\n');
          } else {
            appendFileSync(REVIEW_FILE, JSON.stringify({ ...trimmed, _routed_from: ch.id, _route_reason: reason }) + '\n');
          }
          appendFileSync(SIGNIFICANCE_LOG, JSON.stringify(sigEntry) + '\n');
        }
      }

      // Update watermark.
      if (!DRY_RUN) {
        watermarks[ch.id] = newest;
        writeWatermarks(watermarks);
      }

      // Inter-channel pace.
      await jitter(isFirstRun ? 30000 : 1500, isFirstRun ? 60000 : 3000);
    }
  } finally {
    await ctx.close();
  }

  log(`done. channels=${stats.channels} pulled=${stats.msgs_pulled} significant=${stats.msgs_significant} noise=${stats.msgs_noise} prefiltered=${stats.msgs_prefilter} errors=${stats.errors}`);
}

main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });
