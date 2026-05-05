# Voice rules from research (2026-05-04)

Distilled from 30 Reddit/blog sources, 116 cited snippets, prioritizing women's-perspective threads on r/Bumble, r/Tinder, r/AskWomen, r/dating_advice, r/ABCDesis, r/dating, r/IndianBoysOnTinder. Every rule below has a citation and applies to BOTH Tinder and Bumble unless otherwise noted.

These rules are loaded into every draft prompt by voice-loader.mjs.

---

## 1. The single biggest dial: profile-anchor over generic

The most-repeated win pattern across women's responses is "comment on or ask about something specific from her profile." It works because (a) it proves you read, and (b) it gives her a clear thing to reply to.

> "I try to find something on their profile to ask them about." -- woman, r/Bumble (zs3ana)
> "When I message first, I look at their bio and try to see if there is something I can comment on or ask them that is unique and not about their looks." -- woman, r/Bumble (q8tams)
> "As a man before you message them read through their profile and find something of mutual interest." -- r/OnlineDating (1cn5fgj)

**Rule (HARD):** every reply or opener must reference at least one specific, observable signal from her profile, photos (visual section, NON-FACIAL), prompts, or thread history. "Generic" openers without an anchor are auto-discarded by lint.

**Anchor priority order (use the topmost available):**
1. Her last message in thread (if it set up a callback or named something specific)
2. A profile prompt + answer (Bumble shows these explicitly)
3. A specific photo signal from the visual section (props, settings, activities, environments, notable_signals)
4. Bio detail (work, school, lives_in if non-trivial, hometown if non-default)
5. Lifestyle badges or basics (only if 2-4 are absent)

If NONE of 1-5 are usable, skip the draft entirely. Bumble specifically: if she said only "hey" / "hi" with no anchor, skip — wait for a substantive message OR write a single anchor-question targeting her photo content.

## 2. Length is the second biggest dial

Multiple women cited length-mismatch as a "no reply" trigger. Short messages get skipped because they signal low effort; long messages get skipped because they signal try-hard.

> "I'll generally match the amount of effort of the other person." -- woman, r/Bumble (p46t57)
> "I think just 'hey' is quite lazy." -- woman, r/Bumble (p46t57)

**Rule:** 1-3 sentences, total length 40-180 chars. Below 40 reads as low-effort; above 180 reads as paragraph-monologue. The existing lint already caps at 320 chars; tighten the soft target to 40-180 in the system prompt.

## 3. The "story" pattern is the highest-upvoted opener style

The single highest-upvoted Tinder opener-pattern across the corpus is "make up a small story about her based on her photos / bio." Reason: it's interesting, gives her something concrete to push back on, signals creativity.

> "TL;DR: Make up crazy/funny shit about them based on their photos and/or bio. Coming from a girl who isn't on Tinder strictly to find random hookups, this is gold. It's an interesting way to start a conversation, it gives her something to respond to, and it shows that you actually put a bit of thought into what you were saying." -- women, r/Tinder (296boe), high-upvoted

