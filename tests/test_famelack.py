import unittest

from harvester.sources.famelack import channel_stream_urls
from harvester.models import SourceConfig
from harvester.snapshot_sources import source_url


class FamelackSchemaTests(unittest.TestCase):
    def test_current_sources_streams_schema(self):
        channel = {"sources": {"streams": ["https://example.test/live.m3u8"]}}
        self.assertEqual(channel_stream_urls(channel), ["https://example.test/live.m3u8"])

    def test_legacy_stream_urls_schema(self):
        channel = {"stream_urls": ["https://example.test/legacy.m3u8"]}
        self.assertEqual(channel_stream_urls(channel), ["https://example.test/legacy.m3u8"])

    def test_current_schema_wins_without_accepting_non_http_values(self):
        channel = {
            "sources": {"streams": ["udp://239.0.0.1", None, "https://example.test/current.m3u8"]},
            "stream_urls": ["https://example.test/legacy.m3u8"],
        }
        self.assertEqual(channel_stream_urls(channel), ["https://example.test/current.m3u8"])


class SnapshotSourceTests(unittest.TestCase):
    def test_github_source_uses_repository_page(self):
        config = SourceConfig(type="github", repo="owner/project")
        self.assertEqual(source_url(config), "https://github.com/owner/project")

    def test_telegram_source_uses_public_preview(self):
        config = SourceConfig(type="telegram", channel="example_channel")
        self.assertEqual(source_url(config), "https://t.me/s/example_channel")


if __name__ == "__main__":
    unittest.main()
