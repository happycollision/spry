#!/usr/bin/env bash
# Release script for taspr
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

# Validate version format (basic semver with optional prerelease)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format '$VERSION'"
  echo "Expected format: X.Y.Z or X.Y.Z-prerelease"
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

echo "Releasing version $VERSION (tag: $TAG)"

# Update package.json version
echo "Updating package.json version to $VERSION..."
bun -e "const pkg = require('./package.json'); pkg.version = '$VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')"

# Commit the version bump
echo "Committing version bump..."
git add package.json
git commit -m "chore: bump version to $VERSION"

# Create the tag
echo "Creating tag $TAG..."
git tag "$TAG"

# Push the commit and tag
echo "Pushing to remote..."
git push
git push origin "$TAG"

echo ""
echo "Done! Version $VERSION has been released."
echo "GitHub Actions will now build and publish the release."
echo ""
echo "Monitor the release at: https://github.com/happycollision/taspr/actions"
