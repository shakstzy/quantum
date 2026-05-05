// Human-paced typing / clicking / scrolling. Borrowed from workspaces/tinder/bot/src/runtime/humanize.mjs.

import { createCursor } from "ghost-cursor-playwright";
import { loadCaps } from "./caps.mjs";

const QWERTY_NEIGHBORS = {
  a: "qwsz", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc",
  g: "ftyhbv", h: "gyujnb", i: "ujko", j: "huikmn", k: "jiolm", l: "kop",
  m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awdxz",
  t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
};

export function jitter(min, max) { return Math.floor(min + Math.random() * (max - min)); }
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pickNeighbor(c) {
  const lower = c.toLowerCase();
  const neighbors = QWERTY_NEIGHBORS[lower];
  if (!neighbors) return c;
  const n = neighbors[Math.floor(Math.random() * neighbors.length)];
  return c === lower ? n : n.toUpperCase();
}

export async function humanType(page, text, { perCharMs = null, typoRate = 0.018 } = {}) {
  const caps = await loadCaps();
  const range = perCharMs ?? caps.pacing.type_per_char_ms;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== " " && c !== "\n" && /[a-z]/i.test(c) && Math.random() < typoRate) {
      const wrong = pickNeighbor(c);
      await page.keyboard.type(wrong, { delay: jitter(...range) });
      await sleep(jitter(120, 320));
      await page.keyboard.press("Backspace");
      await sleep(jitter(60, 160));
    }
    await page.keyboard.type(c, { delay: jitter(...range) });
    if (c === "." || c === "?" || c === "!") await sleep(jitter(260, 620));
  }
}

export async function makeCursor(page) {
  return await createCursor(page);
}

export async function humanClick(cursor, page, locator) {
  const el = typeof locator === "string" ? await page.$(locator) : locator;
  if (!el) throw new Error(`humanClick: target not found`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`humanClick: no bounding box`);
  const tx = box.x + box.width * (0.3 + Math.random() * 0.4);
  const ty = box.y + box.height * (0.3 + Math.random() * 0.4);
  await cursor.actions.move({ x: tx, y: ty });
  await sleep(jitter(80, 220));
  await cursor.actions.click();
}

export async function humanScroll(page, { distance, steps = 6 } = {}) {
  const dist = distance ?? jitter(220, 520);
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
