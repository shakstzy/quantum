// Detect a profile's relationship state from STRUCTURAL anchor hrefs.
// LinkedIn translates labels but not URLs, so the action area's hrefs are
// the most stable signal. Ported from stickerdaniel/linkedin-mcp-server
// scraping/connection.py.

const ACTION_AREA_END_RE = /^(?:About|Highlights|Featured|Activity|Experience|Education)\n/m;

// Read the structural action signals (top-of-page anchor hrefs, visible only).
export async function readActionSignals(page) {
  const data = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const links = Array.from(main.querySelectorAll("a[href]")).filter((a) => {
      const r = a.getBoundingClientRect();
      return r.top < 600 && r.width > 20 && r.height > 12;
    });
    const hrefs = links.map((a) => a.getAttribute("href") || "");
    return {
      hasInvite: hrefs.some((h) => h.includes("/preload/custom-invite/")),
      hasCompose: hrefs.some((h) => h.includes("/messaging/compose/")),
      hasEditIntro: hrefs.some((h) => h.includes("/edit/intro/")),
    };
  }).catch(() => null);
  if (!data) return { hasInvite: false, hasCompose: false, hasEditIntro: false };
  return data;
}

function actionArea(profileText) {
  const m = ACTION_AREA_END_RE.exec(profileText);
  return m ? profileText.slice(0, m.index) : profileText.slice(0, 500);
}

function hasPendingText(text) {
  const area = actionArea(text);
  return area.includes("\nPending\n") || area.endsWith("\nPending");
}

function hasIncomingRequestText(text) {
  const area = actionArea(text);
  return area.includes("\nAccept\n") && area.includes("\nIgnore\n");
}

// states: already_connected | pending | incoming_request | connectable | follow_only | self_profile | unavailable
export function detectConnectionState(profileText, signals = null) {
  if (signals) {
    if (signals.hasEditIntro) return "self_profile";
    if (signals.hasInvite) return "connectable";
  }
  if (hasIncomingRequestText(profileText)) return "incoming_request";
  if (hasPendingText(profileText)) return "pending";
  if (signals && signals.hasCompose) return "already_connected";
  if (profileText && profileText.slice(0, 300).includes("· 1st")) return "already_connected";

  // Fallback (no structural signals available)
  const area = actionArea(profileText);
  if (area.includes("\nConnect\n") || area.endsWith("\nConnect")) return "connectable";
  if (area.includes("\nFollow\n") || area.endsWith("\nFollow")) return "follow_only";
  return "unavailable";
}
