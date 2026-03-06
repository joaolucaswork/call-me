# Phone Call Input Skill

## Description
Call the user on the phone for real-time voice conversations. Use this when you need input, want to report on completed work, or need to discuss next steps.

## When to Use This Skill

**Use when:**
- You've **completed a significant task** and want to report status and ask what's next
- You need **real-time voice input** for complex decisions
- A question requires **back-and-forth discussion** to fully understand
- You're **blocked** and need urgent clarification to proceed
- You want to **celebrate a milestone** or walk the user through completed work

**Do NOT use for:**
- Simple yes/no questions (use text instead)
- Routine status updates that don't need discussion
- Information the user has already provided

## Tools

### `initiate_call`
Start a phone call with the user.

**Parameters:**
- `message` (string): What you want to say. Be natural and conversational.

**Returns:**
- Call ID and the user's spoken response (transcribed to text)

### `continue_call`
Continue an active call with a follow-up message.

**Parameters:**
- `call_id` (string): The call ID from `initiate_call`
- `message` (string): Your follow-up message

**Returns:**
- The user's response

### `speak_to_user`
Speak a message on an active call without waiting for a response. Use this to acknowledge requests or provide status updates before starting time-consuming operations.

**Parameters:**
- `call_id` (string): The call ID from `initiate_call`
- `message` (string): What to say to the user

**Returns:**
- Confirmation that the message was spoken

**When to use:**
- Acknowledge a request before starting a long operation (e.g., "Let me search for that...")
- Provide status updates during multi-step tasks
- Keep the conversation flowing naturally without awkward silences

### `end_call`
End an active call with a closing message. If the user already hung up, returns conversation history.

**Parameters:**
- `call_id` (string): The call ID from `initiate_call`
- `message` (string): Your closing message (say goodbye!)

**Returns:**
- Call duration in seconds
- If user had already hung up: conversation history

### `get_call_status`
Check if a call is still active, hung up (with preserved context), or not found.

**Parameters:**
- `call_id` (string): The call ID to check

**Returns:**
- Status: `active`, `hung_up`, or `not_found`
- For active/hung_up: conversation history and duration

## Example Usage

**Simple conversation:**
```
1. initiate_call: "Hey! I finished the auth system. Should I move on to the API endpoints?"
2. User responds: "Yes, go ahead"
3. end_call: "Perfect! I'll start on the API endpoints. Talk soon!"
```

**Multi-turn conversation:**
```
1. initiate_call: "I'm working on payments. Should I use Stripe or PayPal?"
2. User: "Use Stripe"
3. continue_call: "Got it. Do you want the full checkout flow or just a simple button?"
4. User: "Full checkout flow"
5. end_call: "Awesome, I'll build the full Stripe checkout. I'll let you know when it's ready!"
```

**Using speak_to_user for long operations:**
```
1. initiate_call: "Hey! I finished the database migration. What should I work on next?"
2. User: "Can you look up the latest API documentation for Stripe?"
3. speak_to_user: "Sure! Let me search for that. Give me a moment..."
4. [Perform web search and gather information]
5. continue_call: "I found the latest Stripe API docs. They released v2024.1 with new payment methods..."
6. User: "Great, implement that"
7. end_call: "Perfect! I'll implement the new payment methods. Talk soon!"
```

## Automatic Hold Messages

The server automatically plays periodic hold messages (every 15 seconds by default) when Claude hasn't spoken for a while. This prevents awkward silence during long operations. The timer resets every time you use `speak_to_user`, `continue_call`, or any speaking tool.

## Handling Hangups

When the user hangs up during a call:
- The call state is preserved for 5 minutes with full conversation history
- `continue_call` and `speak_to_user` will return the conversation history instead of an error
- Use `get_call_status` to check if a call is still active before trying to speak
- You can call back using `initiate_call` — the conversation history from the previous call is available

## Best Practices

1. **Be conversational** - Talk naturally, like a real conversation
2. **Provide context** - Explain what you've done before asking questions
3. **Offer clear options** - Make decisions easy with specific choices
4. **Use speak_to_user for acknowledgments** - Before time-consuming operations (searches, file reads, etc.), use `speak_to_user` to acknowledge the request so the user isn't left wondering what's happening
5. **Always end gracefully** - Say goodbye and state what you'll do next
6. **Check call status** - If you suspect the user may have hung up, use `get_call_status` before speaking
7. **Call back when appropriate** - If the user hangs up and you have results to share, call them back
