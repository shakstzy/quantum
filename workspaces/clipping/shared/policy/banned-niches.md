# Banned Niches

Per Adv Review v1: high-CPM does not mean low-risk. These categories are excluded
from campaigns, sources, and clip candidates. Enforced as a regex filter at three points:

1. `01-discover/`: reject any campaign whose niche or rules match.
2. `03-clip/`: drop any candidate whose `transcript_excerpt` matches.
3. `05-qa/`: backstop check before approve.

## Hard-banned niches (auto-reject)

| Category | Why | Trigger keywords (regex, case-insensitive) |
|----------|-----|---------------------------------------------|
| Gambling / sportsbook | TikTok branded-content policy explicitly prohibits; FTC discloses material connection | `bet365|draftkings|fanduel|stake\.com|sportsbook|casino|roulette|poker|slot machine|odds boost|free bet` |
| Crypto trading / coin shilling | Securities exposure, scam-adjacent | `pump|moon|altcoin shill|to the moon|10x gem|next.{0,5}bitcoin|presale|crypto signal|memecoin (?!.*joke)` |
| Get-rich-quick / passive-income claims | YouTube reused-content policy + FTC unfair-claim risk | `passive income|get rich|guaranteed (returns|profit|income)|make .{0,5}\$\d{3,5}.{0,10}(per |a |\\/) ?(day|week|hour)` |
| Medical / supplements with health claims | FDA/FTC | `cure|treats?|reverses?|prevents?\s+(diabetes|cancer|alzheimer|depression)|nootropic|miracle|hormone optimize` |
| Financial advice without disclaimers | SEC | `buy this stock|guaranteed return|insider tip|day trade|swing trade.{0,30}(this|now)` |
| Adult / sex / OnlyFans promotion | platform ToS across TT/IG/YT | `onlyfans|of model|sugar daddy|sugar baby|escort|nsfw promotion` |
| Misogyny / red-pill | Brand-safety + ban-prone | `red pill|alpha male|sigma grindset|female nature|hypergamy.{0,30}(women|female)|MGTOW` |
| Conspiracy / health misinfo | platform medical-misinformation policies | `vaccines? cause|plandemic|false flag|new world order|deep state|elite agenda` |
| Weight-loss before-after with claim | FTC | `lose \d+ pounds|weight loss (secret|hack|trick)|drop body fat in.{0,20}days` |
| Unauthorized political endorsement | platform paid-political-content rules | `vote for|don't vote|elect|endorsing.{0,20}(candidate|president)` |

## Soft-banned (require special handling, not auto-reject)

- Sports highlights: only if campaign supplies rights-cleared assets. Source `rights_status` must be `authorized` or `campaign_allowed`.
- Reality TV: only if the campaign is rights-holder-run.
- Music clipping: only with campaign-supplied audio.
- News commentary: must include original analysis, not raw rebroadcast.

## Implementation

`bot/src/lib/banned.py` exposes `is_banned(text: str) -> tuple[bool, list[str]]` returning hits.
Update keyword list when a new edge case is found, then re-run audit on existing campaigns to retro-flag.
