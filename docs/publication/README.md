# Public evidence presentation

This is documentation-only publication cleanup of the signed-off DAW-1 through DAW-6 archive. It is not DAW-7 or a new execution result.

## What was redacted

Recorded developer checkout roots and owned local validation/temporary-cluster roots have been replaced with stable, non-resolving tokens:

- `REDACTED_REPOSITORY_ROOT` identifies an omitted developer checkout root.
- `REDACTED_LOCAL_ROOT_NNN` identifies an omitted local evidence or cluster root. Different original roots have different numbered tokens; repeated references retain the same token.

Repository-relative suffixes, stack frame line/column numbers, cluster subdirectories and the distinction between original Windows-mounted runs and native Linux runs remain visible. A `file://` prefix before a token is archival stack-trace formatting, not a usable link. Tokens are not setup paths. Follow the current README/runbook for reproduction; use a newly allocated owned temporary directory rather than a token from a historical command.

Generic operating-system paths, PostgreSQL binary locations, loopback addresses and the runbook's `mktemp` template are not private workstation locations and remain unchanged.

## Original versus public bytes

**Every path-redacted artifact is a public presentation of preserved original evidence, not a byte-identical raw artifact.** This notice also applies when a historical milestone document calls a linked file "raw", "verbatim" or "byte-for-byte": those descriptions refer to the original capture at that milestone, before this publication-only redaction.

Before editing, all tracked files were copied byte-for-byte into an ignored, local-only preservation directory. The private inventory records their original SHA-256 values and the exact path-token mapping. That directory and mapping must not be staged or published. No original capture was deleted.

The [redaction manifest](redaction-manifest.json) lists every mechanically redacted file, replacement count, original byte hash and public byte hash. It also supplies UTF-8/LF-normalized hashes so Windows checkout line endings can be handled explicitly. Files absent from that manifest were not path-redacted by this transform.

Historical `summary.json` fields such as `transcriptSha256`, `integrationSha256` and other artifact bindings are **unchanged hashes of the originals**. They must not be compared directly with redacted public bytes. Use `publicNormalizedSha256` in the new ledger for public-copy integrity; use the original artifact bindings only with the preserved original bytes. `sourceSha256` continues to identify tested implementation/configuration and is unchanged. A hash is an integrity check, not independent attestation or a replacement for rerunning the tests.

The historical security checkpoint retained only its summary and transcript. Its three other infrastructure bindings reference artifacts not present in that original public archive; this cleanup does not reconstruct or invent those missing files. All 33 available original manifest/transcript bindings were checked against the preserved originals.

To check the public copies from the repository root with the pinned Node runtime:

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(readFileSync('docs/publication/redaction-manifest.json', 'utf8'));
for (const entry of manifest.files) {
  const text = readFileSync(entry.path, 'utf8').replace(/\r\n/g, '\n');
  const actual = createHash('sha256').update(text).digest('hex');
  assert.equal(actual, entry.publicNormalizedSha256, entry.path);
}
console.log(`Verified ${manifest.files.length} public presentations`);
NODE
```

## What did not change

No implementation, test, migration, dependency, workflow or validation script was changed. No test result, pass/fail status, mutation result, commit hash, timestamp, source fingerprint, benchmark number or incident chronology was edited. Failed historical attempts remain failed and remain available. The only changes inside original evidence files are the documented path substitutions; JSON structure and all non-path values are preserved.

The README adds an engineering overview and links to the current evidence for each milestone. Repository metadata describes the implemented PostgreSQL-based lab, without Redis, production deployment, capacity/SLO or live-model claims.

## Publication boundary

This is a forward-only working-tree cleanup. It does **not** erase previously published paths from Git history, remove cached copies, or change historical GitGuardian disposition. No history rewrite, reset, rebase or amend is part of this work. Until a separately approved commit/push occurs, GitHub still serves the earlier tree.

The [complete proposed file list](changed-files.md) identifies all publication changes. Original captures, private path maps, local verification helpers and fresh routine validation output remain ignored and unpublished.
