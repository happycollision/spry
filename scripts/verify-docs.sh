#!/usr/bin/env bash
# Verify that docs/generated/ is in sync with the doc fragments produced by the
# test suite. This is the enforced guardrail against generated-doc churn
# (spry-ohjb): the historical failure was a doc-capture bug that made the
# fragments non-deterministic, so the committed docs silently drifted from what
# `bun run docs:build` produces. The "run everything twice and eyeball the
# diff" convention did not reliably catch it, so this gate makes the check
# machine-enforced instead.
#
# Contract: run AFTER the test suite (which writes .test-tmp/doc-fragments/),
# then this rebuilds docs/generated/ from those fragments and fails if the
# result differs from what is committed. In CI the preceding `bun test` step
# populates the fragments; locally, run `bun test` (or a doc-test subset) first.
set -euo pipefail

cd "$(dirname "$0")/.."

FRAGMENTS_DIR=".test-tmp/doc-fragments"
if [ ! -d "$FRAGMENTS_DIR" ] || [ -z "$(ls -A "$FRAGMENTS_DIR" 2>/dev/null)" ]; then
  echo "✗ verify-docs: no doc fragments found in $FRAGMENTS_DIR" >&2
  echo "  Run the test suite first (e.g. \`bun test\`) so the doc fragments are written," >&2
  echo "  then re-run \`bun run docs:verify\`." >&2
  exit 1
fi

# Rebuild the generated docs from the fragments (same path as `docs:build`,
# including the oxfmt pass — the committed docs are oxfmt-formatted).
bun run docs:build

# Any diff in docs/generated/ means the committed docs are stale relative to the
# fragments the suite just produced: either a doc fragment legitimately changed
# and the author forgot to commit the regenerated docs, or a capture bug made
# the fragments non-deterministic. Either way it must not merge.
if ! git diff --quiet -- docs/generated/; then
  echo "✗ verify-docs: docs/generated/ is out of sync with the doc fragments." >&2
  echo "  Regenerate and commit them:  bun run docs:clean && bun test && bun run docs:build" >&2
  echo "  Offending diff:" >&2
  git --no-pager diff -- docs/generated/ >&2
  exit 1
fi

echo "✓ verify-docs: docs/generated/ is in sync with the doc fragments."
