# Authentication regression fixture

This directory contains immutable `base` and `head` TypeScript repository snapshots for CodeAtlas analysis.

It intentionally seeds an authentication regression: an expired, non-refreshable token is handled as `401 SESSION_EXPIRED` in `base` and as `500 INTERNAL_ERROR` in `head`.

Both existing suites pass their one valid-session test. There is intentionally no expired-token test; a later product workflow must discover and generate that coverage.
