# Hey Boss

**MCP Plugin for Claude Code** - Enables Claude to call you on the phone when it needs your input, wants to report progress, or needs to discuss next steps.

When Claude completes a task, encounters a blocker, or needs a decision, it can call you to have a natural voice conversation. You talk, Claude listens, and work continues.

## Features

- **Voice Conversations**: Natural phone calls using Twilio + OpenAI (Whisper/TTS)
- **Multi-Turn Dialogue**: Back-and-forth conversations with follow-up questions
- **Status Reports**: Claude calls to update you on completed work
- **Claude-Controlled**: Claude decides what to say, when to ask follow-ups, and how to proceed
- **Cost Effective**: ~$0.05-0.08/min (6x cheaper than alternatives)

## Quick Install

```bash
# Add to Claude Code with one command
claude mcp add hey-boss -- node /path/to/hey-boss/mcp-server/dist/index.js

# Or clone and build first
git clone https://github.com/ZeframLou/hey-boss.git
cd hey-boss && ./install.sh
```

## How It Works

Claude Code provides ALL the intelligence. This tool is just a voice bridge.

```
Claude Code (the AI)
    │ "I finished the auth system. Let me update the boss..."
    │
    ▼ initiate_call("Hey! I just finished...")
┌────────────────────────────────┐
│  Hey Boss (voice bridge)       │
│  • Text → Speech (OpenAI TTS)  │
│  • Speech → Text (Whisper)     │
│  • No AI decision-making       │
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  Your Phone                    │
│  You hear: "Hey! I just..."    │
│  You say: "Great work! Next..."│
└────────────────────────────────┘
    │
    ▼
Claude receives: "Great work! Next..."
Claude decides what to do next
```

## Prerequisites

1. **Twilio Account** - [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
   - Get a phone number with voice capabilities
   - Note your Account SID and Auth Token

2. **OpenAI Account** - [platform.openai.com](https://platform.openai.com)
   - Create an API key with access to Whisper and TTS

3. **Public URL** - For Twilio webhooks
   - Production: Your domain with HTTPS
   - Development: [ngrok](https://ngrok.com) (`ngrok http 3000`)

## Installation

### Option 1: Claude CLI (Recommended)

```bash
# Clone and build
git clone https://github.com/ZeframLou/hey-boss.git
cd hey-boss
./install.sh

# Add to Claude Code
claude mcp add hey-boss \
  -e TWILIO_ACCOUNT_SID=ACxxxxx \
  -e TWILIO_AUTH_TOKEN=your_token \
  -e TWILIO_PHONE_NUMBER=+1234567890 \
  -e USER_PHONE_NUMBER=+1234567890 \
  -e OPENAI_API_KEY=sk-xxxxx \
  -e PUBLIC_URL=https://your-url.ngrok.io \
  -e PORT=3000 \
  -- node "$(pwd)/mcp-server/dist/index.js"
```

### Option 2: Manual Configuration

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "hey-boss": {
      "command": "node",
      "args": ["/absolute/path/to/hey-boss/mcp-server/dist/index.js"],
      "env": {
        "TWILIO_ACCOUNT_SID": "ACxxxxx",
        "TWILIO_AUTH_TOKEN": "your_token",
        "TWILIO_PHONE_NUMBER": "+1234567890",
        "USER_PHONE_NUMBER": "+1234567890",
        "OPENAI_API_KEY": "sk-xxxxx",
        "PUBLIC_URL": "https://your-url.ngrok.io",
        "PORT": "3000"
      }
    }
  }
}
```

Then restart Claude Code.

## Available Tools

### `initiate_call`
Start a phone call with the user.

```typescript
const { callId, response } = await initiate_call({
  message: "Hey! I finished the authentication system. Should I move on to the API endpoints next?"
});
// User responds verbally, you receive text
```

### `continue_call`
Continue an active call with follow-up questions.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "Got it. Should I include rate limiting on those endpoints?"
});
```

### `end_call`
End the call with a closing message.

```typescript
await end_call({
  call_id: callId,
  message: "Perfect! I'll get started on that. Talk soon!"
});
```

## Example: Status Report

```typescript
// Claude just finished a major feature
const { callId, response } = await initiate_call({
  message: "Hey! I just finished implementing JWT authentication with refresh tokens. Everything's tested and working. Want me to walk you through it, or should I move on to the next task?"
});

// Based on user response, either explain or continue
if (response.includes("walk me through")) {
  await continue_call({
    call_id: callId,
    message: "Sure! I created a TokenService class that handles generation and validation..."
  });
}

await end_call({
  call_id: callId,
  message: "Sounds good! I'll start on the user management endpoints next. I'll call you when that's done!"
});
```

## When Claude Will Call You

Based on the skill definition, Claude may call when:
- **Task completed** - To report progress and ask what's next
- **Decision needed** - Architectural choices, technology selection
- **Blocked** - Needs clarification to continue
- **Milestone reached** - Celebrating progress, discussing next phase

Claude won't call for simple yes/no questions or non-urgent matters.

## Cost Breakdown

| Service | Cost |
|---------|------|
| Twilio (phone) | ~$0.01-0.02/min |
| Whisper (speech-to-text) | ~$0.006/min |
| OpenAI TTS (text-to-speech) | ~$0.03-0.05/min |
| **Total** | **~$0.05-0.08/min** |

Typical 2-minute call: **$0.10-0.16**

## Project Structure

```
hey-boss/
├── mcp-server/
│   ├── src/
│   │   ├── index.ts        # MCP server entry point
│   │   └── phone-call.ts   # Call management
│   └── dist/               # Built output
├── skills/
│   └── phone-input/
│       └── SKILL.md        # When to use this tool
├── .env.example            # Environment template
├── install.sh              # Build script
└── README.md
```

## Troubleshooting

### Call doesn't connect
1. Check ngrok is running: `ngrok http 3000`
2. Verify PUBLIC_URL in .env matches ngrok URL
3. Ensure Twilio phone number has voice capability
4. Check Twilio credentials are correct

### No audio / silence
1. Verify OpenAI API key is valid
2. Check OpenAI account has credits
3. View logs: `~/.claude/logs/`

### Claude doesn't use the tool
1. Restart Claude Code after adding MCP server
2. Verify server appears in Claude's tools
3. Try explicitly: "Call me to discuss the next steps"

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account ID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes | Your Twilio number (caller ID) |
| `USER_PHONE_NUMBER` | Yes | Your phone number (to receive calls) |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `PUBLIC_URL` | Yes | Public HTTPS URL for webhooks |
| `PORT` | No | Server port (default: 3000) |

## License

MIT

## Links

- [Issues](https://github.com/ZeframLou/hey-boss/issues)
- [Twilio Docs](https://www.twilio.com/docs)
- [OpenAI Docs](https://platform.openai.com/docs)
- [MCP Documentation](https://modelcontextprotocol.io)
