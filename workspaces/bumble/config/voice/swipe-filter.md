# swipe-filter (bumble)

Stub. Mirrors tinder filter as a baseline. Override here if Bumble's filter philosophy diverges.

Right-swipe rules:
- Age in [age_min, age_max] (config/filter.json)
- Distance <= max_distance_mi (config/filter.json)
- Bio + Opening Move + at least one prompt OR interest (auto-pass on completely empty profiles)
- No obvious red flags (e.g. "no hookups", "ENM", anything that signals a relationship structure mismatch)
