"""County Appraisal District (CAD) bulk-data layer.

Texas-state-mandated EARS (Electronic Appraisal Roll Submission) format
is identical across all 254 TX counties, so one parser covers everyone.
Each county only needs a tiny adapter for its download URL.

Free + modular + volume:
- Free: official CAD bulk downloads, no scraping, no API fees.
- Modular: per-county adapters in counties/, registered in registry.
- Volume: ingest once into local DuckDB, unlimited lookups locally.
"""
