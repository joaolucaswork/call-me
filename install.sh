#!/bin/bash
# Development build script - for contributing to hey-boss
# Users should install via: claude mcp add hey-boss -- npx -y hey-boss-mcp

set -e

echo "Building hey-boss for development..."

if ! command -v bun &> /dev/null; then
    echo "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

cd mcp-server
bun install
bun run build
cd ..

echo "Build complete!"
echo ""
echo "For users: Install via npm (no build required):"
echo "  claude mcp add hey-boss -- npx -y hey-boss-mcp"
echo ""
echo "For development: Test local build with:"
echo "  claude mcp add hey-boss-dev -- node $(pwd)/mcp-server/dist/index.js"
