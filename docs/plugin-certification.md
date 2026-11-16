# Plugin certification checklist

A plugin can be listed as **verified** only when every item is true. Reviewers record the result and the commit/version reviewed.

## Manifest
- [ ] `npx tsx scripts/validate-plugin.ts` reports no errors; warnings explained.
- [ ] Every tool has an accurate `risk`, `access` and `confirmation`; anything that messages, books, buys or pays someone is `approval`.
- [ ] `network` lists only the hosts the plugin really calls; no wildcards broader than needed.
- [ ] `dataCategories` and `privacy.retention` describe what is actually read, sent and kept; a privacy policy URL is provided for any personal data.
- [ ] Scopes are the minimum for the tools offered (read-only first).

## Security
- [ ] Secrets are declared `secret: true`, read through `ctx.secret`, and never appear in logs, errors, URLs shown to users or tool output.
- [ ] External content (messages, calendar text, web pages) is treated as data: it is length-limited, sanitised and cannot change tool arguments or permissions.
- [ ] Inbound webhooks verify a signature and a replay window before the payload reaches `onEvent`.
- [ ] Physical-safety actions (locks, heaters, doors) require approval and confirm state by reading it back.
- [ ] Idempotent where it claims to be; retries cannot double-send or double-charge.

## Reliability
- [ ] `healthCheck` distinguishes a bad credential from an unreachable service and returns a human message.
- [ ] Timeouts, rate limits and upstream errors become clear, short errors — never a stack trace.
- [ ] Unit tests cover each tool, the failure paths and the “does not leak the token” case.

## Privacy and data rights
- [ ] `disconnect` revokes tokens (OAuth) and `deleteData` removes stored plugin data on request.
- [ ] No data is kept longer than `privacy.retention` states; nothing is sent to analytics.

## Review record

| Plugin | Version | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| homehub.telegram | 1.0.0 | — | — | self-reviewed, not independently certified | Outbound only |
| homehub.google-calendar | 1.0.0 | — | — | self-reviewed, not independently certified | Read-only via private iCal address |
