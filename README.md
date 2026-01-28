# CallMe

**Minimal plugin that lets Claude Code call you on the phone.**

Start a task, walk away. Your phone/watch rings when Claude is done, stuck, or needs a decision.

<img src="./call-me-comic-min.png" width="800" alt="CallMe comic strip">

- **Minimal plugin** - Does one thing: call you on the phone. No crazy setups.
- **Multi-turn conversations** - Talk through decisions naturally.
- **Works anywhere** - Smartphone, smartwatch, or even landline!
- **Tool-use composable** - Claude can e.g. do a web search while on a call with you.

---

## Quick Start

### 1. Get Required Accounts

You'll need:
- **Phone provider**: [Telnyx](https://telnyx.com) or [Twilio](https://twilio.com)
- **OpenAI API key**: For speech-to-text (required) and text-to-speech (optional)
- **ElevenLabs API key** (optional): For higher quality multilingual text-to-speech
- **ngrok account**: Free at [ngrok.com](https://ngrok.com) (for webhook tunneling)

### 2. Set Up Phone Provider

Choose **one** of the following:

<details>
<summary><b>Option A: Telnyx (Recommended - 50% cheaper)</b></summary>

1. Create account at [portal.telnyx.com](https://portal.telnyx.com) and verify your identity
2. [Buy a phone number](https://portal.telnyx.com/#/numbers/buy-numbers) (~$1/month)
3. [Create a Voice API application](https://portal.telnyx.com/#/call-control/applications):
   - Set webhook URL to `https://your-ngrok-url/twiml` and API version to v2
     - You can see your ngrok URL on the ngrok dashboard
   - Note your **Application ID** and **API Key**
4. [Verify the phone number](https://portal.telnyx.com/#/numbers/verified-numbers) you want to receive calls at
5. (Optional but recommended) Get your **Public Key** from Account Settings > Keys & Credentials for webhook signature verification

**Environment variables for Telnyx:**
```bash
CALLME_PHONE_PROVIDER=telnyx
CALLME_PHONE_ACCOUNT_SID=<Application ID>
CALLME_PHONE_AUTH_TOKEN=<API Key>
CALLME_TELNYX_PUBLIC_KEY=<Public Key>  # Optional: enables webhook security
```

</details>

<details>
<summary><b>Option B: Twilio (Not recommended - need to buy $20 of credits just to start and more expensive overall)</b></summary>

1. Create account at [twilio.com/console](https://www.twilio.com/console)
2. Use the free number your account comes with or [buy a new phone number](https://www.twilio.com/console/phone-numbers/incoming) (~$1.15/month)
3. Find your **Account SID** and **Auth Token** on the [Console Dashboard](https://www.twilio.com/console)

**Environment variables for Twilio:**
```bash
CALLME_PHONE_PROVIDER=twilio
CALLME_PHONE_ACCOUNT_SID=<Account SID>
CALLME_PHONE_AUTH_TOKEN=<Auth Token>
```

</details>

### 3. Set Environment Variables

Add these to `~/.claude/settings.json` (recommended) or export them in your shell:

```json
{
  "env": {
    "CALLME_PHONE_PROVIDER": "telnyx",
    "CALLME_PHONE_ACCOUNT_SID": "your-connection-id-or-account-sid",
    "CALLME_PHONE_AUTH_TOKEN": "your-api-key-or-auth-token",
    "CALLME_PHONE_NUMBER": "+15551234567",
    "CALLME_USER_PHONE_NUMBER": "+15559876543",
    "CALLME_OPENAI_API_KEY": "sk-...",
    "CALLME_NGROK_AUTHTOKEN": "your-ngrok-token",
    "CALLME_TTS_PROVIDER": "openai"
  }
}
```

#### Required Variables

| Variable | Description |
|----------|-------------|
| `CALLME_PHONE_PROVIDER` | `telnyx` (default) or `twilio` |
| `CALLME_PHONE_ACCOUNT_SID` | Telnyx Connection ID or Twilio Account SID |
| `CALLME_PHONE_AUTH_TOKEN` | Telnyx API Key or Twilio Auth Token |
| `CALLME_PHONE_NUMBER` | Phone number Claude calls from (E.164 format) |
| `CALLME_USER_PHONE_NUMBER` | Your phone number to receive calls |
| `CALLME_OPENAI_API_KEY` | OpenAI API key (required for realtime STT, optional for TTS) |
| `CALLME_NGROK_AUTHTOKEN` | ngrok auth token for webhook tunneling |

#### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_TTS_PROVIDER` | `openai` | TTS provider: `openai` or `elevenlabs` |
| `CALLME_TTS_VOICE` | `onyx` | Voice ID (OpenAI: alloy, echo, fable, onyx, nova, shimmer) |
| `CALLME_ELEVENLABS_API_KEY` | - | ElevenLabs API key (required if using elevenlabs TTS) |
| `CALLME_PORT` | `3333` | Local HTTP server port |
| `CALLME_NGROK_DOMAIN` | - | Custom ngrok domain (paid feature) |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech (3 minutes) |
| `CALLME_STT_SILENCE_DURATION_MS` | `800` | Silence duration to detect end of speech |
| `CALLME_TELNYX_PUBLIC_KEY` | - | Telnyx public key for webhook signature verification (recommended) |

#### TTS Provider Selection

**OpenAI TTS** (default): Good quality, lower cost, English-optimized.

**ElevenLabs TTS**: Higher quality voices with better multilingual support (Portuguese, Spanish, etc.). Requires separate API key from [elevenlabs.io](https://elevenlabs.io).

To use ElevenLabs:
```json
{
  "env": {
    "CALLME_TTS_PROVIDER": "elevenlabs",
    "CALLME_ELEVENLABS_API_KEY": "your-elevenlabs-key",
    "CALLME_TTS_VOICE": "voice-id-from-elevenlabs"
  }
}
```

### 4. Install Plugin

```bash
/install-github-mcp joaolucaswork/call-me
```

Restart Claude Code. Done!

---

## How It Works

```
Claude Code                    CallMe MCP Server (local)
    │                                    │
    │  "I finished the feature..."       │
    ▼                                    ▼
Plugin ────stdio──────────────────► MCP Server
                                         │
                                         ├─► ngrok tunnel
                                         │
                                         ▼
                                   Phone Provider (Telnyx/Twilio)
                                         │
                                         ▼
                                   Your Phone rings
                                   You speak
                                   Text returns to Claude
```

The MCP server runs locally and automatically creates an ngrok tunnel for phone provider webhooks.

---

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

### `speak_to_user`
Speak to the user without waiting for a response. Useful for acknowledging requests before time-consuming operations.

```typescript
await speak_to_user({
  call_id: callId,
  message: "Let me search for that information. Give me a moment..."
});
// Continue with your long-running task
const results = await performSearch();
// Then continue the conversation
const response = await continue_call({
  call_id: callId,
  message: `I found ${results.length} results...`
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

---

## Costs

| Service | Telnyx | Twilio |
|---------|--------|--------|
| Outbound calls | ~$0.007/min | ~$0.014/min |
| Phone number | ~$1/month | ~$1.15/month |

Speech services:
- **Speech-to-text (OpenAI)**: ~$0.006/min
- **Text-to-speech (OpenAI)**: ~$0.02/min
- **Text-to-speech (ElevenLabs)**: ~$0.30/1k characters (higher quality, better multilingual support)

**Total with OpenAI TTS**: ~$0.03-0.04/minute
**Total with ElevenLabs TTS**: varies based on message length

---

## Troubleshooting

### Claude doesn't use the tool
1. Check all required environment variables are set (ideally in `~/.claude/settings.json`)
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Call me to discuss the next steps when you're done."

### Call doesn't connect
1. Check the MCP server logs (stderr) with `claude --debug`
2. Verify your phone provider credentials are correct
3. Make sure ngrok can create a tunnel

### Audio issues
1. Ensure your phone number is verified with your provider
2. Check that the webhook URL in your provider dashboard matches your ngrok URL

### ngrok errors
1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3334`

---

## Development

```bash
cd server
bun install
bun run dev
```

---

## License

MIT
