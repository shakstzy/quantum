"""Per-county CAD adapters.

Each adapter exposes:
- name: short slug used in CLI + DuckDB rows
- state: 2-letter code
- fips: county FIPS code
- zips: list of zip codes that resolve to this county
- find_latest_export() -> (url, year, kind) | None
- find_local_extract() -> Path | None  (for using a hand-downloaded zip)

Adding a new county = one new file here + register it in registry.py.
"""
