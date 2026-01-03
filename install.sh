#!/bin/bash

set -e

echo "Hey Boss - Phone Call Plugin for Claude Code"
echo "============================================="
echo ""

# Check for Bun
if ! command -v bun &> /dev/null; then
    echo "Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

echo "Bun: $(bun --version)"

# Build MCP server
echo ""
echo "Building MCP server..."
cd mcp-server
bun install
bun run build
cd ..

echo "Build complete!"
echo ""

# Get absolute path
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Create .env if needed
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env file - please add your credentials"
fi

echo "============================================="
echo "Installation complete!"
echo ""
echo "Next: Add to Claude Code with:"
echo ""
echo "claude mcp add hey-boss \\"
echo "  -e TWILIO_ACCOUNT_SID=your_sid \\"
echo "  -e TWILIO_AUTH_TOKEN=your_token \\"
echo "  -e TWILIO_PHONE_NUMBER=+1234567890 \\"
echo "  -e USER_PHONE_NUMBER=+1234567890 \\"
echo "  -e OPENAI_API_KEY=sk-... \\"
echo "  -e PUBLIC_URL=https://your-url.ngrok.io \\"
echo "  -e PORT=3000 \\"
echo "  -- node \"$PLUGIN_DIR/mcp-server/dist/index.js\""
echo ""
echo "Then restart Claude Code."
