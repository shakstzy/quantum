// download.mjs -- atomic CloudFront fetch with size verification + SHA-256
// Writes to <final>.partial then renames on success. Never persists the URL after success.

import { writeFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

export async function downloadCloudfront(url, destDir, options = {}) {
  const urlObj = new URL(url);
  const baseName = options.filename || basename(urlObj.pathname) || `hf_${Date.now()}`;
  const finalPath = join(destDir, baseName);
  const partialPath = finalPath + '.partial';

  const maxTries = 2;
  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        // CloudFront signed URLs do not need auth; user-agent may or may not matter.
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 higgsfield-skill/0.1' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const expectedLen = Number(res.headers.get('content-length') || '0');
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      if (!/^(image|video|application\/octet-stream)/i.test(contentType)) {
        throw new Error(`unexpected content-type: ${contentType}`);
      }
      const MAX_BYTES = 500 * 1024 * 1024;
      if (expectedLen > MAX_BYTES) throw new Error(`content-length ${expectedLen} exceeds ceiling ${MAX_BYTES}`);
      // Stream chunks so a malicious / runaway response can't OOM us before the
      // post-buffer size check fires. Abort mid-flight when we cross MAX_BYTES.
      const chunks = [];
      let total = 0;
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch (_) {}
          throw new Error(`stream exceeded ceiling ${MAX_BYTES}`);
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
      if (expectedLen > 0 && buf.length !== expectedLen) {
        throw new Error(`length mismatch: got ${buf.length}, expected ${expectedLen}`);
      }
      const sha = createHash('sha256').update(buf).digest('hex');
      await writeFile(partialPath, buf);
      const s = await stat(partialPath);
      if (s.size !== buf.length) throw new Error(`write mismatch: ${s.size} vs ${buf.length}`);
      await rename(partialPath, finalPath);
      return { local_path: finalPath, filename_on_cdn: baseName, bytes: buf.length, content_type: contentType, sha256: sha };
    } catch (e) {
      lastErr = e;
      try { await unlink(partialPath); } catch (_) {}
      if (attempt < maxTries) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  const err = new Error(`Download failed after ${maxTries} attempts: ${lastErr && lastErr.message}`);
  err.code = 'DOWNLOAD_FAILED';
  throw err;
}

// Higgsfield wraps CDN URLs in two different proxies:
//   1. images.higgs.ai/?url=<encoded-target>
//   2. higgsfield.ai/cdn-cgi/image/<options>/<raw-target-url>   (Cloudflare image-resize)
// Both point at the same underlying cdn.higgsfield.ai or d8j0ntlcm91z4.cloudfront.net asset.
// We peel both so downstream derive/download logic sees the raw upstream URL.
export function unwrapImagesHiggsProxy(src) {
  try {
    let out = src;
    for (let i = 0; i < 3; i++) {
      const u = new URL(out);
      if (u.hostname === 'images.higgs.ai') {
        const inner = u.searchParams.get('url');
        if (!inner) return out;
        out = inner;
        continue;
      }
      if (u.hostname === 'higgsfield.ai' && u.pathname.startsWith('/cdn-cgi/image/')) {
        // Path: /cdn-cgi/image/<options>/<raw-target-starting-with-https://...>
        const marker = u.pathname.indexOf('/https://');
        if (marker === -1) return out;
        out = u.pathname.slice(marker + 1);
        continue;
      }
      return out;
    }
    return out;
  } catch (_) { return src; }
}
