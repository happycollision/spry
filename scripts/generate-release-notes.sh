#!/usr/bin/env bash
# Generate release notes from changelog with installation instructions appended
# Usage: ./scripts/generate-release-notes.sh <version> > release_notes.md

set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi

# Use the tag for prereleases (installer may not be on main yet), main for full releases
if [[ "$VERSION" == *-* ]]; then
  INSTALL_REF="v$VERSION"
else
  INSTALL_REF="main"
fi

# Extract content between this version and the next version header
awk -v ver="$VERSION" '
  BEGIN { found=0; printing=0 }
  /^## \[/ {
    if (printing) exit
    if ($0 ~ "\\[" ver "\\]") { found=1; printing=1; next }
  }
  printing { print }
' CHANGELOG.md

# Append installation instructions (split heredocs to handle variable expansion correctly)
cat << EOF

## Installation

### Quick Install (macOS/Linux)

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/happycollision/spry/$INSTALL_REF/install.sh | bash -s -- v$VERSION
\`\`\`
EOF

cat << 'EOF'

### Manual Download

Download the appropriate binary for your platform from the assets below:

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `sp-darwin-aarch64` |
| macOS (Intel) | `sp-darwin-x64` |
| Linux (x64) | `sp-linux-x64` |
| Linux (ARM64) | `sp-linux-aarch64` |
| Windows (x64) | `sp-windows-x64.exe` |

After downloading, make the binary executable and move it to your PATH:

```bash
chmod +x sp-*
sudo mv sp-* /usr/local/bin/sp
```
EOF
