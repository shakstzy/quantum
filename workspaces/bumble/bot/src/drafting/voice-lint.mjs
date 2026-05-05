const BANNED_PHRASES = [
  /how was your day/i,
  /how's your day/i,
  /hope you're well/i,
  /hope your week/i,
  /good morning beautiful/i,
  /you are absolutely stunning/i,
  /just wanted to say/i,
  /\bgood morning (princess|gorgeous)\b/i,
  /\bhey (beautiful|gorgeous|pretty|cutie|stranger|lady|stunning)\b/i,
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
  // ===== 8-agent research synthesis (2026-05-04), converged across >=3 perspectives =====
  // Looks compliments (OkCupid: tested NEGATIVE on response, not just neutral)
  /\b(you'?re|you are) (so|absolutely|truly|incredibly|literally) (beautiful|gorgeous|stunning|hot|sexy|goddess|angel)\b/i,
  /\bbeautiful soul\b/i,
  // Pickup-line classics
  /\bfell from heaven\b/i,
  /\bare you a (camera|magnet|thief)\b/i,
  // Sexual openers (UMass study: instant unmatch territory)
  /\bnetflix and chill\b/i,
  /\bDTF\b/,
  /\bbody count\b/i,
  // Negging / entitlement
  /\bbring to the table\b/i,
  /\bcan you (actually )?hold a conversation\b/i,
  /\bshould I (just )?unmatch\b/i,
  /\bnot (usually )?my (type|usual type)\b/i,
  /\bprove me wrong\b/i,
  // Pen-pal mode (kills first-date conversion; converged across Cynic/Therapist/Empath)
  /\bwe should (definitely )?(grab|get) (drinks|coffee|food) sometime\b/i,
  /\bif you'?re ever (down|free|around|interested)\b/i,
  /\bmaybe we can (hang out|meet up) (sometime|soon)\b/i,
  // Asymmetry / overinvestment (Therapist insight: ick = asymmetry detector)
  /\bI'?ve been thinking about (your|what you said|you)\b/i,
  /\bI'?m so (lucky|glad) (we matched|to (match|chat) with you)\b/i,
  /\bI feel (like )?I can (really )?(talk|open up) to you\b/i,
  // Apology-tells (lower status; CARRP says reliability beats fast-with-apology)
  /\bsorry (for the (late|delay|long delay))\b/i,
  /\bnot sure if you'?ll respond\b/i,
  /\bI know this is (random|weird|out of nowhere)\b/i,
  // Cultural-gimmick openers (Indian-American calibration; UNANIMOUS across 8 agents)
  /\bbollywood\b/i,
  /\bbig sick\b/i,
  /\bbrown (boy|guy|man)\b/i,
  /\bdesi (king|queen|vibes|culture)\b/i,
  // Time-of-day "how" derivatives the existing lint missed
  /\bhow'?s your (week|day|night|morning) (going|been)\b/i,
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
  // ===== 8-agent research synthesis (2026-05-04), converged AI-tell vocabulary =====
  // ChatGPT-canonical vocabulary women cite verbatim across Stylist UK, SciAm, Hinge AI guide
  /\bdelve\b/i,
  /\btapestry\b/i,
  /\bnavigat(e|ing) (the|this) (world|landscape|conversation|realm)\b/i,
  /\bin the realm of\b/i,
  /\beffortlessly (captivating|charming|beautiful|stunning|alluring)\b/i,
  /\bcaptivating (smile|eyes|presence|aura|energy)\b/i,
  /\b(intriguing|captivating|magnetic|alluring|enchanting) soul\b/i,
  /\bI'?d love to (hear|learn|know) more about\b/i,
  // Structural AI tells (cover-letter scaffolding)
  /\bI hope this (message|finds you|note)\b/i,
  /\bIt'?s a pleasure to (meet|connect)\b/i,
  /\bcouldn'?t help but notice\b/i,
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
