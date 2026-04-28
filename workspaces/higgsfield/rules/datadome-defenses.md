# DataDome Defenses (canonical)

Empirically: a first Generate click on higgsfield.ai via stock chrome-devtools-mcp (CDP, `navigator.webdriver:true`, DevTools open) got 403 + captcha on 2026-04-21 within 1 second. Block reason in captcha iframe: "Use of developer or inspection tools", "Automated (bot) activity". This skill must defeat that detection.

## Layered defense

### 1. Binary level (patchright)

- `patchright@1.59.4` (Node fork of Playwright). Source-patched to never send `Runtime.enable` CDP command (DataDome's first filter). Executes JS in isolated ExecutionContexts.
- `launchPersistentContext({ userDataDir, channel: 'chrome', headless: false, viewport: {width:1440,height:900}, deviceScaleFactor: 2, colorScheme:'light', locale:'en-US', timezoneId:'America/Chicago' })`
- Real Google Chrome binary (not Chromium). DataDome fingerprints Chromium's unique WebGL renderer string.

### 2. Fingerprint level (page.addInitScript)

Applied at context creation, before any page loads:

- **navigator.webdriver** overridden to `undefined` (patchright does this by default; skill verifies).
- **navigator.plugins** and **navigator.mimeTypes** spoofed to real Chrome macOS baseline (`Chrome PDF Plugin`, `Chrome PDF Viewer`, `Native Client` plus their mime types).
- **navigator.permissions.query** override returning realistic mix (notifications=prompt, geolocation=prompt, camera=prompt, microphone=prompt, clipboard-read=granted if Chrome has been used for a while).
- **Canvas noise:** override `HTMLCanvasElement.prototype.toDataURL` and `CanvasRenderingContext2D.prototype.getImageData` to add 1-bit-per-pixel noise on a pseudo-random mask. Must be deterministic per session (same mask across calls) but different across sessions. Skip text canvases (detected heuristically) to avoid breaking Captcha image recognition or legit site UX.
- **AudioContext noise:** tiny constant offset on `AnalyserNode.prototype.getFloatFrequencyData` and `OfflineAudioContext.prototype.startRendering` output.
- **WebGL parameter jitter:** `WebGLRenderingContext.prototype.getParameter` returns unmodified for rare `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` (keeping Apple / Apple M2 strings consistent with real hardware), but slight jitter on `MAX_TEXTURE_SIZE`, `MAX_RENDERBUFFER_SIZE` to alter Picasso hash.
- **UA Client Hints consistency:** skill explicitly calls `navigator.userAgentData.getHighEntropyValues(['platformVersion','model','architecture','bitness','uaFullVersion','fullVersionList'])` once at init, records the result, and asserts that it matches the Sec-CH-UA headers Chrome sends. Mismatch aborts with a clear error before a single page load.

### 3. Behavioral level (behavior.mjs)

- **Bezier mouse paths.** Cubic Bezier curve with human-like velocity ramp (fast middle, slow endpoints, Fitts's law). 20-40 intermediate steps per move. Minimum 200ms per move; longer for greater pixel distance.
- **Dwell before click.** After arriving at target, pause 80-180ms (normal distribution around 120ms) before mouse-down. Another 40-90ms before mouse-up.
- **Typing cadence.** 160-240 WPM baseline. Per-char pauses drawn from a beta distribution skewed toward short. Intra-word pauses rare but possible (5% chance of 400-900ms pause mid-word, simulating a thought).
- **Scroll entropy.** When scrolling (e.g., through history or gallery), wheel events with decaying delta (starts at ~120, decays to ~30 over 4-8 wheel events). Never a single fixed-delta scroll.
- **Browse phase.** Before the first Generate click of a session on any given tool, the skill:
  1. Lands on the tool page
  2. Scrolls the gallery 2-4 beats (random direction mix)
  3. Hovers 1-3 unrelated nav items (`Explore`, `Pricing`, or a sibling tool) with 400-900ms dwell
  4. Dwells 1.5-4s looking at the results grid before moving toward the prompt textbox
  5. Types the prompt with realistic cadence
  6. Bezier-paths to Generate; dwells; clicks

### 4. Network level

- **Residential IP.** Plan-v2 default: home Austin IP (accept retry risk per Adithya). `HF_PROXY` env var supports `http://user:pass@host:port` for a residential proxy when enabled. VPN (datacenter IP) is worse than nothing; skill refuses to use a detected datacenter IP.
- **Cookie hygiene on 403.** On any 403 response from fnf.higgsfield.ai or the page: the skill deletes the `datadome=` cookie, resets canvas noise seed, writes state.json with `status=datadome_flagged`, and triggers the circuit breaker.
- **No parallel XHRs from the skill itself.** All in-page fetches go via `page.evaluate` from the same tab so DataDome's session cookies and behavioral context come along.
- **No direct Node fetch() to fnf.higgsfield.ai with auth.** Would lack DataDome session context. Exception: CloudFront downloads of generated assets go through Node fetch because those are signed public URLs with no auth required.

## Circuit breaker

State: `healthy` | `flagged` | `halted`.

- 1 x 403 or captcha visible in DOM: write `status=datadome_flagged`, halt current run, do NOT retry.
- 2 consecutive 403 or captcha events across runs within 24h: state advances to `halted`. Skill refuses to launch until the cooldown expires.
- Override: `--force` skips the halt check. Logged in state.json with `force_used=true`.
- Reset: `--reset-breaker` clears the halt after the user has personally solved the captcha on higgsfield.ai in their normal Chrome (restoring the IP reputation).

Breaker state file: `~/.quantum/chrome-profiles/higgsfield/.breaker.json`.

## Cadence configuration (env overrides)

| Env var | Default | Meaning |
|---------|---------|---------|
| `HF_TYPING_WPM_MIN` | 160 | Floor for typing speed |
| `HF_TYPING_WPM_MAX` | 240 | Ceiling for typing speed |
| `HF_JITTER_MS_MIN` | 300 | Min pause between discrete actions |
| `HF_JITTER_MS_MAX` | 900 | Max pause between discrete actions |
| `HF_BROWSE_PHASE` | 1 | Set to 0 to skip browse phase (NOT recommended in production) |
| `HF_PROXY` | (unset) | Optional proxy URL for patchright |
| `HF_DEBUG` | 0 | Set to 1 to keep browser open on error |

## Hard rules (no exceptions)

- Never log the JWT to any file or stdout line.
- Never log the DataDome cookie value.
- Never reuse a datadome cookie that was present at a 403 event.
- Never run two concurrent invocations on the same profile (pidfile enforced).
- Never parallelize across tools; sequential only.
- Never auto-retry on 403; breaker only.
