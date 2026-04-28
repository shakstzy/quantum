// behavior.mjs -- human-cadence helpers: bezier mouse, typing, scroll entropy, browse phase

const WPM_MIN = parseInt(process.env.HF_TYPING_WPM_MIN || '160', 10);
const WPM_MAX = parseInt(process.env.HF_TYPING_WPM_MAX || '240', 10);
const JITTER_MIN = parseInt(process.env.HF_JITTER_MS_MIN || '300', 10);
const JITTER_MAX = parseInt(process.env.HF_JITTER_MS_MAX || '900', 10);
const DO_BROWSE = process.env.HF_BROWSE_PHASE !== '0';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function rand(min, max) {
  return min + Math.random() * (max - min);
}

export function jitter() {
  return Math.round(rand(JITTER_MIN, JITTER_MAX));
}

export async function pause(ms) {
  await sleep(Math.max(0, ms));
}

export async function pauseJitter() {
  await sleep(jitter());
}

// Cubic Bezier mouse move. Velocity ramp approximates Fitts's law:
// fast middle, slow endpoints.
export async function moveMouseBezier(page, from, to, steps = null) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const n = steps ?? Math.max(20, Math.min(60, Math.round(distance / 10)));
  // Two control points between from and to; offset perpendicular to line for curve.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const perp = { x: -dy, y: dx };
  const perpLen = Math.hypot(perp.x, perp.y) || 1;
  const offset = rand(-distance * 0.12, distance * 0.12);
  const c1 = { x: from.x + dx * 0.33 + perp.x / perpLen * offset, y: from.y + dy * 0.33 + perp.y / perpLen * offset };
  const c2 = { x: from.x + dx * 0.66 + perp.x / perpLen * offset * 0.6, y: from.y + dy * 0.66 + perp.y / perpLen * offset * 0.6 };
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const x = mt*mt*mt*from.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*to.x;
    const y = mt*mt*mt*from.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*to.y;
    await page.mouse.move(x, y);
    // Velocity ramp: dwell longer near endpoints
    const ramp = 1 - Math.abs(t - 0.5) * 1.8;
    const dwell = 4 + ramp * 10 + (Math.random() < 0.1 ? rand(5, 25) : 0);
    await sleep(dwell);
  }
}

// Hover then click with dwell before and after
export async function humanClick(page, selector, options = {}) {
  const el = typeof selector === 'string' ? await page.waitForSelector(selector, { state: 'visible', timeout: 10000 }) : selector;
  const box = await el.boundingBox();
  if (!box) throw new Error('Element not visible for click');
  // Current mouse position: fetch via page.evaluate since patchright/playwright doesn't expose it directly
  const currentPos = await page.evaluate(() => ({ x: window.__lastMouseX || 100, y: window.__lastMouseY || 100 }));
  const target = {
    x: box.x + box.width * rand(0.3, 0.7),
    y: box.y + box.height * rand(0.3, 0.7)
  };
  await moveMouseBezier(page, currentPos, target);
  await page.evaluate(t => { window.__lastMouseX = t.x; window.__lastMouseY = t.y; }, target);
  await sleep(rand(80, 180)); // dwell before press
  await page.mouse.down();
  await sleep(rand(40, 90));
  await page.mouse.up();
}

export async function typeHuman(page, selector, text) {
  const el = await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
  await humanClick(page, el);
  await sleep(rand(150, 400));
  // WPM conversion: avg 5 chars per word, so chars/sec = wpm * 5 / 60
  for (const ch of text) {
    const wpm = rand(WPM_MIN, WPM_MAX);
    const msPerChar = 60000 / (wpm * 5);
    // Random fluctuation per char
    const perChar = msPerChar * rand(0.6, 1.6);
    await page.keyboard.type(ch, { delay: 0 });
    await sleep(perChar);
    // 5% chance of short thought-pause
    if (Math.random() < 0.05) await sleep(rand(400, 900));
  }
}

export async function wheelBurst(page, totalDelta) {
  // Decaying wheel deltas: start high, decay over 4-8 ticks
  const ticks = Math.floor(rand(4, 8));
  let remaining = totalDelta;
  for (let i = 0; i < ticks && Math.abs(remaining) > 1; i++) {
    const ratio = Math.pow(0.6, i);
    const d = Math.round(remaining * ratio * 0.6);
    await page.mouse.wheel(0, d);
    remaining -= d;
    await sleep(rand(80, 220));
  }
}

// Browse phase: gentle exploration before first gen on a tool page
export async function browsePhase(page) {
  if (!DO_BROWSE) return;
  // 1. Initial dwell
  await sleep(rand(1500, 4000));
  // 2. Scroll gallery 2-4 beats mixed direction
  const beats = Math.floor(rand(2, 4));
  for (let i = 0; i < beats; i++) {
    const dir = Math.random() < 0.7 ? 1 : -1;
    await wheelBurst(page, dir * rand(250, 500));
    await sleep(rand(600, 1400));
  }
  // 3. Hover 1-3 unrelated nav items
  const candidates = [
    'a[href="https://higgsfield.ai/"] >> nth=0',
    'a:has-text("Explore")',
    'a:has-text("Pricing")',
    'button:has-text("Image")',
    'button:has-text("Video")',
    'button:has-text("Community")'
  ];
  const nHovers = Math.floor(rand(1, 3));
  for (let i = 0; i < nHovers; i++) {
    const sel = candidates[Math.floor(Math.random() * candidates.length)];
    try {
      const el = await page.waitForSelector(sel, { timeout: 2000 }).catch(() => null);
      if (!el) continue;
      const box = await el.boundingBox();
      if (!box) continue;
      const from = await page.evaluate(() => ({ x: window.__lastMouseX || 100, y: window.__lastMouseY || 100 }));
      await moveMouseBezier(page, from, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await sleep(rand(400, 900));
    } catch (_) {}
  }
  // 4. Final dwell on main area
  await sleep(rand(1200, 3000));
}
