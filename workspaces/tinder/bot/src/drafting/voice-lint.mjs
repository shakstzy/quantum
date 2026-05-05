const BANNED_PHRASES = [
  /how was your day/i,
  /how's your day/i,
  /hope you're well/i,
  /hope your week/i,
  /good morning beautiful/i,
  /you are absolutely stunning/i,
  /just wanted to say/i,
  // ===== research-derived (2026-05-04), trimmed to clear-cringe-only after Adithya feedback =====
  /\bgood morning (princess|gorgeous)\b/i,
  /\bhey (beautiful|gorgeous|pretty|cutie|stranger|lady)\b/i,
  /\bi don't usually do this\b/i,
  /\bi'm not usually like this\b/i,
  /\byou don't see many (girls|women) like you\b/i,
  /\btell me about yourself\b/i,
  /\bnice to meet you\b/i,
  /\bi noticed (you|that you) (matched|swiped)\b/i,
  /\byou (look|seem) like (the|a) kind of (girl|woman) who\b/i,
  /\bi bet you (get|hear) this a lot\b/i,
  /\byou're probably (out of my league|too good for me)\b/i,
  /\bnamaste\b/i,
  /\bchai vs coffee\b/i,
];

const AI_TELLS = [
  /as an ai/i,
  /i'm an? (ai|assistant|language model)/i,
  /i'm here to help/i,
  /\bcertainly!?\b/i,
  /\bi'd be happy to\b/i,
  /\babsolutely!\s*$/i,
  /\bgreat (to|connecting with you|hearing from you)\b/i,
  /\bthank you for sharing\b/i,
];

export function lintDraft(text) {
  const issues = [];
  if (text.length > 320) issues.push("too_long");
  if (text.length < 6) issues.push("too_short");
  if (text.includes("—") || text.includes("–")) issues.push("em_dash");
  const exclam = (text.match(/!/g) || []).length;
  if (exclam > 1) issues.push("too_many_exclamation");
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 3) issues.push("too_many_sentences");
  for (const re of BANNED_PHRASES) if (re.test(text)) issues.push(`banned:${re.source}`);
  for (const re of AI_TELLS) if (re.test(text)) issues.push(`ai_tell:${re.source}`);
  if (/^(hey|hi|hello)\s*[,.!]?\s*$/i.test(text.trim())) issues.push("bare_greeting");
  return { score: issues.length === 0 ? 1 : 0, issues, pass: issues.length === 0 };
}
