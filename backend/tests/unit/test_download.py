"""The download engine against a local HTTP server (D30, D31); no network."""

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest

from skyapi.data.download import (
    ATTEMPTS,
    USER_AGENT,
    DownloadError,
    DownloadResult,
    Manifest,
    ManifestEntry,
    download_file,
    expected_sha256,
    probe_unchanged,
    sha256_of,
    verify_file,
)
from support.fixtures_data import LocalData

pytestmark = pytest.mark.unit


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_partial(local: LocalData, data_dir: Path, key: str, size: int, etag: str | None) -> Path:
    entry = local.registry.by_key(key)
    part = data_dir / (entry.filename + ".part")
    part.write_bytes(local.contents[key][:size])
    sidecar = data_dir / (entry.filename + ".part.json")
    sidecar.write_text(
        json.dumps(
            {
                "url": local.url(key),
                "etag": etag,
                "last_modified": local.server.last_modified,
                "bytes": size,
            }
        )
    )
    return part


def fetch(local: LocalData, data_dir: Path, key: str, **kwargs: object) -> DownloadResult:
    sleeps: list[float] = []
    kwargs.setdefault("sleep", sleeps.append)
    return download_file(local.registry.by_key(key), data_dir, **kwargs)  # type: ignore[arg-type]


def test_full_download_verifies_and_records(local_data: LocalData, data_dir: Path) -> None:
    progress: list[tuple[str, int, int]] = []

    result = fetch(local_data, data_dir, "tiny_eph", progress=lambda *a: progress.append(a))

    expected = local_data.inflated["tiny_eph"]
    assert (data_dir / "tiny_eph.bsp").read_bytes() == expected
    assert result.sha256 == sha(expected)
    assert result.sha256_download is None
    assert result.size_bytes == len(expected)
    assert not result.resumed
    assert result.etag == local_data.server.etag_for("tiny_eph.bsp")
    assert result.last_modified == local_data.server.last_modified
    assert result.url == local_data.url("tiny_eph")
    assert progress[0] == ("tiny_eph.bsp", 0, len(expected))
    assert progress[-1] == ("tiny_eph.bsp", len(expected), len(expected))
    assert not (data_dir / "tiny_eph.bsp.part").exists()
    assert not (data_dir / "tiny_eph.bsp.part.json").exists()
    request = local_data.server.requests_for("tiny_eph.bsp")[0]
    assert request.headers["User-Agent"] == USER_AGENT
    assert USER_AGENT.startswith("InterSidera sky-data/")
    assert request.headers["Accept-Encoding"] == "identity"
    assert "Range" not in request.headers


def test_resume_sends_range_and_if_range(local_data: LocalData, data_dir: Path) -> None:
    etag = local_data.server.etag_for("tiny_eph.bsp")
    write_partial(local_data, data_dir, "tiny_eph", 50_000, etag)

    result = fetch(local_data, data_dir, "tiny_eph")

    assert result.resumed
    assert (data_dir / "tiny_eph.bsp").read_bytes() == local_data.inflated["tiny_eph"]
    assert result.sha256 == sha(local_data.inflated["tiny_eph"])
    request = local_data.server.requests_for("tiny_eph.bsp")[-1]
    assert request.headers["Range"] == "bytes=50000-"
    assert request.headers["If-Range"] == etag


