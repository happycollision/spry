#!/usr/bin/env bash
# taspr installation script
# Usage: curl -fsSL https://raw.githubusercontent.com/happycollision/taspr/main/install.sh | bash

set -euo pipefail

# Configuration
REPO="happycollision/taspr"
INSTALL_DIR="${TASPR_INSTALL_DIR:-$HOME/.taspr}"
BIN_DIR="${TASPR_BIN_DIR:-$INSTALL_DIR/bin}"

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

# Get the latest release version from GitHub
get_latest_version() {
    local version
    if command -v curl &> /dev/null; then
        version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    elif command -v wget &> /dev/null; then
        version=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    else
        error "Neither curl nor wget found. Please install one of them."
    fi

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
install_taspr() {
    local os arch version binary_name download_url

    info "Detecting system..."
    os=$(detect_os)
    arch=$(detect_arch)
    info "Detected: $os-$arch"

    # Get version (use TASPR_VERSION env var if set, otherwise get latest)
    if [ -n "${TASPR_VERSION:-}" ]; then
        version="$TASPR_VERSION"
        info "Using specified version: $version"
    else
        info "Fetching latest version..."
        version=$(get_latest_version)
        info "Latest version: $version"
    fi

    # Construct binary name and download URL
    # Binary naming convention: taspr-<os>-<arch>
    binary_name="taspr-${os}-${arch}"
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
        error "Failed to download taspr from $download_url"
    fi

    # Install the binary
    local target_path="$BIN_DIR/taspr"
    if [ "$os" = "windows" ]; then
        target_path="$BIN_DIR/taspr.exe"
    fi

    mv "$tmp_file" "$target_path"
    chmod +x "$target_path"

    success "taspr $version installed to $target_path"

    # Check if bin directory is in PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        echo ""
        warn "taspr was installed, but $BIN_DIR is not in your PATH."
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
    fi

    # Verify installation
    if [ -x "$target_path" ]; then
        success "Installation complete!"
        echo ""
        echo "Run 'taspr --help' to get started."
    else
        error "Installation failed: binary not executable"
    fi
}

# Run the installation
install_taspr
