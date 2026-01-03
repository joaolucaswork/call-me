# Hey Boss

**MCP Plugin for Claude Code** - Claude calls you on the phone when it needs your input, wants to report progress, or needs to discuss next steps.

## Install

```bash
claude mcp add hey-boss \
  -e TWILIO_ACCOUNT_SID=ACxxxxx \
  -e TWILIO_AUTH_TOKEN=your_token \
  -e TWILIO_PHONE_NUMBER=+1234567890 \
  -e USER_PHONE_NUMBER=+1234567890 \
  -e OPENAI_API_KEY=sk-xxxxx \
  -e PUBLIC_URL=https://your-url.ngrok.io \
  -- npx -y hey-boss-mcp
```

That's it. Restart Claude Code and the tools are available.

## Prerequisites

1. **Twilio Account** - [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
   - Get a phone number with voice capabilities
   - Note your Account SID and Auth Token

2. **OpenAI Account** - [platform.openai.com](https://platform.openai.com)
   - Create an API key with access to Whisper and TTS

3. **Public URL** - For Twilio webhooks
   - Production: Your domain with HTTPS
   - Development: [ngrok](https://ngrok.com) (`ngrok http 3000`)

## How It Works

Claude Code controls everything. This tool just converts voice to text and back.

```
Claude Code
    │ "I finished the feature. Let me call the boss..."
    ▼
Hey Boss (voice bridge: TTS + Whisper)
    │
    ▼
Your Phone rings → You speak → Text returns to Claude
```

## Tools

### `initiate_call`
Start a phone call.

```typescript
const { callId, response } = await initiate_call({
  message: "Hey! I finished the auth system. What should I work on next?"
});
```

### `continue_call`
Continue with follow-up questions.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "Got it. Should I add rate limiting too?"
});
```

### `end_call`
End the call.

```typescript
await end_call({
  call_id: callId,
  message: "Perfect, I'll get started. Talk soon!"
});
```

## When Claude Calls You

- **Task completed** - Status report, asking what's next
- **Decision needed** - Architecture, technology choices
- **Blocked** - Needs clarification to continue

Claude won't call for simple yes/no questions.

## Cost

~$0.05-0.08/min (Twilio + Whisper + TTS)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio account ID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio number |
| `USER_PHONE_NUMBER` | Your phone number |
| `OPENAI_API_KEY` | OpenAI API key |
| `PUBLIC_URL` | Public HTTPS URL for webhooks |
| `PORT` | Server port (default: 3000) |

## Development

```bash
git clone https://github.com/ZeframLou/hey-boss.git
cd hey-boss/mcp-server
bun install && bun run build
```

## License

MIT
