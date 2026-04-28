// fingerprint.mjs -- stealth init scripts injected into every new page
// Goal: neutralize the fingerprint signals DataDome uses beyond `Runtime.enable`

export function buildInitScript(seed) {
  // seed is a 32-bit integer used to keep canvas / audio noise deterministic per session
  return `
(() => {
  const SEED = ${seed};
  let rand = SEED >>> 0;
  function prng() {
    rand = (rand * 1664525 + 1013904223) >>> 0;
    return (rand & 0xffff) / 0x10000;
  }

  // 1. navigator.webdriver -> undefined (patchright usually handles this; belt+suspenders)
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
  } catch (_) {}

  // 2. navigator.plugins / mimeTypes -> realistic Chrome on macOS
  try {
    const pluginData = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
    ];
    const mimes = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
    ];
    const plugins = pluginData.map(p => Object.assign(Object.create(Plugin.prototype), p, { length: mimes.length }));
    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => plugins });
    Object.defineProperty(Navigator.prototype, 'mimeTypes', { get: () => mimes });
  } catch (_) {}

  // 3. permissions.query override
  try {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) => {
      if (!p || !p.name) return origQuery(p);
      const realistic = { notifications: 'prompt', geolocation: 'prompt', camera: 'prompt', microphone: 'prompt', 'clipboard-read': 'prompt', 'clipboard-write': 'granted' };
      if (realistic[p.name]) return Promise.resolve({ state: realistic[p.name], onchange: null });
      return origQuery(p);
    };
  } catch (_) {}

  // 4. Canvas noise (1-bit jitter per pixel on a pseudo-random mask, not on every call)
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    function nudge(buf) {
      // Only nudge 0.5% of pixels; skip alpha channel entirely
      const n = buf.length;
      for (let i = 0; i < n; i += 4) {
        if (prng() < 0.005) {
          buf[i]   = buf[i]   ^ 1;
          buf[i+1] = buf[i+1] ^ 1;
          buf[i+2] = buf[i+2] ^ 1;
        }
      }
    }
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      // Skip very small canvases (icons, spinners) where noise breaks UX
      if (this.width * this.height < 256) return origToDataURL.apply(this, args);
      try {
        const ctx = this.getContext('2d');
        if (ctx && typeof ctx.getImageData === 'function') {
          const img = origGetImageData.call(ctx, 0, 0, this.width, this.height);
          nudge(img.data);
          ctx.putImageData(img, 0, 0);
        }
      } catch (_) {}
      return origToDataURL.apply(this, args);
    };
  } catch (_) {}

  // 5. AudioContext noise (constant tiny offset)
  try {
    const origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (array) {
      origGetFloat.apply(this, arguments);
      for (let i = 0; i < array.length; i++) {
        array[i] = array[i] + ((prng() - 0.5) * 0.0001);
      }
    };
  } catch (_) {}

  // 6. WebGL parameter jitter on a few non-critical params
  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      const val = origGetParameter.call(this, p);
      if (p === this.MAX_TEXTURE_SIZE || p === this.MAX_RENDERBUFFER_SIZE) {
        if (typeof val === 'number' && val > 0 && prng() < 0.5) return val - 1;
      }
      return val;
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (p) {
        const val = origGetParameter2.call(this, p);
        if (p === this.MAX_TEXTURE_SIZE || p === this.MAX_RENDERBUFFER_SIZE) {
          if (typeof val === 'number' && val > 0 && prng() < 0.5) return val - 1;
        }
        return val;
      };
    }
  } catch (_) {}
})();
`;
}

export async function verifyUaChConsistency(page) {
  // Sanity check: navigator.userAgentData.getHighEntropyValues must match the Sec-CH-UA
  // headers Chrome will send. A mismatch is an instant DataDome flag.
  const js = async () => {
    if (!('userAgentData' in navigator)) return { ok: false, reason: 'no-uach' };
    try {
      const v = await navigator.userAgentData.getHighEntropyValues([
        'platformVersion', 'model', 'architecture', 'bitness', 'uaFullVersion', 'fullVersionList'
      ]);
      return { ok: true, v };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  };
  const res = await page.evaluate(js);
  if (!res.ok) return { ok: false, reason: res.reason };
  // We don't have the actual Sec-CH-UA headers to compare to from the client side,
  // but we assert the brand list contains Google Chrome and that fullVersionList is non-empty.
  if (!Array.isArray(res.v.fullVersionList) || res.v.fullVersionList.length === 0) {
    return { ok: false, reason: 'empty-fullVersionList' };
  }
  const hasChrome = res.v.fullVersionList.some(b => String(b.brand || '').toLowerCase().includes('google chrome'));
  if (!hasChrome) return { ok: false, reason: 'no-chrome-in-brand-list' };
  return { ok: true };
}
