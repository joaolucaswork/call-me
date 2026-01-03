# Hey Boss 📞

**MCP Plugin for Claude Code** - Enables Claude to call you on the phone when it needs your input, clarification, or decisions.

When Claude is working on a task and needs real-time input, it can invoke the `call_user_for_input` tool to initiate a phone call, explain what it needs, listen to your response, ask clarifying questions, and continue working with your guidance.

## Features

- **Claude-Invoked Tool**: Shows up in Claude Code's available tools
- **Natural Voice Conversation**: Uses OpenAI's Realtime API for seamless voice interaction
- **Smart Questioning**: AI asks follow-up questions to get complete answers
- **Production Ready**: Built with Twilio for reliable telecommunications
- **MCP Standard**: Follows Model Context Protocol for easy integration
- **Auto-Discovery**: Includes skill definition so Claude knows when to use it

## Quick Start

```bash
# Clone and install
git clone https://github.com/ZeframLou/hey-boss.git
cd hey-boss
./install.sh

# Configure your credentials
nano .env

# Start ngrok for development
ngrok http 3000  # Copy the HTTPS URL to .env as PUBLIC_URL
```

Then add to Claude Code's MCP settings (see [Installation](#installation) below).

## How It Works

**Key Insight:** Claude Code (the main AI) provides ALL the intelligence. The tool is just a "dumb" voice bridge that converts speech ↔ text. No redundant AI!

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code (YOU - the only AI)                                │
│  "I need to decide between PostgreSQL and MongoDB..."           │
└──────────┬──────────────────────────────────────────────────────┘
           │ Invokes: call_user_for_input("Should we use...")
           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Hey Boss MCP Tool (Dumb voice bridge)                          │
│  - Text → Speech (OpenAI TTS)                                   │
│  - Speech → Text (Whisper)                                      │
│  - No AI decision-making!                                       │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────┐                    ┌─────────────────────────────┐
│   Twilio     │───────────────────►│  Your Phone  ☎              │
│ (Phone call) │                    │                             │
└──────────────┘                    └────────┬────────────────────┘
                                             │
    Voice: "Should we use PostgreSQL or MongoDB?"
                                             │ You speak:
                                             ▼ "Use PostgreSQL..."
                                    ┌────────────────────┐
                                    │  Whisper STT       │
                                    │  (Transcription)   │
                                    └────────┬───────────┘
                                             │ Text transcript
                                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code receives: "Use PostgreSQL, we already have..."     │
