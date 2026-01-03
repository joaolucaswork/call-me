# Phone Call Input Skill

## Description
Enables Claude Code to call the user on the phone for real-time voice conversations. Use this when you need input, want to report on completed work, or need to discuss next steps.

## When to Use This Skill

**Use this skill when:**
- You've **completed a significant task** and want to report status and ask what to do next
- You need **real-time voice input** for complex decisions
- A question requires **back-and-forth discussion** to fully understand
- You're **blocked** and need urgent clarification to proceed
- The user needs to provide **detailed context** that's easier to explain verbally
- You want to **celebrate a milestone** or walk the user through completed work

**Do NOT use this skill for:**
- Simple yes/no questions (use text)
- Routine status updates that don't require discussion
- Information the user has already provided
- Questions that can wait for async text response

## Available Tools

### `initiate_call`
Start a new phone call with the user.

**Parameters:**
- `message` (string, required): What you want to say to the user

**Returns:** Call ID and user's response

### `continue_call`
Continue an active call with a follow-up message.

**Parameters:**
- `call_id` (string, required): The call ID from initiate_call
- `message` (string, required): Your follow-up message

**Returns:** User's response

### `end_call`
End an active call with a closing message.

**Parameters:**
- `call_id` (string, required): The call ID from initiate_call
- `message` (string, required): Your closing message (say goodbye!)

## Example: Status Report After Completing Work

```typescript
// You just finished implementing a feature
const { callId, response } = await initiate_call({
  message: "Hey! I just finished implementing the user authentication system. I added JWT tokens, refresh token support, and password reset functionality. Want me to walk you through what I built, or should I move on to the next task?"
});
// User responds: "That sounds great! What's the next priority?"

await end_call({
  call_id: callId,
  message: "Perfect! I'll move on to the API rate limiting feature next. I'll call you when that's done. Talk soon!"
});
```

## Example: Multi-Turn Decision Making

```typescript
// Start the call
const { callId, response } = await initiate_call({
  message: "I'm setting up the database layer. Should I use PostgreSQL or MongoDB for this project?"
});
// User says: "PostgreSQL, we already have it set up"

// Follow up based on their answer
const response2 = await continue_call({
  call_id: callId,
  message: "Got it. Should I set up connection pooling from the start?"
});
// User says: "Yes, use a pool size of 20"

// Natural ending
await end_call({
  call_id: callId,
  message: "Sounds good! PostgreSQL with connection pooling, pool size 20. I'll get started on that now!"
});
```

## Best Practices

1. **Be conversational** - Talk naturally, not like a robot
2. **Provide context** - Explain what you've done and why you're calling
3. **Offer options** - Make it easy for the user to decide
4. **End gracefully** - Always say goodbye with a clear next step
5. **Use for meaningful moments** - Task completion, important decisions, blockers

## Configuration Required

Before using this skill, ensure the Hey Boss MCP server is installed. See README.md for setup.
