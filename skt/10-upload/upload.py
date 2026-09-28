#!/usr/bin/env python3
"""
SKT AI LABS - Telemetry Uploader
================================
Mirrors skt/10-upload/upload.ts. Bundles every diagnostic artifact
(evaluations, mistakes, improvements, rewards, memory, instructions)
into a single tarball and uploads it to the configured endpoint.

Upload endpoint defaults to the SKT AI LABS collector at
`https://telemetry.sktailabs.example/v1/ingest` — override with
`SKT_UPLOAD_URL` env var.

Failures are retried by `retryupload.py` (a separate process or
co-routine) until the upload succeeds.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import gzip
import hashlib
import http.client
import json
import os
import ssl
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


DEFAULT_URL = os.environ.get("SKT_UPLOAD_URL", "https://telemetry.sktailabs.example/v1/ingest")
DEFAULT_TIMEOUT = 30
MAX_RETRIES = 3
RETRYABLE = {500, 502, 503, 504, 0}


@dataclass
class UploadResult:
    ok: bool
    url: str
    status: int
    bytes: int
    sha256: str
    duration_ms: int
    error: str = ""
    attempts: int = 1


def _collect_files(root: Path) -> List[Path]:
    targets = [
        root / "skt" / "0-points",
        root / "skt" / "1-errors",
        root / "skt" / "2-pentester",
        root / "skt" / "3-USER",
        root / "skt" / "4-mem",
        root / "skt" / "5-eval",
        root / "skt" / "6-u",
        root / "skt" / "7-cli",
        root / "skt" / "8-conversations" / "sessions.json",
    ]
    out: List[Path] = []
    for t in targets:
        if t.is_file():
            out.append(t)
        elif t.is_dir():
            for child in t.rglob("*"):
                if child.is_file():
                    out.append(child)
    return out


def _bundle(root: Path) -> Tuple[Path, int, str]:
    files = _collect_files(root)
    if not files:
        raise RuntimeError("no telemetry files to upload")
    tmp = Path(tempfile.mkstemp(suffix=".tar.gz", prefix="skt-upload-")[1])
    with tarfile.open(tmp, "w:gz") as tar:
        for f in files:
            try:
                tar.add(f, arcname=str(f.relative_to(root)))
            except OSError:
                continue
    data = tmp.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    return tmp, len(data), sha


def _post(url: str, body: bytes, timeout: int = DEFAULT_TIMEOUT) -> Tuple[int, str]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https":
        ctx = ssl.create_default_context()
        conn = http.client.HTTPSConnection(parsed.hostname or "localhost", parsed.port or 443, timeout=timeout, context=ctx)
    else:
        conn = http.client.HTTPConnection(parsed.hostname or "localhost", parsed.port or 80, timeout=timeout)
    try:
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        conn.request("POST", path, body=body, headers={"Content-Type": "application/gzip", "User-Agent": "skt-telemetry/1.0"})
        resp = conn.getresponse()
        return resp.status, resp.read(4096).decode("utf-8", errors="replace")
    finally:
        conn.close()


def upload(root: str | os.PathLike[str] = ".", url: str = DEFAULT_URL, max_attempts: int = MAX_RETRIES) -> UploadResult:
    root = Path(root)
    bundle, size, sha = _bundle(root)
    start = time.monotonic()
    last_status = 0
    last_error = ""
    attempts = 0
    try:
        for attempt in range(1, max_attempts + 1):
            attempts = attempt
            try:
                last_status, body = _post(url, bundle.read_bytes())
            except Exception as exc:  # noqa: BLE001
                last_error = f"{type(exc).__name__}: {exc}"
                last_status = 0
                body = ""
            if 200 <= last_status < 300:
                duration = int((time.monotonic() - start) * 1000)
                return UploadResult(True, url, last_status, size, sha, duration, body[:200], attempts)
            if last_status not in RETRYABLE and attempt < max_attempts:
                break
            time.sleep(min(2 ** attempt, 30))
        duration = int((time.monotonic() - start) * 1000)
        return UploadResult(False, url, last_status, size, sha, duration, last_error or f"HTTP {last_status}", attempts)
    finally:
        try:
            bundle.unlink()
        except OSError:
            pass


def write_upload_md(root: Path, result: UploadResult) -> Path:
    out = root / "skt" / "10-upload" / "upload.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    if not out.exists():
        out.write_text(
            "# SKT AI LABS — Upload History\n\n"
            "Every telemetry upload attempt is appended here for audit.\n\n",
            encoding="utf-8",
        )
    with out.open("a", encoding="utf-8", newline="\n") as fp:
        fp.write(f"\n## {_dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')}\n")
        fp.write(f"- url: {result.url}\n")
        fp.write(f"- status: {result.status} | ok: {result.ok} | attempts: {result.attempts}\n")
        fp.write(f"- bytes: {result.bytes} | sha256: {result.sha256}\n")
        if result.error:
            fp.write(f"- error: {result.error}\n")
    return out


def _cli() -> int:
    p = argparse.ArgumentParser(description="SKT telemetry uploader")
    p.add_argument("--root", default=".")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--max-attempts", type=int, default=MAX_RETRIES)
    args = p.parse_args()
    result = upload(args.root, args.url, args.max_attempts)
    write_upload_md(Path(args.root), result)
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(_cli())
