# Output Conventions (canonical)

Where files land. What metadata records. How resume works.

## Folder layout

Per-run output directory:

```
~/.quantum/skill-output/higgsfield/<YYYYMMDD-HHMMSS>-<slug>/
├── state.json         always present; state machine record
├── metadata.json      written on success; one per gen
├── <native-filename>  the downloaded asset; preserves higgsfield's native name
└── <native-filename>.partial   transient during download; removed on success
```

Stage override: when invoked from a stage, skill writes to `<stage>/output/higgsfield-<timestamp-slug>/` instead.

Slug rule: 3-6 lowercase hyphen-separated words derived from the prompt (first 60 chars, stripped to alphanum-and-spaces, spaces to hyphens, max 60 chars).

## state.json schema

Always written, atomically (write to `state.json.tmp`, then rename).

```json
{
  "schema_version": 1,
  "run_id": "20260421-053001-green-apple",
  "cmd": "image",
  "model_frontend": "nano-banana-pro",
  "model_backend": "nano_banana_2",
  "tool_url": "https://higgsfield.ai/ai/image?model=nano-banana-pro",
  "prompt": "...",
  "params": { "aspect_ratio": "3:4", "resolution": "1k", "batch_size": 1 },
  "cost_credits_expected": 2,
  "cost_credits_actual": null,
  "idempotency_key": "01J...ULID",
  "job_uuid": null,
  "status": "pending",
  "created_at": "2026-04-21T05:30:01.123Z",
  "updated_at": "2026-04-21T05:30:01.123Z",
  "attempts": 1,
  "last_error": null,
  "force_used": false,
  "notes": []
}
```

Status transitions (legal paths):
- `pending` -> `submitted` -> `polling` -> `downloading` -> `saved`
- `pending` -> `aborted_precheck`
- any -> `failed`
- `polling` -> `timeout`
- any -> `datadome_flagged` (breaker tripped)

Never writes the JWT. Never writes the CloudFront URL. Never writes the datadome cookie.

## metadata.json schema (written on status=saved)

```json
{
  "schema_version": 1,
  "run_id": "20260421-053001-green-apple",
  "cmd": "image",
  "model_frontend": "nano-banana-pro",
  "model_backend": "nano_banana_2",
  "prompt": "...",
  "params": { "aspect_ratio": "3:4", "resolution": "1k", "batch_size": 1 },
  "job_uuid": "b4e6c5...uuid",
  "filename_on_cdn": "hf_20260421_053125_<uuid>.webp",
  "local_path": "/Users/shakstzy/.quantum/skill-output/higgsfield/20260421-053001-green-apple/hf_20260421_053125_<uuid>.webp",
  "bytes": 524288,
  "content_type": "image/webp",
  "sha256": "a1b2c3...hex",
  "duration_seconds": null,
  "cost_credits_actual": 2,
  "wallet_before": 5885.93,
  "wallet_after": 5883.93,
  "timestamp": "2026-04-21T05:31:28.456Z"
}
```

`duration_seconds` only for videos.

## Download rules

- Write to `<final>.partial` first.
- Verify Content-Length matches bytes written. If mismatch: delete partial, retry once, then mark `download_failed` in state.json with the mismatch recorded.
- Rename `.partial` to final only after verify passes.
- Compute SHA-256 of the final file for metadata.json (streaming, no double-read).

## Resume semantics

`node scripts/run.mjs resume <run-dir>` reads state.json and picks up at the next transition:

- `status=pending` or absent: full re-run, idempotency_key reused if submit POST returned 202/200 but UUID wasn't captured (server-side deduplication, best-effort).
- `status=submitted`: skip submit, start polling with known UUID.
- `status=polling`: continue polling; check breaker before resuming.
- `status=downloading`: retry download only.
- `status=saved`: report already-saved, exit 0.
- `status=failed`, `status=timeout`, `status=datadome_flagged`: refuse to resume without `--force`; user must explicitly accept.

## Cleanup

- `.partial` files older than 24h are auto-cleaned on next `run.mjs` invocation.
- `state.json` is never auto-deleted.
- Skill does not delete successfully-saved output directories. User's responsibility.

## Git and backup

- `~/.quantum/` is not in any git repo (out-of-tree by design).
- Recommend excluding `~/.quantum/` from cloud backups (iCloud Desktop sync, Dropbox). state.json and chrome-profile contain session-derived secrets.
- Chrome profile directory is `chmod 700` by the login script on first run.
