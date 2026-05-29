from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SOURCES_FILE = BASE_DIR / "sources.yaml"

DEFAULT_TIMEOUT = 8.0
DEFAULT_HARVEST_CONCURRENCY = 10
DEFAULT_TEST_CONCURRENCY = 50

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]

# ---------------------------------------------------------------------------
# Provider policy
# ---------------------------------------------------------------------------

# Any stream URL containing one of these substrings is dropped at inject time and
# purged by `harvester clean`. Pluto TV's stitched endpoints are no longer
# accessible, so we block the whole pluto.tv domain.
BLOCKLIST_URL_SUBSTRINGS = [
    "pluto.tv",
]

# Ordered provider preference (earlier = higher priority). Streams are sorted so
# the most stable providers appear first in each channel's stream list. tvpass.org
# is the most stable/accessible provider, so it leads.
PROVIDER_PRIORITY = [
    "tvpass.org",
]


def is_blocked(url: str) -> bool:
    """True if the URL belongs to a blocklisted provider."""
    u = (url or "").lower()
    return any(bad in u for bad in BLOCKLIST_URL_SUBSTRINGS)


def provider_rank(url: str) -> int:
    """Lower rank sorts first. Blocklisted URLs are not expected here (filter first)."""
    u = (url or "").lower()
    for i, host in enumerate(PROVIDER_PRIORITY):
        if host in u:
            return i
    return len(PROVIDER_PRIORITY)  # everything else after prioritized providers
