// Conversation-based location detection. Scans an entity's conversation for
// explicit "I'm in <city>" / "I live in <city>" / "from <city>" patterns.

const CITY_ALIASES = {
  austin: "austin",
  atx: "austin",
  "san francisco": "sf",
  sf: "sf",
  "the bay": "sf",
  "bay area": "sf",
  oakland: "sf",
  berkeley: "sf",
  "san jose": "sf",
  "los angeles": "la",
  la: "la",
  hollywood: "la",
  "santa monica": "la",
  "san diego": "la",
  sd: "la",
  "long beach": "la",
  "new york": "nyc",
  nyc: "nyc",
  manhattan: "nyc",
  brooklyn: "nyc",
  queens: "nyc",
  bronx: "nyc",
};

const PATTERNS = [
  /\bi(?:'m| am)? (?:currently )?(?:in|living in|based in|from)\s+([A-Za-z][A-Za-z\s]{1,30})\b/i,
  /\bi live in\s+([A-Za-z][A-Za-z\s]{1,30})\b/i,
  /\bjust moved (?:to|from)\s+([A-Za-z][A-Za-z\s]{1,30})\b/i,
  /\bvisiting\s+([A-Za-z][A-Za-z\s]{1,30})\b/i,
  /\bin town (?:from|in)?\s*([A-Za-z][A-Za-z\s]{1,30})?\b/i,
];

function normalizeCityCandidate(s) {
  if (!s) return null;
  const cleaned = s.toLowerCase().trim().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ");
  const tokens = cleaned.split(" ");
  for (let len = Math.min(tokens.length, 3); len >= 1; len--) {
    const candidate = tokens.slice(0, len).join(" ");
    if (CITY_ALIASES[candidate]) return CITY_ALIASES[candidate];
  }
  return null;
}

export function detectLocationFromConversation(conversationText) {
  if (!conversationText) return null;
  const herLines = conversationText.split("\n").filter(l => l.startsWith("**her**"));
  for (const line of herLines.reverse()) {
    const text = line.replace(/^\*\*her\*\*\s+\S+\s+\S+\s+/, "");
    for (const re of PATTERNS) {
      const m = text.match(re);
      if (m && m[1]) {
        const city = normalizeCityCandidate(m[1]);
        if (city) return { city, source: "conversation", quote: text.slice(0, 80) };
      }
    }
  }
  return null;
}