│  Decides next action: "Perfect, proceeding with PostgreSQL..."  │
└─────────────────────────────────────────────────────────────────┘
```

**Claude decides:**
- When to call you (based on skill definition)
- What question to ask
- How to interpret your response
- What to do next

**The tool only handles:** Voice ↔ Text conversion (cheap, simple, no intelligence needed)

## Prerequisites

### 1. Bun Runtime
```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Twilio Account (for phone calls)
1. Sign up at [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
2. Get a phone number with **voice capabilities**
3. Note your **Account SID** and **Auth Token** from the console

### 3. OpenAI Account (for voice conversion only)
1. Sign up at [platform.openai.com](https://platform.openai.com)
2. Create an **API key**
3. Ensure you have access to:
   - **Whisper API** (speech-to-text)
   - **TTS API** (text-to-speech)

Note: We're NOT using GPT-4 Realtime API - that's expensive and redundant!

### 4. Public URL (for webhooks)
- **Production**: Use your domain with HTTPS
- **Development**: Use [ngrok](https://ngrok.com)
  ```bash
  ngrok http 3000
  # Copy the HTTPS URL (e.g., https://abc123.ngrok.io)
  ```

## Installation

### Step 1: Install the Plugin

```bash
git clone https://github.com/ZeframLou/hey-boss.git
cd hey-boss
./install.sh
```

### Step 2: Configure Credentials

Edit `.env` with your credentials:

```bash
cp .env.example .env
nano .env
```

```.env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1234567890          # Your Twilio number
USER_PHONE_NUMBER=+1234567890            # Your personal number
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PUBLIC_URL=https://your-ngrok-url.ngrok.io  # Or your production domain
PORT=3000
```

### Step 3: Add to Claude Code

Add the MCP server to your Claude Code configuration.

**Find your Claude Code config:**
- macOS: `~/.claude/settings.json`
- Linux: `~/.config/claude/settings.json`
- Windows: `%APPDATA%\Claude\settings.json`

**Add this to your `mcpServers` section:**

```json
{
  "mcpServers": {
    "hey-boss": {
      "command": "node",
      "args": ["/absolute/path/to/hey-boss/mcp-server/dist/index.js"],
      "env": {
        "TWILIO_ACCOUNT_SID": "ACxxxxx...",
        "TWILIO_AUTH_TOKEN": "your_token",
        "TWILIO_PHONE_NUMBER": "+1234567890",
        "USER_PHONE_NUMBER": "+1234567890",
        "OPENAI_API_KEY": "sk-xxxxx...",
        "PUBLIC_URL": "https://your-ngrok-url.ngrok.io",
        "PORT": "3000"
      }
    }
  }
}
```

**Or use the Claude Code CLI:**

```bash
# Get the absolute path first
PLUGIN_PATH=$(cd /path/to/hey-boss && pwd)

# Add the MCP server
claude mcp add hey-boss \
  --transport stdio \
  --command node \
  --args "$PLUGIN_PATH/mcp-server/dist/index.js"
```

### Step 4: Restart Claude Code

Restart Claude Code to load the new MCP server. The `call_user_for_input` tool will now be available.

## Usage

### Automatic Invocation (Recommended)

Claude Code will **automatically** invoke the phone call tool when it determines it needs your input based on the skill definition in `skills/phone-input/SKILL.md`.

Examples of when Claude might call:
- "I need to decide between PostgreSQL and MongoDB for this feature"
- "Should I proceed with dropping this database table?"
- "The API documentation is unclear - which endpoint should I use?"

### Manual Invocation (For Testing)

You can also explicitly ask Claude to call you:

```
User: "Call me to discuss the authentication approach"
Claude: *invokes call_user_for_input tool*
```

### What Happens During a Call

1. **Your phone rings** (from your Twilio number)
2. **AI voice greets you**: "Hello, I'm calling on behalf of Claude Code..."
3. **AI explains the question**: "Claude needs to know whether to use PostgreSQL or MongoDB..."
4. **You respond** naturally by speaking
5. **AI asks clarifying questions** if needed
6. **AI confirms**: "Thank you, I'll relay this to Claude"
7. **Call ends** and Claude receives the full transcript

## Project Structure

```
hey-boss/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest for Claude Code
├── mcp-server/                  # MCP server implementation
│   ├── src/
│   │   ├── index.ts             # MCP server entry point
│   │   └── phone-call.ts        # Phone call implementation
│   ├── package.json
│   ├── tsconfig.json
│   └── dist/                    # Built output (created by install.sh)
├── skills/
│   └── phone-input/
│       └── SKILL.md             # Skill definition (when to use this tool)
├── .env.example                 # Environment template
├── .env                         # Your credentials (git-ignored)
├── install.sh                   # Installation script
└── README.md
```

## Development

### Building the MCP Server

```bash
cd mcp-server
bun install
bun run build
```

### Testing the Tool

```bash
# Start ngrok
ngrok http 3000

# Update .env with the ngrok URL
PUBLIC_URL=https://abc123.ngrok.io

# Test the MCP server directly
cd mcp-server
node dist/index.js
# (This will start the MCP server in stdio mode)
```

### Testing from Claude Code

Ask Claude to invoke the tool:

```
User: "Test the phone call tool by calling me about what color the submit button should be"
Claude: *invokes call_user_for_input with the question*
```

## Available Tool

Once installed, Claude Code will have access to:

### `call_user_for_input`

**Description:** Call the user on the phone to get input, clarification, or decision.

**Parameters:**
- `question` (string, required): What Claude needs to communicate
- `urgency` (string, optional): "normal" or "high" (default: "normal")

**Returns:**
- Transcript of the user's response
- Call duration
- Call status (completed/failed/timeout)

**Example:**
```typescript
const result = await call_user_for_input({
  question: "Should I use REST or GraphQL for the new API? REST is simpler but GraphQL gives more flexibility.",
  urgency: "normal"
});

// Result:
// {
//   transcript: "Use REST for now. We can migrate to GraphQL later if needed...",
//   duration: 45,
//   status: "completed"
// }
```

## Skill Auto-Invocation

The included skill definition (`skills/phone-input/SKILL.md`) teaches Claude **when** to use this tool:

**Use when:**
- Complex decisions requiring explanation
- Time-sensitive questions
- Blocking issues that need immediate input
- Situations where text is insufficient

**Don't use when:**
- Simple yes/no questions
- Non-urgent clarifications
- Information already provided

Claude will make the judgment call based on context.

## Troubleshooting

### "Failed to complete phone call"

**Check:**
1. Is ngrok running and URL in .env matches?
2. Are Twilio credentials correct?
3. Is Twilio phone number verified and has voice capability?
4. Is OpenAI API key valid and has Realtime API access?
5. Check Claude Code logs: `~/.claude/logs/mcp-hey-boss.log`

### Call connects but no audio

**Check:**
1. OpenAI API key is valid
2. You have credits in OpenAI account
3. Check OpenAI dashboard for errors

### Claude doesn't invoke the tool

**Check:**
1. MCP server is loaded (check Claude Code settings)
2. Restart Claude Code after adding the server
3. The tool should appear in Claude's available tools list
4. Try explicitly asking: "Call me to discuss X"

### Permission denied on install.sh

```bash
chmod +x install.sh
./install.sh
```

## Security Best Practices

1. **Never commit `.env`** - Contains sensitive credentials
2. **Use environment variables** - Don't hardcode credentials
3. **HTTPS required** - Twilio requires HTTPS webhooks in production
4. **Rotate keys regularly** - Especially if exposed
5. **Monitor usage** - Check Twilio and OpenAI dashboards for unexpected usage
6. **Validate phone numbers** - Only allow calls to expected numbers

## Cost Estimates

**Per-minute costs:**
- **Twilio** (phone call): ~$0.01-0.02/min
- **Whisper API** (speech-to-text): ~$0.006/min
- **OpenAI TTS** (text-to-speech): ~$0.03-0.05/min
- **Total: ~$0.05-0.08/min**

**Typical 2-minute call: $0.10-0.16** 🎉

### Cost Breakdown

This implementation is **6x cheaper** than the original design by eliminating the expensive GPT-4 Realtime API ($0.30/min):

**Old approach:**
- Used OpenAI Realtime API for everything
- Cost: $0.30-0.40/min
- Had redundant AI (GPT-4 + Claude)

**New approach:**
- **Claude Code provides ALL intelligence** (you already have it!)
- Tool only does voice ↔ text conversion
- Whisper for STT: $0.006/min
- OpenAI TTS for voice: ~$0.04/min
- Cost: $0.05-0.08/min

Monitor usage:
- Twilio Console: [console.twilio.com](https://console.twilio.com)
- OpenAI Dashboard: [platform.openai.com/usage](https://platform.openai.com/usage)

## Production Deployment

### Recommended Setup

1. **Deploy to a VPS** with:
   - Node.js 18+ installed
   - Domain with SSL certificate
   - Firewall configured for port 3000

2. **Configure systemd service:**

```ini
# /etc/systemd/system/hey-boss.service
[Unit]
Description=Hey Boss MCP Server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/hey-boss
ExecStart=/usr/bin/node /opt/hey-boss/mcp-server/dist/index.js
Restart=on-failure
EnvironmentFile=/opt/hey-boss/.env

[Install]
WantedBy=multi-user.target
```

3. **Start and enable:**

```bash
sudo systemctl enable hey-boss
sudo systemctl start hey-boss
sudo systemctl status hey-boss
```

### Using a Process Manager

```bash
# With PM2
pm2 start mcp-server/dist/index.js --name hey-boss
pm2 save
pm2 startup
```

## Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account ID | `ACxxxxx...` |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token | `your_token` |
| `TWILIO_PHONE_NUMBER` | Yes | Your Twilio number | `+1234567890` |
| `USER_PHONE_NUMBER` | Yes | Your personal number | `+1234567890` |
| `OPENAI_API_KEY` | Yes | OpenAI API key | `sk-xxxxx...` |
| `PUBLIC_URL` | Yes | Public HTTPS URL | `https://example.com` |
| `PORT` | No | Server port (default: 3000) | `3000` |

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Make your changes
4. Test with Claude Code
5. Submit a pull request

## License

MIT

## Support

- **Issues**: [github.com/ZeframLou/hey-boss/issues](https://github.com/ZeframLou/hey-boss/issues)
- **Discussions**: [github.com/ZeframLou/hey-boss/discussions](https://github.com/ZeframLou/hey-boss/discussions)
- **Twilio Docs**: [twilio.com/docs](https://www.twilio.com/docs)
- **OpenAI Realtime API**: [platform.openai.com/docs](https://platform.openai.com/docs)
- **MCP Documentation**: [modelcontextprotocol.io](https://modelcontextprotocol.io)

---

**Made with ❤️ for the Claude Code community**
