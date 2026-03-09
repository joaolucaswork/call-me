# WhatsApp-Call Integration Design

## Problem
WhatsApp messages and phone calls are completely independent systems. When a user sends a WhatsApp message during an active call, it either spawns a new Claude session or sits in a queue. The user wants WhatsApp messages to route to the active call session by default.

## Design

### 1. Message Routing Logic

When a WhatsApp message arrives:

```
Message arrives → Parse prefix
  ├─ /nova → Always spawn new session (ignore active call)
  ├─ /s:<name> → Route to named session (future)
  └─ No prefix → Check for active call with same phone number
       ├─ Active call found → Inject message into call session (via MCP notification or API)
       └─ No active call → Current behavior (spawn if no MCP, queue if MCP connected)
```

### 2. Phone Number Matching

Match WhatsApp sender to active call by normalizing both phone numbers:
- WhatsApp: already normalized via `formatPhone()`
- Call: `state.userPhoneNumber` from Twilio (E.164 format, e.g., +5581999...)
- Strip `+` and non-digits, compare

### 3. Message Injection to Active Call

When a WhatsApp message matches an active call's phone number:

**Option A: Speak the message content into the call** — Bad UX, the user sent text because they wanted text.

**Option B: Make the message available via `read_whatsapp` in the MCP session** — Already works if the MCP session polls. But spawned CLI sessions don't poll.

**Option C: Notify the active MCP/CLI session** — The spawned Claude CLI is a detached process. We can't easily inject messages.

**Chosen approach: Hybrid**
1. Store the message normally (existing behavior)
2. If there's an active call with matching phone number AND an MCP session is connected:
   - Send a notification via the MCP session's notification mechanism
   - The MCP tool descriptions already tell Claude to use `read_whatsapp` periodically
3. If the call was spawned as a CLI session (no MCP):
   - The spawned CLI instructions already include "check WhatsApp periodically"
   - Add a more prominent instruction to check WhatsApp frequently
4. For the current MCP session (this conversation):
   - The `onNewMessage` callback in http-server.ts should notify connected MCP sessions
   - Add a new API endpoint `/api/whatsapp/notify` that MCP sessions can subscribe to

**Simpler approach (recommended):**
- When WhatsApp message arrives during active call with same number:
  - DON'T spawn a new session
  - Store message normally
  - Send a brief TTS notification on the active call: "Você enviou uma mensagem no WhatsApp, estou lendo..."
  - The active Claude session reads it via `read_whatsapp`

### 4. Tag/Prefix System

Parse WhatsApp messages for command prefixes:

| Prefix | Action | Example |
|--------|--------|---------|
| `/nova` or `/new` | Force new session | `/nova investigue o bug no projeto X` |
| `/s:<name>` | Route to named session | `/s:reino continue o deploy` |
| (none) | Route to active call if exists, else default behavior | `como está o progresso?` |

Implementation: Add `parseMessagePrefix()` in whatsapp.ts that returns `{ prefix: string | null, sessionName: string | null, cleanMessage: string }`.

### 5. Twilio-Only Cleanup

Remove Telnyx provider and related code:
- Delete `providers/phone-telnyx.ts`
- Remove Telnyx webhook handling from `phone-call.ts`
- Remove Telnyx signature validation from `webhook-security.ts`
- Simplify `providers/index.ts` to always use Twilio
- Update env var documentation

### 6. Files to Modify

| File | Changes |
|------|---------|
| `whatsapp.ts` | Add `parseMessagePrefix()`, modify `ingestMessage()` to parse prefixes |
| `http-server.ts` | Modify `onNewMessage` to check active calls before spawning, add call notification |
| `phone-call.ts` | Add `getActiveCallByPhone()` method, add `notifyWhatsAppMessage()` for TTS notification |
| `claude-spawner.ts` | Update spawn instructions to emphasize WhatsApp checking during calls |
| `providers/index.ts` | Remove Telnyx, hardcode Twilio |
| `providers/phone-telnyx.ts` | DELETE |
| `webhook-security.ts` | Remove Telnyx signature validation |

### 7. Data Flow (Happy Path)

1. Lucas is on a call with Claude (call-1, phone +5581...)
2. Lucas sends WhatsApp: "verifique o arquivo main.ts"
3. Kapso webhook → whatsapp.handleWebhook() → ingestMessage()
4. No prefix detected → check active calls
5. CallManager.getActiveCallByPhone("+5581...") → returns call-1
6. Play TTS on call: "Recebi sua mensagem no WhatsApp: verifique o arquivo main.ts"
7. Active Claude session reads message via read_whatsapp and acts on it
8. No new session spawned

### 8. Data Flow (New Session)

1. Lucas sends WhatsApp: "/nova deploy o projeto reino"
2. Prefix `/nova` detected → strip prefix, treat as new session request
3. Normal spawn behavior (existing code path)
4. New Claude CLI spawned with message "deploy o projeto reino"
