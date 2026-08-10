#!/usr/bin/env bash
# Release script for Spry
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.1.0-alpha.4

set -euo pipefail

# Parse arguments
FORCE=false
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f)
      FORCE=true
      shift
      ;;
    *)
      VERSION="$1"
      shift
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "Usage: $0 [--force] <version>"
  echo "Example: $0 0.1.0-alpha.4"
  exit 1
fi

TAG="v$VERSION"

# The release commit must land on the release branch. A bare `git push` is not
# safe here: with push.default=current (or no upstream) it pushes whatever
# branch happens to be checked out -- e.g. a worktree branch -- which would
# publish the tag pointing at a commit that never reached the release branch.
# So we always push explicitly to RELEASE_BRANCH, and refuse to run from a
# branch that isn't it unless the caller opts in.
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$CURRENT_BRANCH" != "$RELEASE_BRANCH" ]; then
  echo "Error: you are on branch '$CURRENT_BRANCH', not the release branch '$RELEASE_BRANCH'"
  echo ""
  echo "Release from '$RELEASE_BRANCH':"
  echo "  git checkout $RELEASE_BRANCH && git pull"
  echo "  $0 $VERSION"
  echo ""
  echo "To release this branch deliberately (it becomes origin/$CURRENT_BRANCH):"
  echo "  RELEASE_BRANCH=$CURRENT_BRANCH $0 $VERSION"
  exit 1
fi

# Validate version format (basic semver with optional prerelease)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format '$VERSION'"
  echo "Expected format: X.Y.Z or X.Y.Z-prerelease"
  exit 1
fi

# Validate changelog exists
CHANGELOG_FILE="CHANGELOG.md"
if [ ! -f "$CHANGELOG_FILE" ]; then
  echo "Error: $CHANGELOG_FILE not found"
  exit 1
fi

# Check that Unreleased section has content to release
if ! awk '
  BEGIN { in_unreleased=0; has_content=0 }
  /^## \[Unreleased\]/ { in_unreleased=1; next }
  /^## \[/ { if (in_unreleased) exit }
  in_unreleased && /^### / { has_content=1 }
  END { exit !has_content }
' "$CHANGELOG_FILE"; then
  echo "Error: No content in [Unreleased] section to release"
  echo "Please add changes under ## [Unreleased] before releasing"
  exit 1
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "Error: You have uncommitted changes. Please commit or stash them first."
  exit 1
fi

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag $TAG already exists"
  exit 1
fi

# Get the latest tag and compare versions
LATEST_TAG=$(git tag -l 'v*' | sort -V | tail -1)
if [ -n "$LATEST_TAG" ]; then
  LATEST_VERSION="${LATEST_TAG#v}"

  # Compare versions using sort -V (version sort)
  HIGHER=$(printf '%s\n%s' "$LATEST_VERSION" "$VERSION" | sort -V | tail -1)

  if [ "$HIGHER" = "$LATEST_VERSION" ] && [ "$VERSION" != "$LATEST_VERSION" ]; then
    if [ "$FORCE" = true ]; then
      echo "Warning: Version $VERSION is older than latest release $LATEST_VERSION (--force specified)"
    else
      echo "Error: Version $VERSION is older than latest release $LATEST_VERSION"
      echo "Use --force to release anyway"
      exit 1
    fi
  fi
fi

# Verify `bun` actually runs BEFORE we mutate anything. `bun` is commonly a
# mise shim, and mise refuses to run in an untrusted directory (e.g. a fresh
# worktree), so `bun` can be on PATH and still fail. Discovering that halfway
# through the release used to leave the changelog rewritten but package.json
# un-bumped.
if ! bun -e '' >/dev/null 2>&1; then
  echo "Error: 'bun' is on PATH but failed to execute."
  echo ""
  bun -e '' 2>&1 | sed 's/^/  /' || true
  echo ""
  echo "If this is a mise trust error, run:  mise trust"
  exit 1
fi

echo "Releasing version $VERSION (tag: $TAG)"

# From here on we mutate the working tree. On any failure, roll the mutations
# back so a partial release never survives -- the tree is verified clean above,
# so restoring these two files is safe.
release_files_dirty=false
rollback() {
  if [ "$release_files_dirty" = true ]; then
    echo ""
    echo "Release failed -- rolling back changes to package.json and CHANGELOG.md"
    git checkout -- package.json "$CHANGELOG_FILE" 2>/dev/null || true
  fi
}
trap rollback ERR INT TERM

# Bump changelog: move Unreleased content to new version section
echo "Updating changelog..."
release_files_dirty=true
DATE=$(date +%Y-%m-%d)
awk -v ver="$VERSION" -v date="$DATE" '
  /^## \[Unreleased\]/ {
    print
    print ""
    print "## [" ver "] - " date
    next
  }
  { print }
' "$CHANGELOG_FILE" > "$CHANGELOG_FILE.tmp" && mv "$CHANGELOG_FILE.tmp" "$CHANGELOG_FILE"

# Update package.json version
echo "Updating package.json version to $VERSION..."
bun -e "const pkg = require('./package.json'); pkg.version = '$VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')"

# Commit the version bump
echo "Committing version bump..."
git add package.json CHANGELOG.md
git commit -m "chore: bump version to $VERSION"

# The commit exists now, so file-level rollback is no longer the right undo.
release_files_dirty=false
trap - ERR INT TERM

# Create the tag
echo "Creating tag $TAG..."
git tag "$TAG"

# Push the BRANCH first, then the tag. The tag push is what triggers the release
# workflow, so it must go last: if the branch push fails (e.g. the remote moved
# ahead), we abort with the tag still local-only and nothing published.
echo "Pushing $CURRENT_BRANCH to origin/$RELEASE_BRANCH..."
if ! git push origin "HEAD:refs/heads/$RELEASE_BRANCH"; then
  echo ""
  echo "Error: failed to push the release commit to origin/$RELEASE_BRANCH."
  echo "The tag $TAG was created locally but NOT pushed, so no release was published."
  echo ""
  echo "To undo the local release commit and tag:"
  echo "  git tag -d $TAG"
  echo "  git reset --hard HEAD~1"
  exit 1
fi

echo "Pushing tag $TAG (this triggers the release workflow)..."
git push origin "$TAG"

echo ""
echo "Done! Version $VERSION has been released."
echo "GitHub Actions will now build and publish the release."
echo ""
echo "Monitor the release at: https://github.com/happycollision/spry/actions"
