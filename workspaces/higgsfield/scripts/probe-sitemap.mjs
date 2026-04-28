// probe-sitemap.mjs -- walk every Higgsfield tool page, open every picker,
// dump all models/presets/aspect/resolution/duration/style/toggle controls to JSON.
// Single run, zero submissions (0 credits). Output drives selector accuracy for the
// full skill without further trial-and-error.

import { launchContext } from './browser.mjs';
import { waitForCapturedJwt, extractUserIdFromJwt } from './jwt.mjs';
import { writeFile } from 'node:fs/promises';

const PAGES = {
  image_nano_banana: 'https://higgsfield.ai/ai/image?model=nano-banana-pro',
  image_soul_cinematic: 'https://higgsfield.ai/ai/image?model=soul-cinematic',
  video: 'https://higgsfield.ai/ai/video',
  marketing: 'https://higgsfield.ai/marketing-studio',
  cinema: 'https://higgsfield.ai/cinema-studio?autoSelectFolder=true'
};

// Capture every visible control on the page, descriptively.
async function snapshotControls(page) {
  return page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden' && window.getComputedStyle(el).display !== 'none';
    };
    const snap = el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        ariaChecked: el.getAttribute('aria-checked'),
        ariaSelected: el.getAttribute('aria-selected'),
        text: (el.innerText || '').trim().slice(0, 120).replace(/\s+/g, ' '),
        placeholder: el.getAttribute('placeholder'),
        type: el.getAttribute('type'),
        disabled: el.disabled || false,
        cls: (el.className || '').toString().slice(0, 120),
        id: el.id || null,
        xywh: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
      };
    };
    return {
      url: location.href,
      title: document.title,
      buttons: Array.from(document.querySelectorAll('button')).filter(visible).map(snap),
      tabs: Array.from(document.querySelectorAll('[role="tab"]')).filter(visible).map(snap),
      switches: Array.from(document.querySelectorAll('[role="switch"], input[type="checkbox"]')).filter(visible).map(snap),
      inputs: Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], div[role="textbox"]')).filter(visible).map(snap),
      links: Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 50).map(a => ({ text: a.innerText.trim().slice(0, 60), href: a.href.slice(0, 120) }))
    };
  });
}

// Click text by exact match (innerText equals label). Returns true if clicked.
async function clickByText(page, label) {
  return page.evaluate(l => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (t === l) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }, label);
}

// Close any open modal/dropdown by pressing Escape.
async function closeOpenModal(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

// Open a labeled dropdown (trigger button), snapshot the newly-visible options, then close.
async function probePicker(page, triggerLabel) {
  const opened = await clickByText(page, triggerLabel);
  if (!opened) return { triggerLabel, opened: false, options: [] };
  await page.waitForTimeout(1000);
  const options = await page.evaluate(() => {
    // Capture everything newly visible that looks like an option/menuitem/button list
    const els = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li, div'));
    const results = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20 || r.width > 600 || r.y < 50) continue;
      if (window.getComputedStyle(el).visibility === 'hidden') continue;
      const text = (el.innerText || '').trim();
      if (!text || text.length > 100) continue;
      // Only capture elements that appear to be picker options (have hover/cursor-pointer styling or roles)
      const role = el.getAttribute('role');
      const cls = (el.className || '').toString();
      if (role === 'menuitem' || role === 'option' || /cursor-pointer|hover:|button/i.test(cls)) {
        results.push({ tag: el.tagName, role, text: text.slice(0, 80), cls: cls.slice(0, 80) });
      }
    }
    // Dedup by text
    const seen = new Set();
    return results.filter(r => { const key = r.text; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 80);
  });
  await closeOpenModal(page);
  return { triggerLabel, opened: true, options };
}

async function probePage(page, name, url) {
  console.log(`[probe] ${name} -> ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(5000);

  const controls = await snapshotControls(page);
  const pickers = [];

  // Candidate picker triggers to open across all pages. Matches the visible button text.
  const triggers = [
    'Select model', 'Change model', 'Model',
    '3:4', '16:9', '9:16', 'Aspect Ratio', 'Aspect',
    '1K', '2K', '4K', '720p', '1080p', 'Resolution',
    '1/4', 'Batch', 'Batch size',
    '8s', '5s', '10s', 'Duration',
    'Auto', 'Camera', 'Style', 'Genre',
    'General', 'Cinematic',
    'Nano Banana Pro', 'Soul Cinematic',
    'Seedance 2.0 Fast', 'Kling 3.0', 'Veo 3.1',
    'Explore' // marketing presets often under "Discover Presets / Explore"
  ];

  for (const t of triggers) {
    // Only try if the trigger text is visible on the page
    const present = (controls.buttons || []).some(b => b.text === t || b.text.startsWith(t + '\n') || b.text.startsWith(t + ' '));
    if (!present) continue;
    try {
      const result = await probePicker(page, t);
      if (result.opened && result.options.length > 0) pickers.push(result);
    } catch (_) {}
  }

  return { name, url: page.url(), controls, pickers };
}

async function main() {
  const ctx = await launchContext({ force: false, headless: false });
  const sitemap = { capturedAt: new Date().toISOString(), pages: {} };
  try {
    const page = ctx.page;
    await page.goto(PAGES.image_nano_banana, { waitUntil: 'load', timeout: 45000 });
    await waitForCapturedJwt(ctx.jwtCapture, { timeoutMs: 30000 });
    const sub = extractUserIdFromJwt(ctx.jwtCapture.token);
    sitemap.user_id = sub?.user_id || null;
    sitemap.email = sub?.email || null;

    for (const [name, url] of Object.entries(PAGES)) {
      try {
        const data = await probePage(page, name, url);
        sitemap.pages[name] = data;
        console.log(`  ${name}: ${data.controls.buttons.length} buttons, ${data.controls.tabs.length} tabs, ${data.controls.switches.length} toggles, ${data.pickers.length} picker-opens`);
      } catch (e) {
        sitemap.pages[name] = { name, error: e.message };
        console.log(`  ${name}: ERROR ${e.message}`);
      }
      // Take a screenshot of each page for reference
      await page.screenshot({ path: `/tmp/hf-probe-${name}.png`, fullPage: false }).catch(() => {});
    }
  } finally {
    const outPath = '/tmp/hf-sitemap.json';
    await writeFile(outPath, JSON.stringify(sitemap, null, 2), 'utf8');
    console.log(`\n[probe] saved -> ${outPath}`);
    await ctx.close();
  }
}
main().catch(e => { console.error('PROBE ERROR', e.message); process.exit(1); });
