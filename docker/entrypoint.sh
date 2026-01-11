#!/bin/bash
set -e

cd /workspace

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    bun install
fi

# Build sp if not present
if [ ! -f "dist/sp" ]; then
    echo "Building sp..."
    bun run build
fi

# Run the command (default: bash)
exec "$@"
