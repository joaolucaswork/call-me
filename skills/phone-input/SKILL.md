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

### `end_call`
End an active call with a closing message.

**Parameters:**
- `call_id` (string): The call ID from `initiate_call`
- `message` (string): Your closing message (say goodbye!)

**Returns:**
- Call duration in seconds

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

## Best Practices

1. **Be conversational** - Talk naturally, like a real conversation
2. **Provide context** - Explain what you've done before asking questions
3. **Offer clear options** - Make decisions easy with specific choices
4. **Always end gracefully** - Say goodbye and state what you'll do next