**Rule:** when the visual section has a specific environment or activity, prefer a "you-look-like-someone-who" or "I-bet-this-photo-was-taken-the-day-you" reframe rather than literal observation. Example tones (don't reuse, generate fresh):

- Visual = beach + cocktail: "you look like the kind of person who has a strong opinion about which margarita is the worst margarita"
- Visual = climbing wall: "betting good money your camera roll is 80% climbing photos and 20% screenshots of climbing photos"
- Visual = dog: "your dog looks like he's interviewing me for the position"

NEVER: "is that your dog" / "I see you climb" / "nice photo" — those are observation, not story.

## 4. What WOMEN say kills replies (rank by frequency in corpus)

Cited dead-on-arrival patterns women repeatedly named:

1. **"hey" / "hi" / "hey there" alone** -- universal skip. Even when polite, no anchor = no reply.
2. **"how are you" / "how was your day" / "how's your week"** -- explicitly called out as the boredom signal.
3. **Looks compliments as opener** -- "hey beautiful" / "you're stunning" / "good morning princess" all flagged as creepy or low-effort.
4. **Pickup lines, especially googled ones** -- "I can't stand the people that just say hi or try a stupid one liner pickup line that sounds googled" -- woman, r/AskMen (xfqvsp).
5. **Sexual openers right out the gate** -- universal block, especially from women looking for relationship-leaning matches.
6. **Multi-paragraph essays** -- try-hard signal.
7. **"I don't usually do this but..."** -- self-deprecating opener women cite as cringe.
8. **"You don't see many girls like you on here"** -- backhanded.
9. **Generic "tell me about yourself"** -- lazy interrogation.
10. **"I noticed you matched with me"** -- captain-obvious / low-status.

All ten get added to lint regex (see voice-lint-additions.md).

## 5. Bumble women-first dynamic

Bumble flips: in hetero matches, the woman opens. Most of Adithya's traffic is REPLIES, not openers. Two distinct sub-cases:

**Case A: she sent a substantive opener.**
Reply directly to what she said + add ONE anchor-question that pushes the conversation forward. Don't acknowledge her opener with "haha thanks", reply to the SUBSTANCE.

**Case B: she sent only "hey" / "hi" / "hey there" / emoji.**
Multiple women admitted they often do this and don't think it's lazy. Best response per corpus is to "throw the ball back" with a profile-anchored question.

> "Something I use in response to throw the ball back to their side is something like 'hey, what about me won the right swipe?'" -- man, r/Bumble (oqxkuz), high-upvoted

But that specific phrasing is now a meme; don't reuse. Instead: lead with an anchor from HER profile (her photos / prompts), which forces her to engage with content rather than continue the empty-greeting volley.

**Case C: she has an Opening Move set, no message yet.**
Treat the Opening Move as her profile prompt. Answer it directly and briefly, then optionally turn the answer into a callback question.

## 6. Indian-American / South Asian male calibration

The corpus surfaced repeated themes for South Asian men in the US dating market. These don't change the message itself but change what the message must AVOID and what it can lean on.

> "Most modern women don't care about race. They care about your vibe and, to a lesser extent, how attractive you are." -- r/dating_advice (1hsyrjc)
> "Most men suffer with #2. Men are really bad at taking great photos v. putting together great pictures to showcase your best self." -- r/dating_advice (1hsyrjc)
> "Diverse, multicultural cities like NYC or Houston or LA will be more open to dating non-white." -- r/dating_advice (1hsyrjc)

**Rules:**
- Don't lean on cultural-gimmick openers ("namaste", forced Hindi without context, "chai vs coffee" stereotypes). Cultural references work when they're SPECIFIC to her profile, not generic.
- Don't apologize for or call attention to race in the opener. Confidence-default.
- DO lean on Austin-tech-founder vibe (specific local references, work specifics, lifts/training). The "vibe" signal is the highest leverage on this dial.
- Don't disqualify yourself with "I know I'm not your usual type" / "weird match but...". Universal ick.

## 7. Response-time calibration

Multiple sources flag both extremes as bad: instant-replies signal desperation; multi-day delays signal disinterest.

> "Replying to new messages within a few hours (ideally within one) tells Bumble you're an engaged, high-value user, and the algorithm will reward you with more visibility." -- tinderprofile.ai/blog/bumble-algorithm

**Rule:** the cron schedule already enforces 60-300s gap between sends and 15 fires/day spread 9:15a-22:45. The natural cadence sits in the 1-3 hour reply-time window, which matches the algorithmic-reward zone.

## 8. Question structure

The corpus consistently shows "question that sets up a specific reply" outperforms both "no question" and "open-ended interview question."

**Rule:** every message ends with at most one question, and the question must be:
- Specific (anchored on something concrete you said earlier in the message), AND
- Easy to answer in 1-2 sentences (not "tell me your life story"), AND
- Not interview-y ("what do you do for fun" is interview-y; "are you a coffee-or-tea-with-the-tea-person-being-very-serious-about-it kind of person" is not).

Sometimes no question is correct (e.g., when she asked you the question and the natural reply is to answer + tee up the next exchange implicitly). Don't force a question for the sake of one.

## 9. The funnel still leads to a date

Voice rules above govern the in-app phase. The funnel goal is to move to in-person, ideally within 3-7 messages on Bumble (24h timer compresses cadence) and 5-10 on Tinder. Date-venues.md provides the suggestion library; the messaging voice should set up the venue ask without being abrupt about it.

---

## Sources

| URL | Why it mattered |
|-----|-----------------|
| reddit.com/r/Bumble/zs3ana | women's first-message preferences (high-vote) |
| reddit.com/r/Bumble/q8tams | women on what gets a response |
| reddit.com/r/Bumble/p46t57 | women's-first dynamic + reply-effort matching |
| reddit.com/r/Bumble/oqxkuz | "hey 😊" responses + ball-back pattern |
| reddit.com/r/Tinder/296boe | classic women-tinder advice, high-vote |
| reddit.com/r/Tinder/1432iuf | what men want from women's first messages (inverse signal) |
| reddit.com/r/AskMen/xfqvsp | rule-of-thumb confessions |
| reddit.com/r/OnlineDating/1cn5fgj | women on profile-anchor primacy |
| reddit.com/r/dating_advice/s2er8j | the "wired headphones" opener case study |
| reddit.com/r/dating_advice/1hsyrjc | Indian-American dating-market calibration |
| reddit.com/r/dating/1bm8t6s | South Asian men dating struggles + advice |
| reddit.com/r/ABCDesis/rd656m | OkCupid swipe-data on South Asian men |
| reddit.com/r/IndianBoysOnTinder/1lrgfbo | Indian-context bio + opener tactics |
| theeverygirl.com/bumble-openers-to-try | Bumble-specific opener tactics |
| tinderprofile.ai/blog/bumble-algorithm | response-time as algorithmic signal |
| roast.dating/blog/bumble-first-message | profile-anchor + curiosity loop |
