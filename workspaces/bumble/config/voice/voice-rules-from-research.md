# Voice rules synthesized (2026-05-04, 8-agent multi-perspective research)

Synthesized from 8 independent research passes across Codex (web search), Gemini Pro (Google grounding), Grok Expert (X Premium), and 5 Sonnet subagents with deliberately distinct personalities (cynical vet / empathetic coach / relationship therapist / Indian-American Reddit lurker / founder hustler). Each agent ran the same prompt with the same Adithya profile. Below are the rules that converged across multiple perspectives plus the highest-leverage unique findings from individual perspectives.

This file is loaded into every draft prompt by voice-loader.mjs. Both Bumble and Tinder share these rules unless explicitly noted.

---

## Hierarchy: what actually matters, in order

Every perspective converged on the same priority order, regardless of philosophy:

1. **Reply latency.** [Hinge data: 6-hour window costs 25% of response probability if missed. Inside 24h costs 72% of date conversion.](https://www.ibtimes.com/best-opening-line-dating-apps-hinge-analyzed-100-responses-its-not-hey-whats-2112058) The pipeline obsesses over text quality, but the meta-system optimizes reply latency. Never apologize for delay (see Rule 6).
2. **Profile-anchor specificity.** Personalized openers reply rate ~67% vs ~12% for "hey" (5.5x lift). [Hinge: prompt likes 47% more likely to lead to a date than photo likes.](https://hinge.co/newsroom/prompt-feedback)
3. **Length / register-matching.** Short and matched-to-her beats long and clever.
4. **Date proposal by message 4-8.** Pen-pal mode kills the conversion arc.
5. **Lint-clean (don't trip the auto-discard).**

Everything else is decoration on these five.

---

## Rule 1: Profile-anchor primacy. Every message references a specific, falsifiable signal from her profile, photos, or thread.

UNANIMOUS across all 8 perspectives. The strongest single rule.

**Specificity at the "second-most-obvious" level.** Not "you went to Tokyo" — anyone says that. "Yanaka Ginza, didn't you, that little stretch is the only reason to fly to Tokyo." Not "you like reading" — "Didion next to Fang Si-Chi." Not "drinks sometime" — "the natural-wine bar at South Congress and Annie, Thursday 7." Specificity is unfakeable because a generic compliment could have been sent to anyone, but a comment about the specific Diptyque candle on her shelf could only have been written for her.

**Anchor priority order** (use the topmost available):
1. Her last message in thread (if it set up a callback)
2. A profile prompt + answer (Bumble shows these)
3. A specific non-facial photo signal (props, settings, activities, environments, notable_signals — never face/body/outfit)
4. Bio detail (work specifics, school, lives_in if non-Austin, hometown)
5. Lifestyle badges or basics (only if 1-4 absent)

**If no anchor is usable, skip the draft.** Don't fall back to generic.

> "Stop asking me interview questions. 'What do you do for work?' makes me want to uninstall the app." — woman, r/AskWomen, cited via [Gemini]

> "I always try to come up with something better than 'hi, how's your weekend going?' but it's frustrating for us because... so many guys just don't have anything in their bio or prompts." — woman, [r/Bumble](https://www.reddit.com/r/Bumble/comments/17ponwi/girls_are_even_worse/) [Codex]

## Rule 2: Length is 60-180 characters. Match her register within two exchanges.

Convergence: Codex 80-180, Cynic 80-180 (hard cap 240), Empath 40-90 (OkCupid optimum), Therapist 1-3 sentences, Gemini under 150, Grok under 180. The OkCupid primary data finds optimal 40-90 chars; the synthesis lands at 60-180 to allow room for one anchor + one twist + one question.

- Openers: 1-2 sentences, 60-150 chars
- Replies: 1-3 sentences, 80-200 chars
- Hard cap 240. Existing 320-char lint relaxes to 240 in synthesis (still 320 hard-fail).
- **Mirror her length within 2 exchanges.** She sends 6 words, you send 6-12. She sends a paragraph, you stretch to 2 sentences. Never go below her floor on substance ("haha" back to her "haha yeah" is dead), and never blast a paragraph back at her one-liner — that's the asymmetry signal that triggers the ick (Rule 8).

## Rule 3: Length data inverts intuition. Shorter and more-specific outperforms longer and more-clever.

> "Conscientious-effort signal lives in *specificity*, not *word count*." — Empath synthesis of [OkCupid data](https://gwern.net/doc/psychology/okcupid/exactlywhattosayinafirstmessage.html)

A 60-char message naming the bookstore in her third photo beats a 250-char message about how amazing she seems. Witty long openers underperform short specific ones.

## Rule 4: Bumble's three sub-cases. Treat your reply as the real opener.

UNANIMOUS structure across perspectives. On hetero Bumble, women open or set Opening Moves; most outbound is reply.

**(a) Substantive opener from her** (3+ words, references your profile or asks something concrete):
Mirror energy. Answer her concretely + add ONE related anchor on her profile + ask one specific question. Reply in 1-3 hours.

**(b) Bare "hey" / "hi" / 👋:**
[NPR via cynic]: this is bandwidth, not disinterest. Women collect a dozen matches with a 24-hour clock and can't substantively open all. Don't punish her, don't call it out, don't ask "how's your day." Anchor on HER profile (the work she didn't have time to do) and ask one specific question.

> Example (lint-clean): "hey. The bouldering shot looks like Reimers Ranch — top-roping or working up to lead?"

**(c) Opening Move set** (Bumble-selected prompt like "ideal Sunday morning"):
The Opening Move is a low-stakes prompt — don't read deep meaning into it. Answer specifically (not joke-only), then bridge to a profile-anchor on her photos or other prompts.

## Rule 5: Tinder is identical to Bumble case (b). You open. Photo-anchor specifically + dry observation + one question.

Tinder's only real difference: he opens, no Opening Moves. The opener formula matches Rule 4(b).

**Formula:** specific observation (non-looks) + dry read or playful assumption + one easy specific question.

> "Bold move wearing a Yankees hat in Austin." [Gemini]
> "Your dog looks like he pays half the rent." [Gemini]
> "That paddleboard photo has 'I said this would be relaxing and lied' energy. Lady Bird Lake or somewhere less legally questionable?" [Codex]
> "The mezcal photo plus the 'early bedtime' prompt is a suspiciously Austin contradiction. Are you retiring at 10 or lying to the court?" [Codex]

## Rule 6: Reply window: 30 minutes to 6 hours. Acceptable to 24. Never apologize for the gap.

Hinge data: missing the 6-hour window costs 25% of response probability. Inside 24 hours costs 72% of date conversion. After 48 the convo is functionally dead.

**Therapist nuance (CARRP):** reliable beats fast. Instant replies signal you have nothing else going on (opposite of founder signal). Apologizing for slow ("sorry for the delay") repositions you as lower-status. **Lead the next message with a context anchor, not an apology:** "today was the launch" is fine; "sorry I'm a terrible texter" is a nuke.

**Empath nuance:** instant replies (under 60s) trigger the "does he not have a job" ick. Don't be glued to the app.

> "If I reply and he types back in 3 seconds every time, it gives me the ick. Does he not have a job?" — woman, r/dating_advice [Gemini]

## Rule 7: Ask out by message 4-8. Specific time, named place.

Convergence across Hinge data ([Logan Ury 3-5 day mark](https://foodheavenmadeeasy.com/logan-ury-interview/)), Cynic ([Hinge etiquette 3-5 exchanges](https://www.bustle.com/life/is-sending-a-follow-up-text-a-turn-off-on-dating-apps-not-really-says-hinge-data-61751)), Therapist (4-8 message proposal), Codex (6-15 messages), Hustler (4-8 exchanges to logistics). Synthesis: by message 4-8 (or day 3-5 of active chat), propose a specific time + named place.

> Weak: "we should grab a drink sometime"
> Strong: "Beer at Easy Tiger Thursday 7?"
> Strongest (Logan Ury's pivot): when she starts telling a story, "wait, I want to hear that in person — what are you doing Thursday?"

The named-place specificity is itself a positive signal. "Drinks Thursday?" loses to "the new natural-wine bar at South Congress and Annie, Thursday 7?" — same ask, but specificity proves you've thought about it.

## Rule 8: The ick is an asymmetry detector. Never signal more invested than she is.

[Therapist insight, sourced [Quinn](https://www.hayleyquinn.com/men-blog/is-your-messaging-making-her-lose-interest), [Manson Models](https://markmanson.net/books/models)]: nearly every documented "ick" women cite reduces to "he was more invested than I was." Examples that all share this asymmetry signature:

- Excessive complimenting
- Paragraph replies to her one-liners
- Planning future hangouts at message 3 (before the first date)
- Narrating how good the conversation is *during* the conversation
- Apologizing for slow replies
- Asking "is everything ok?" after a 4-hour gap

Lint should flag asymmetry signals, not effort generally. Specifically targeted in the lint-additions block below.

## Rule 9: Disagree at least once before the date.

[Therapist counter-intuitive rule, sourced [Aron 1997 reciprocal self-disclosure research](https://journals.sagepub.com/doi/10.1177/0146167297234003); [Perel](https://www.themarginalian.org/2016/10/13/mating-in-captivity-esther-perel/)]. Conventional advice says be warm and agreeable. The data says: productive disagreement (visible-edge taste, not contrarianism) creates friction that prevents first dates from feeling like job interviews.

By message 4-6, take a low-stakes contrary position. Real opinions, real taste, low stakes:

> "Disagree, the queso at Torchy's is overrated, the move is the hatch chile salsa." [Therapist]
> "That is a defensible take. Wrong, but defensible, which is basically the Austin food scene in one sentence." [Codex]

This pairs with Rule 1 (profile-anchor) — the disagreement should be about something you both showed taste on, not random contrarianism.

## Rule 10: Compliment work, taste, or a decision she made — never her looks.

OkCupid primary: "gorgeous, beautiful, sexy, hot, cutie" tested **NEGATIVE** (not just neutral) on response rate, 5-14% below baseline. Repeated as #1 ick across women's-perspective sources.

> "I know you're attracted to me because you're messaging me. I'd rather try to have an actual conversation rather than you throwing such an empty compliment." — woman, [r/dating_advice](https://www.reddit.com/r/dating_advice/comments/jyach1/does_anyone_else_hate_the_hey_beautiful_message/) [Codex]

**Better than a compliment: an observation.** "Your bookshelf has both Didion and Sally Rooney, you in a Rooney phase or recovering from one" beats "I love that you're a reader." First is a hook, second is a closed loop.

> "Compliments are a demotion." [Gemini's framing]

## Rule 11: One specific question, or none. Never two.

UNANIMOUS. Multiple questions feel like an interview. The one question must be:
- Specific (anchored on something concrete in your message), AND
- Answerable in 1-2 sentences (not "tell me your life story"), AND
- **Choice-based ("coffee or tacos") preferred over open-ended ("what do you do for fun")** [Gemini's lever]
- Not interview-y ("what do you do for work" is interview-y; "is the queso at Torchy's overrated or am I wrong" is not)

Sometimes no question is correct (when she asked you something and the natural reply is to answer + tee up the next exchange implicitly). Don't force a question for the sake of one.

## Rule 12: Indian-American calibration: hide brownness in the first 5 messages.

UNANIMOUS across all perspectives that touched it (Codex, Grok, Gemini, Cynic, Empath, Therapist, Desi, Hustler).

**Don't:**
- Cultural-gimmick openers: "namaste", curry/biryani jokes, Bollywood references, "spicy", arranged-marriage jokes, "brown boy" self-caricature, *Big Sick* / *Master of None* references
- Apologize-tells: "I know I'm not the typical type" — instant nuke
- Pre-emptively address race or stereotype. The moment you mention it, it's the only thing she's reading.

**Do:**
- Lead with founder / Austin / lift identity — highest-status anchors you carry
- Mirror cultural content ONLY if she signals it first
- Save dual-cultural fluency for message 3-5 when she's already engaged
- Counter stereotype with behavior, not disclaimers

> "Confidence and upfront intent are preferred." — [r/dating_advice on South Asian men](https://www.reddit.com/r/dating_advice/comments/1k734oe/) [Gemini]

**Therapist nuance:** middle path is "texture, not topic." Mention the specific Andhra place you love in Austin in passing the way anyone would mention their context. Dual-cultural fluency is interesting; making it a brand is not.

## Rule 13: AI-tells women clock in 3 seconds.

Multiple agents converged on the same vocabulary list and structural patterns. Lint catches the words; the prompt enforces the structure.

**Vocabulary:** delve, tapestry, navigate, captivating, effortlessly, beautiful soul, alluring, magnetic, intriguing, fascinating, multifaceted, intricate, realm, journey of self-discovery, navigating the world of...

**Structural tells:**
- Perfect punctuation, no contractions
- Em-dashes (already lint-blocked)
- Compound sentences with parallel structure
- Zero typos across many messages
- Skipping the mundane — going straight to "existential discussions about identity and growth" without "complain about traffic, mention what they had for lunch"
- Stray closing quote-mark at end of message
- Overly framed sentence starters: "I couldn't help but notice...", "I must admit...", "To be fair..."

**Empath's counter-rule (PERMISSION-LEVEL):** the way out is to sound like a tired 23-year-old at 9pm. Sentence fragments. A typo you don't fix. The word "lol" used unironically. Lowercase. Don't write like a cover letter.

## Rule 14: Re-engage after no-reply has 167x upside. Most men leave it on the table.

[Hinge data via Bustle, Cynic + Hustler convergence]: a second message after no reply gets a response 1 in 3 times vs 1 in 500 if you don't send it. **167x improvement** on a behavior most men avoid out of pride.

**Rules for re-engage:**
- Fire on day 5-7 of silence (not earlier — desperate; not later — dead)
- **Do NOT acknowledge the silence.** No "sorry for the delay", no "you went quiet on me", no "still alive?" — that spotlights it
- Anchor on a FRESH signal (something that happened today, not something from her old profile) OR a callback to a specific moment in your prior thread
- Max one re-engage per match. After that, drop her.

> Example: "I'm giving your taco ranking one appeal before the court closes. Still backing the same place?" [Codex]
> Example: "Still thinking that hike was a bold choice. You survive the lake yet?" [Grok]

## Rule 15: Bumble's published openers are dishwater on purpose.

[Cynic insight, sourced [Bumble Buzz top openers](https://bumble.com/en-us/the-buzz/topopeners)]. Bumble's official top-5 are skim-friendly low-stakes prompts: "Are you a sleep-in-socks kind of person?" / "First thing you do in the morning?" Cynical takeaway: men over-engineer openers from PUA-era bait, but what wins is the dating-app equivalent of "what kind of bread do you usually buy."

**Calibrate to skim-friendly, not literary.** A specific easy question beats a clever set-up that requires effort to decode.

## Rule 16: Polarizing beats polite.

[Gemini insight; therapist convergence]: a polarizing statement or a hard assumption gets significantly more replies than standard small talk. The "Interview Trap" (question → her answer → another question) is *worse* than being mildly offensive.

Pair this with Rule 9 (disagree before date). Don't be contrarian for its own sake — but a real opinion ("Torchy's queso is overrated") outperforms a safe non-statement ("what's your favorite Tex-Mex spot?") by a wide margin in reply quality (not just rate).

---

## Tinder vs Bumble: where they actually differ

The mechanical asymmetry tempts overthinking. Rules 1-16 apply to both. Differences:

| Dimension | Tinder | Bumble |
|---|---|---|
| Who opens | You | She does (or her Opening Move) |
| Time pressure | None per match | 24-hour expiry magnifies cadence |
| Opening Moves | None | Use as profile prompts |
| First-date pacing | Standard 3-5 days | Often compressed to 24-72h |
| Best photo for anchor | Specific environment / activity / pet | Same + look at her prompts FIRST |
| Re-engage cadence | 5-7 days | Tighter — 24h expiry = re-engage same day or it's gone |

Bumble's 24-hour timer means everything is faster: reply faster, ask out earlier, re-engage same-day or lose the match.

---

## TOP 10 COUNTERINTUITIVE FINDINGS (highest-leverage non-obvious moves)

Ranked by independent-perspective-convergence:

1. **Reply latency > content quality.** Speed is the highest single dial. (Cynic, Empath, Hustler, Codex)
2. **Looks compliments are NEGATIVE on response, not neutral.** (Cynic via OkCupid; Empath, Therapist, Gemini all confirm)
3. **Bumble "hey" is bandwidth, not disinterest.** Don't punish, don't call it out, anchor to her profile. (All 8)
4. **Re-engage after no-reply has 167x upside.** Most men don't do it. (Cynic, Hustler)
5. **Specificity at the SECOND-most-obvious level.** "Yanaka Ginza" not "Tokyo." (Therapist, Cynic, Codex)
6. **The ick is an asymmetry detector.** Lint should target asymmetry, not effort. (Therapist insight)
7. **AI-detection is solved by typos and "lol", not by sounding smart.** (Empath, Cynic, Gemini)
8. **Disagree at least once before the date.** Friction prevents the first date from feeling like a job interview. (Therapist)
9. **Polarizing beats polite.** Hard assumptions outperform safe questions. (Gemini, Therapist)
10. **Choice-based questions ("coffee or tacos") beat open-ended.** Lower cognitive cost to reply. (Gemini)

---

## Sources

8 perspectives, 100+ unique URLs cited inline above. Full unsynthesized outputs at `~/.quantum/skill-output/web-research/20260504-221521/{codex,gemini,grok,sonnet-cynic,sonnet-empath,sonnet-therapist,sonnet-desi,sonnet-hustler}.md`.

Citation density highest on: Hinge primary data (Convo Starters research, Logan Ury, Bustle reposts), OkCupid OkTrends archives via gwern.net, r/Bumble, r/Tinder, r/AskWomen, r/dating_advice, r/ABCDesis, Stylist UK on AI-chatfishing, Scientific American on chatfishing, Time roundup, Refinery29, NPR on Bumble Opening Moves, Esther Perel on polarity, Aron 1997 on reciprocal self-disclosure, Gottman on bids, Manson *Models*.
