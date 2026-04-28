# Account Routing

Which of Adithya's 4 Gmail accounts to use for which task. Source of truth. Edit when account roles change.

## Account table

| Role | Email | Purpose | Calendar alias |
|------|-------|---------|----------------|
| Primary personal | `adithya.shak.kumar@gmail.com` | Personal inbox, personal calendar, default catch-all | `personal` |
| Eclipse Labs | `adithya@eclipse.builders` | Eclipse Labs work (founders, investors, recruiters, ops) | `eclipse` |
| Outerscope | `adithya@outerscope.xyz` | Outerscope work | `outerscope` |
| Synps | `adithya@synps.xyz` | Synps work | `synps` |

> Roles for `outerscope` and `synps` are placeholders. Adithya: confirm or correct, then delete this note.

## Routing rules

Apply in order. First match wins.

1. **Explicit override.** If Adithya names the account in-message ("send from eclipse", "check synps inbox"), use that.
2. **Domain / subject matter.**
   - Eclipse Labs context (eclipse.builders threads, Eclipse investors, Eclipse hires) -> `adithya@eclipse.builders`
   - Outerscope context -> `adithya@outerscope.xyz`
   - Synps context -> `adithya@synps.xyz`
   - Friends, family, dating, personal logistics, doctors, finance/banking/lease/taxes -> `adithya.shak.kumar@gmail.com`
3. **Counterparty match.** If sender/recipient appears in exactly one account's history, prefer that account. Discover via `gog -a <candidate> -j gmail search from:<email>` on each candidate.
4. **Calendar context.** Personal/medical/social -> `personal`. Work meetings -> the matching company alias.
5. **Tie-breaker for READS.** If steps 1-4 do not resolve and the task is a read, default to `adithya.shak.kumar@gmail.com`. Wrong-account read only costs noise.
6. **Tie-breaker for WRITES: ASK.** For any outbound op (Gmail send, Calendar create/modify, Drive upload/share/delete, any mutate), NEVER default. Stop and ask Adithya.

## Do NOT

- Cross-post between accounts (don't CC personal on a work thread without explicit ask).
- Create work meetings on personal calendar or vice versa.
- Move finance/admin content into a work account.
