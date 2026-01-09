#!/usr/bin/env bash
# Spry installation script
# Usage: curl -fsSL https://raw.githubusercontent.com/happycollision/spry/main/install.sh | bash
#        curl -fsSL ... | bash -s -- v0.1.0-alpha.1   # specific version
#        curl -fsSL ... | bash -s -- --prerelease     # latest prerelease

set -euo pipefail

# Configuration
REPO="happycollision/spry"
INSTALL_DIR="${SPRY_INSTALL_DIR:-$HOME/.spry}"
BIN_DIR="${SPRY_BIN_DIR:-$INSTALL_DIR/bin}"

# Parse arguments
REQUESTED_VERSION=""
INCLUDE_PRERELEASE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --prerelease|-p)
            INCLUDE_PRERELEASE=true
            shift
            ;;
        v*)
            REQUESTED_VERSION="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() {
    printf "${BLUE}info${NC}: %s\n" "$1"
}

success() {
    printf "${GREEN}success${NC}: %s\n" "$1"
}

warn() {
    printf "${YELLOW}warn${NC}: %s\n" "$1"
}

error() {
    printf "${RED}error${NC}: %s\n" "$1" >&2
    exit 1
}

# Detect OS
detect_os() {
    local os
    os="$(uname -s)"
    case "$os" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "darwin" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
        *)       error "Unsupported operating system: $os" ;;
    esac
}

# Detect architecture
detect_arch() {
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)  echo "x64" ;;
        aarch64|arm64) echo "aarch64" ;;
        *)             error "Unsupported architecture: $arch" ;;
    esac
}

# Get the latest stable release version from GitHub
get_latest_stable_version() {
    local version
    if command -v curl &> /dev/null; then
        version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    elif command -v wget &> /dev/null; then
        version=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    else
        error "Neither curl nor wget found. Please install one of them."
    fi

    if [ -z "$version" ]; then
        error "No stable release found. Use --prerelease flag or specify a version like 'v0.1.0-alpha.1'"
    fi

    echo "$version"
}

# Get the latest release version from GitHub (including prereleases)
get_latest_prerelease_version() {
    local version response
    if command -v curl &> /dev/null; then
        response=$(curl -fsSL "https://api.github.com/repos/$REPO/releases")
    elif command -v wget &> /dev/null; then
        response=$(wget -qO- "https://api.github.com/repos/$REPO/releases")
    else
        error "Neither curl nor wget found. Please install one of them."
    fi

    # Get the first (most recent) release tag
    version=$(echo "$response" | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')

    if [ -z "$version" ]; then
        error "Could not determine latest version. Check https://github.com/$REPO/releases"
    fi

    echo "$version"
}

# Download file
download() {
    local url="$1"
    local output="$2"

    if command -v curl &> /dev/null; then
        curl -fsSL "$url" -o "$output"
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O "$output"
    else
        error "Neither curl nor wget found. Please install one of them."
    fi
}

# Main installation function
install_spry() {
    local os arch version binary_name download_url

    info "Detecting system..."
    os=$(detect_os)
    arch=$(detect_arch)
    info "Detected: $os-$arch"

    # Get version: CLI arg > env var > latest stable (or prerelease with flag)
    if [ -n "$REQUESTED_VERSION" ]; then
        version="$REQUESTED_VERSION"
        info "Using specified version: $version"
    elif [ -n "${SPRY_VERSION:-}" ]; then
        version="$SPRY_VERSION"
        info "Using specified version: $version"
    elif [ "$INCLUDE_PRERELEASE" = true ]; then
        info "Fetching latest version (including prereleases)..."
        version=$(get_latest_prerelease_version)
        info "Latest version: $version"
    else
        info "Fetching latest stable version..."
        version=$(get_latest_stable_version)
        info "Latest version: $version"
    fi

    # Construct binary name and download URL
    # Binary naming convention: sp-<os>-<arch>
    binary_name="sp-${os}-${arch}"
    if [ "$os" = "windows" ]; then
        binary_name="${binary_name}.exe"
    fi

    download_url="https://github.com/$REPO/releases/download/$version/$binary_name"

    info "Downloading $binary_name..."

    # Create directories
    mkdir -p "$BIN_DIR"

    # Download the binary
    local tmp_file
    tmp_file=$(mktemp)
    if ! download "$download_url" "$tmp_file"; then
        rm -f "$tmp_file"
        error "Failed to download sp from $download_url"
    fi

    # Install the binary
    local target_path="$BIN_DIR/sp"
    if [ "$os" = "windows" ]; then
        target_path="$BIN_DIR/sp.exe"
    fi

    mv "$tmp_file" "$target_path"
    chmod +x "$target_path"

    success "Spry $version installed to $target_path"

    # Check if bin directory is in PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        echo ""
        warn "Spry was installed, but $BIN_DIR is not in your PATH."
        echo ""
        echo "To add it to your PATH, run one of the following:"
        echo ""

        local shell_name
        shell_name=$(basename "$SHELL")

        case "$shell_name" in
            bash)
                echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc"
                echo "  source ~/.bashrc"
                ;;
            zsh)
                echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc"
                echo "  source ~/.zshrc"
                ;;
            fish)
                echo "  echo 'set -gx PATH \"$BIN_DIR\" \$PATH' >> ~/.config/fish/config.fish"
                echo "  source ~/.config/fish/config.fish"
                ;;
            *)
                echo "  export PATH=\"$BIN_DIR:\$PATH\""
                echo ""
                echo "Add the above line to your shell's configuration file."
                ;;
        esac
        echo ""
    else
        info "$BIN_DIR is already in your PATH"
    fi

    # Verify installation
    if [ -x "$target_path" ]; then
        success "Installation complete!"
        echo ""
        if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
            echo "Run 'sp --help' to get started."
        else
            echo "After updating your PATH (see above), run 'sp --help' to get started."
        fi
    else
        error "Installation failed: binary not executable"
    fi
}

# Run the installation
install_spry