def test_server_ignoring_range_restarts_from_zero(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.ignore_range = True
    write_partial(
        local_data, data_dir, "tiny_eph", 50_000, local_data.server.etag_for("tiny_eph.bsp")
    )

    result = fetch(local_data, data_dir, "tiny_eph")

    assert not result.resumed
    assert result.sha256 == sha(local_data.inflated["tiny_eph"])


def test_if_range_mismatch_restarts(local_data: LocalData, data_dir: Path) -> None:
    # The sidecar remembers an ETag of a previous upstream version: the server must answer 200.
    write_partial(local_data, data_dir, "tiny_eph", 50_000, '"stale-etag"')
    (data_dir / "tiny_eph.bsp.part").write_bytes(b"\0" * 50_000)  # a head that no longer matches

    result = fetch(local_data, data_dir, "tiny_eph")

    assert not result.resumed
    assert (data_dir / "tiny_eph.bsp").read_bytes() == local_data.inflated["tiny_eph"]
    request = local_data.server.requests_for("tiny_eph.bsp")[0]
    assert request.headers["If-Range"] == '"stale-etag"'


def test_206_with_wrong_content_range_discards_the_part(
    local_data: LocalData, data_dir: Path
) -> None:
    local_data.server.behaviour.bad_content_range = True
    write_partial(
        local_data, data_dir, "tiny_eph", 50_000, local_data.server.etag_for("tiny_eph.bsp")
    )
    sleeps: list[float] = []

    result = fetch(local_data, data_dir, "tiny_eph", sleep=sleeps.append)

    assert result.sha256 == sha(local_data.inflated["tiny_eph"])
    assert not result.resumed
    assert sleeps == [1.0]
    requests = local_data.server.requests_for("tiny_eph.bsp")
    assert "Range" in requests[0].headers
    assert "Range" not in requests[1].headers


def test_206_with_a_changed_etag_restarts_from_zero(local_data: LocalData, data_dir: Path) -> None:
    # A server that ignores `If-Range` answers 206 although the file was regenerated (RFC 9110
    # 13.1.5 says 200): the changed ETag on the 206 must not let a new tail follow an old head.
    local_data.server.behaviour.ignore_if_range = True
    write_partial(local_data, data_dir, "tiny_eph", 50_000, '"stale-etag"')
    (data_dir / "tiny_eph.bsp.part").write_bytes(b"\0" * 50_000)  # a head that no longer matches
    sleeps: list[float] = []

    result = fetch(local_data, data_dir, "tiny_eph", sleep=sleeps.append)

    assert not result.resumed
    assert (data_dir / "tiny_eph.bsp").read_bytes() == local_data.inflated["tiny_eph"]
    assert sleeps == [1.0]
    requests = local_data.server.requests_for("tiny_eph.bsp")
    assert [("Range" in r.headers) for r in requests] == [True, False]
    assert requests[0].headers["If-Range"] == '"stale-etag"'


def test_206_with_a_changed_last_modified_restarts_when_there_is_no_etag(
    local_data: LocalData, data_dir: Path
) -> None:
    local_data.server.behaviour.ignore_if_range = True
    local_data.server.behaviour.send_etag = False
    stale = local_data.server.last_modified  # version 1, recorded in the sidecar
    write_partial(local_data, data_dir, "tiny_eph", 50_000, None)
    (data_dir / "tiny_eph.bsp.part").write_bytes(b"\0" * 50_000)
    local_data.server.behaviour.version = 2  # regenerated upstream: a new Last-Modified

    result = fetch(local_data, data_dir, "tiny_eph", sleep=lambda _: None)

    assert not result.resumed
    assert (data_dir / "tiny_eph.bsp").read_bytes() == local_data.inflated["tiny_eph"]
    requests = local_data.server.requests_for("tiny_eph.bsp")
    assert requests[0].headers["If-Range"] == stale
    assert "Range" not in requests[1].headers


def test_206_without_validators_is_still_resumed(local_data: LocalData, data_dir: Path) -> None:
    # Nothing to compare: the validator check never turns a plain resume into a restart.
    local_data.server.behaviour.send_etag = False
    local_data.server.behaviour.send_last_modified = False
    etag = local_data.server.etag_for("tiny_eph.bsp")
    write_partial(local_data, data_dir, "tiny_eph", 50_000, etag)

    result = fetch(local_data, data_dir, "tiny_eph")

    assert result.resumed
    assert result.sha256 == sha(local_data.inflated["tiny_eph"])


def test_partial_without_validator_is_not_resumed(local_data: LocalData, data_dir: Path) -> None:
    write_partial(local_data, data_dir, "tiny_eph", 50_000, None)
    (data_dir / "tiny_eph.bsp.part.json").write_text(
        json.dumps({"url": local_data.url("tiny_eph"), "bytes": 50_000})
    )

    result = fetch(local_data, data_dir, "tiny_eph")

    assert not result.resumed
    assert "Range" not in local_data.server.requests_for("tiny_eph.bsp")[0].headers


def test_partial_from_another_url_is_discarded(local_data: LocalData, data_dir: Path) -> None:
    write_partial(
        local_data, data_dir, "tiny_eph", 50_000, local_data.server.etag_for("tiny_eph.bsp")
    )
    sidecar = data_dir / "tiny_eph.bsp.part.json"
    sidecar.write_text(
        json.dumps({**json.loads(sidecar.read_text()), "url": "https://elsewhere/x"})
    )

    result = fetch(local_data, data_dir, "tiny_eph")

    assert not result.resumed


def test_force_discards_the_partial(local_data: LocalData, data_dir: Path) -> None:
    write_partial(
        local_data, data_dir, "tiny_eph", 50_000, local_data.server.etag_for("tiny_eph.bsp")
    )

    result = fetch(local_data, data_dir, "tiny_eph", force=True)

    assert not result.resumed
    assert "Range" not in local_data.server.requests_for("tiny_eph.bsp")[0].headers


def test_pinned_hash_mismatch_leaves_no_file(local_data: LocalData, data_dir: Path) -> None:
    entry = replace(local_data.registry.by_key("tiny_eph"), sha256="0" * 64)

    with pytest.raises(DownloadError, match="does not match the pinned"):
        download_file(entry, data_dir, sleep=lambda _: None)

    assert not (data_dir / "tiny_eph.bsp").exists()
    assert not (data_dir / "tiny_eph.bsp.part").exists()
    assert not (data_dir / "tiny_eph.bsp.part.json").exists()


def test_registry_size_mismatch_is_refused(local_data: LocalData, data_dir: Path) -> None:
    entry = local_data.registry.by_key("tiny_eph")
    wrong = replace(entry, size_bytes=entry.size_bytes + 1)

    with pytest.raises(DownloadError, match=r"Content-Length .* differs from the registry size"):
        download_file(wrong, data_dir, sleep=lambda _: None)

    assert not (data_dir / "tiny_eph.bsp").exists()


def test_missing_content_length_is_tolerated(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.omit_content_length = True
    progress: list[tuple[str, int, int]] = []

    result = fetch(local_data, data_dir, "tiny_pck", progress=lambda *a: progress.append(a))

    assert result.sha256 == sha(local_data.inflated["tiny_pck"])
    assert progress[-1][2] == 0  # unknown total reported as 0


def test_content_encoding_gzip_is_refused(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.gzip_encoding = True

    with pytest.raises(DownloadError, match="Content-Encoding 'gzip' refused"):
        fetch(local_data, data_dir, "tiny_pck")

    assert not (data_dir / "tiny.tpc").exists()


def test_gunzip_entry_records_both_hashes(local_data: LocalData, data_dir: Path) -> None:
    result = fetch(local_data, data_dir, "packed")

    inflated = local_data.inflated["packed"]
    assert (data_dir / "packed.dat").read_bytes() == inflated
    assert result.sha256 == sha(inflated)
    assert result.sha256_download == sha(local_data.contents["packed"])
    assert result.size_bytes == len(inflated)
    assert not (data_dir / "packed.dat.gz").exists()
    assert not (data_dir / "packed.dat.part").exists()
    manifest = Manifest()
    manifest.record("packed", result)
    manifest.save(data_dir)
    loaded = Manifest.load(data_dir).get("packed")
    assert loaded is not None
    assert loaded.sha256 == result.sha256
    assert loaded.sha256_download == result.sha256_download


def test_corrupt_gzip_is_refused(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.put("packed.dat.gz", b"not gzip at all" * 200)

    with pytest.raises(DownloadError, match="not a valid gzip stream"):
        fetch(local_data, data_dir, "packed")

    assert not (data_dir / "packed.dat").exists()
    assert list(data_dir.iterdir()) == []


def test_html_404_never_becomes_a_data_file(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.missing.add("tiny.tpc")

    with pytest.raises(DownloadError, match="HTTP 404"):
        fetch(local_data, data_dir, "tiny_pck")

    assert not (data_dir / "tiny.tpc").exists()
    assert len(local_data.server.requests_for("tiny.tpc")) == 1  # 404 is final, no retry


def test_html_page_with_200_is_refused(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.html_pages.add("tiny.tpc")

    with pytest.raises(DownloadError, match="HTML page instead of the data file"):
        fetch(local_data, data_dir, "tiny_pck")

    assert not (data_dir / "tiny.tpc").exists()


def test_body_under_min_size_is_refused(local_data: LocalData, data_dir: Path) -> None:
    entry = local_data.registry.by_key("refresh_txt")
    strict = replace(entry, min_size_bytes=len(local_data.inflated["refresh_txt"]) + 1)

    with pytest.raises(DownloadError, match="below the minimum"):
        download_file(strict, data_dir, sleep=lambda _: None)

    assert not (data_dir / "refresh.txt").exists()


def test_transient_failures_retry_with_backoff(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.fail_first = 2
    sleeps: list[float] = []

    result = fetch(local_data, data_dir, "tiny_pck", sleep=sleeps.append)

    assert result.sha256 == sha(local_data.inflated["tiny_pck"])
    assert sleeps == [1.0, 2.0]
    assert len(local_data.server.requests_for("tiny.tpc")) == 3


def test_gives_up_after_five_attempts(local_data: LocalData, data_dir: Path) -> None:
    local_data.server.behaviour.fail_first = 99
    sleeps: list[float] = []

    with pytest.raises(DownloadError, match="gave up after 5 attempts"):
        fetch(local_data, data_dir, "tiny_pck", sleep=sleeps.append)

    assert ATTEMPTS == 5
    assert sleeps == [1.0, 2.0, 4.0, 8.0]
    assert len(local_data.server.requests_for("tiny.tpc")) == 5


def test_fallback_url_is_tried_after_the_primary_fails(
    local_data: LocalData, data_dir: Path
) -> None:
    entry = local_data.registry.by_key("tiny_pck")
    mirrored = replace(
        entry,
        url=local_data.server.url_for("gone.tpc"),
        fallback_urls=(local_data.url("tiny_pck"),),
    )

    result = download_file(mirrored, data_dir, sleep=lambda _: None)

    assert result.url == local_data.url("tiny_pck")
    assert result.sha256 == sha(local_data.inflated["tiny_pck"])


def test_every_source_failing_names_them(local_data: LocalData, data_dir: Path) -> None:
    entry = local_data.registry.by_key("tiny_pck")
    broken = replace(
        entry,
        url=local_data.server.url_for("a.tpc"),
        fallback_urls=(local_data.server.url_for("b.tpc"),),
    )

    with pytest.raises(DownloadError, match="every source failed") as info:
        download_file(broken, data_dir, sleep=lambda _: None)

    assert "a.tpc" in str(info.value)
    assert "b.tpc" in str(info.value)


def test_url_override_uses_a_single_source(local_data: LocalData, data_dir: Path) -> None:
    entry = local_data.registry.by_key("tiny_pck")

    result = download_file(entry, data_dir, url=local_data.url("tiny_pck"), sleep=lambda _: None)

    assert result.url == local_data.url("tiny_pck")


def test_dropped_connection_resumes_on_the_next_attempt(
    local_data: LocalData, data_dir: Path
) -> None:
    local_data.server.behaviour.truncate_at = 30_000
    sleeps: list[float] = []

    result = fetch(local_data, data_dir, "tiny_eph", sleep=sleeps.append)

    assert result.resumed
    assert result.sha256 == sha(local_data.inflated["tiny_eph"])
    assert sleeps == [1.0]
    requests = local_data.server.requests_for("tiny_eph.bsp")
    assert len(requests) == 2
    assert requests[1].headers["Range"] == "bytes=30000-"


def test_non_download_entry_is_rejected(local_data: LocalData, data_dir: Path) -> None:
    with pytest.raises(DownloadError, match="not a download"):
        download_file(local_data.registry.by_key("service"), data_dir)


def test_manifest_round_trip(local_data: LocalData, data_dir: Path) -> None:
    result = fetch(local_data, data_dir, "tiny_eph")
    manifest = Manifest()
    manifest.record("tiny_eph", result)
    manifest.save(data_dir)

    loaded = Manifest.load(data_dir)

    assert loaded == manifest
    entry = loaded.get("tiny_eph")
    assert entry == ManifestEntry(
        filename="tiny_eph.bsp",
        url=result.url,
        size_bytes=result.size_bytes,
        sha256=result.sha256,
        fetched_at=result.fetched_at,
        sha256_download=None,
        last_modified=result.last_modified,
        etag=result.etag,
    )
    text = (data_dir / "manifest.json").read_text()
    assert '"sha256_download"' not in text
    assert Manifest.load(data_dir / "nowhere") == Manifest()


def test_corrupt_manifest_raises(data_dir: Path) -> None:
    (data_dir / "manifest.json").write_text("{not json")

    with pytest.raises(DownloadError, match="unreadable manifest"):
        Manifest.load(data_dir)


def test_verify_file_states(local_data: LocalData, data_dir: Path) -> None:
    pinned = local_data.registry.by_key("tiny_pck")
    unpinned = local_data.registry.by_key("refresh_txt")
    manifest = Manifest()

    missing = verify_file(pinned, data_dir, manifest)
    assert not missing.present
    assert missing.status == "missing"
    assert not missing.ok

    manifest.record("tiny_pck", fetch(local_data, data_dir, "tiny_pck"))
    ok = verify_file(pinned, data_dir, manifest)
    assert ok.ok
    assert ok.status == "ok"
    assert ok.sha_ok is True
    assert ok.size_ok is True
    assert "pin" in ok.message

    fetch(local_data, data_dir, "refresh_txt")
    unrecorded = verify_file(unpinned, data_dir, manifest)
    assert unrecorded.ok
    assert unrecorded.status == "unpinned"
    assert unrecorded.sha_ok is None
    assert "recorded on the next fetch" in unrecorded.message
    assert expected_sha256(unpinned, manifest) is None

    manifest.record("refresh_txt", fetch(local_data, data_dir, "refresh_txt"))
    recorded = verify_file(unpinned, data_dir, manifest)
    assert recorded.ok
    assert recorded.status == "ok"
    assert "manifest" in recorded.message

    path = data_dir / "refresh.txt"
    data = bytearray(path.read_bytes())
    data[10] ^= 0xFF
    path.write_bytes(bytes(data))
    corrupt = verify_file(unpinned, data_dir, manifest)
    assert not corrupt.ok
    assert corrupt.status == "sha_mismatch"
    assert corrupt.sha_ok is False

    (data_dir / "tiny.tpc").write_bytes(b"short")
    truncated = verify_file(pinned, data_dir, manifest)
    assert not truncated.ok
    assert truncated.status == "size_mismatch"
    assert truncated.size_ok is False


def test_verify_file_checks_the_pin_over_the_manifest(
    local_data: LocalData, data_dir: Path
) -> None:
    manifest = Manifest()
    manifest.record("tiny_pck", fetch(local_data, data_dir, "tiny_pck"))
    tampered = replace(local_data.registry.by_key("tiny_pck"), sha256="f" * 64)

    result = verify_file(tampered, data_dir, manifest)

    assert result.status == "sha_mismatch"
    assert "pinned" in result.message


def test_sha256_of_matches_hashlib(local_data: LocalData, data_dir: Path) -> None:
    fetch(local_data, data_dir, "tiny_pck")

    assert sha256_of(data_dir / "tiny.tpc") == sha(local_data.inflated["tiny_pck"])


def test_probe_unchanged_uses_head_validators(local_data: LocalData, data_dir: Path) -> None:
    manifest = Manifest()
    manifest.record("refresh_txt", fetch(local_data, data_dir, "refresh_txt"))
    entry = manifest.get("refresh_txt")
    assert entry is not None
    url = local_data.url("refresh_txt")

    assert probe_unchanged(url, entry)
    assert local_data.server.requests_for("refresh.txt")[-1].method == "HEAD"

    local_data.server.behaviour.version = 2  # upstream regenerated the file
    assert not probe_unchanged(url, entry)

    local_data.server.behaviour.version = 1
    local_data.server.behaviour.allow_head = False
    assert not probe_unchanged(url, entry)

    assert not probe_unchanged(url, replace(entry, etag=None, last_modified=None))
    local_data.server.behaviour.allow_head = True
    assert probe_unchanged(url, replace(entry, etag=None))
    assert not probe_unchanged(local_data.server.url_for("gone.txt"), entry)
