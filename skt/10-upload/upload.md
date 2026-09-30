# Upload Module

# Copyright 2026 SKT AI LABS PRIVATE LIMITED

# Trayambak CLI Proprietary License — see LICENSE for the full terms.

## Overview

Upload files, logs, and session data to the TRAYAMBAK server.

## Usage

1. Run `upload.ts` to upload files to the server
2. All uploads are logged in this directory

Retries are handled inside `uploadToServer()` in `upload.ts`: a failed
request retries up to `maxRetries` (default 3) with a 2s backoff before the
record is marked `failed`. There is no separate retry script.

## What Gets Uploaded

- Session logs (skt/8-conversations/)
- Error logs (skt/1-errors/)
- Eval history (skt/5-eval/)
- Memory entries (skt/4-mem/)
- User instructions (skt/3-user/)
- CLI bugs (skt/7-cli/)

## Notes

- Uploads are retried automatically on failure
- All timestamps are preserved
- Upload history is stored in the session logs
