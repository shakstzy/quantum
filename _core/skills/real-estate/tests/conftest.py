"""Test harness that disables ALL network + subprocess calls.

Importing this module monkeypatches `redfin._fetch_html`, `redfin._get_session`,
`redfin._brave_search_first_redfin_url`, `zillow._fetch_html`,
`zillow._get_session`, and `subprocess.check_output` to raise loudly. This
ensures every test stays fixture-only.

Tests should:
    from tests.conftest import enforce_no_network, FIXTURES
    enforce_no_network()
    fixture_path = FIXTURES / "redfin-property.html"
    ...
"""
from __future__ import annotations

import sys
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SCRIPTS = ROOT / "scripts"
FIXTURES = ROOT / ".dev-fixtures"

sys.path.insert(0, str(SCRIPTS))


class NetworkDisabledError(RuntimeError):
    pass


def _fail_network(*a, **kw):
    raise NetworkDisabledError(
        "test harness has network disabled; load a fixture instead. "
        "If you need to refresh fixtures, run scripts/capture_fixtures.py."
    )


def enforce_no_network() -> None:
    import redfin, zillow
    redfin._fetch_html = _fail_network  # type: ignore
    redfin._get_session = _fail_network  # type: ignore
    redfin._brave_search_first_redfin_url = _fail_network  # type: ignore
    zillow._fetch_html = _fail_network  # type: ignore
    zillow._get_session = _fail_network  # type: ignore
    zillow._new_session = _fail_network  # type: ignore
    subprocess.check_output = _fail_network  # type: ignore
    subprocess.run = _fail_network  # type: ignore


def load_fixture(name: str) -> str:
    p = FIXTURES / name
    if not p.exists():
        raise FileNotFoundError(
            f"fixture {p} missing. Run scripts/capture_fixtures.py first."
        )
    return p.read_text()
