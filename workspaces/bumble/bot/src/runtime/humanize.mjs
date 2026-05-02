import { createCursor } from "ghost-cursor-playwright";

const PROFILES = {
  fast:    { perChar: [40, 90],   sentencePause: [180, 420],  typoRate: 0.012 },
  normal:  { perChar: [70, 150],  sentencePause: [280, 660],  typoRate: 0.018 },
  thinky:  { perChar: [100, 220], sentencePause: [400, 950],  typoRate: 0.022 },
};

const QWERTY_NEIGHBORS = {
  a: "qwsz", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc",
  g: "ftyhbv", h: "gyujnb", i: "ujko", j: "huikmn", k: "jiolm", l: "kop",
  m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awdxz",
  t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
};

function jitter(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pickNeighbor(c) {
  const lower = c.toLowerCase();
  const neighbors = QWERTY_NEIGHBORS[lower];
  if (!neighbors) return c;
  const n = neighbors[Math.floor(Math.random() * neighbors.length)];
  return c === lower ? n : n.toUpperCase();
}

export async function humanType(page, text, { profile = "normal" } = {}) {
  const p = PROFILES[profile];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== " " && c !== "\n" && /[a-z]/i.test(c) && Math.random() < p.typoRate) {
      const wrong = pickNeighbor(c);
      await page.keyboard.type(wrong, { delay: jitter(...p.perChar) });
      await sleep(jitter(120, 320));
      await page.keyboard.press("Backspace");
      await sleep(jitter(60, 160));
    }
    await page.keyboard.type(c, { delay: jitter(...p.perChar) });
    if (c === "." || c === "?" || c === "!") await sleep(jitter(...p.sentencePause));
  }
}

export async function makeCursor(page) {
  return await createCursor(page);
}

export async function humanClick(cursor, page, selector, { hover = false } = {}) {
  const el = await page.$(selector);
  if (!el) throw new Error(`humanClick: selector not found: ${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`humanClick: no bounding box for: ${selector}`);
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
  await cursor.actions.move({ x: targetX, y: targetY });
  if (hover) {
    await sleep(jitter(120, 380));
    return;
  }
  await sleep(jitter(80, 220));
  await cursor.actions.click();
}

export async function humanScroll(page, { distance, steps = 6 } = {}) {
  const dist = distance ?? jitter(200, 500);
  const stepSize = dist / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepSize + jitter(-12, 12));
    await sleep(jitter(40, 130));
  }
}

export async function idlePause({ min = 1500, max = 4500 } = {}) {
  await sleep(jitter(min, max));
}

export async function microFidget(page) {
  if (Math.random() > 0.35) return;
  const vp = page.viewportSize();
  if (!vp) return;
  await page.mouse.move(jitter(50, vp.width - 50), jitter(50, vp.height - 50), { steps: jitter(3, 7) });
  await sleep(jitter(250, 1200));
}

export { jitter, sleep };
