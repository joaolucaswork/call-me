#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CallManager, loadConfig } from './phone-call.js';

// Global call manager instance
let callManager: CallManager | null = null;

function getCallManager(): CallManager {
  if (!callManager) {
    const config = loadConfig();
    callManager = new CallManager(config);
  }
  return callManager;
}

const server = new Server(
  {
    name: 'hey-boss',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'initiate_call',
        description: 'Start a phone call with the user. You (Claude Code) provide the initial message to speak, and the tool will call the user, speak your message, listen to their response, and return it to you. The call remains active so you can continue the conversation with continue_call. Use this when you need real-time voice input or complex discussions.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'What you want to say to the user. Be natural and conversational. Example: "Hey, I\'m working on the authentication system. Should I use session-based auth or JWT tokens?"',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'continue_call',
        description: 'Continue an active call with a follow-up message. The call must have been started with initiate_call first. You provide your next message, the tool speaks it to the user, listens to their response, and returns it to you. Use this for multi-turn conversations where you need to ask follow-up questions or provide additional context.',
        inputSchema: {
          type: 'object',
          properties: {
            call_id: {
              type: 'string',
              description: 'The call ID returned from initiate_call',
            },
            message: {
              type: 'string',
              description: 'Your follow-up message or question. Be natural and conversational.',
            },
          },
          required: ['call_id', 'message'],
        },
      },
      {
        name: 'end_call',
        description: 'End an active call with a final message. Speak your closing statement and hang up. Use this when the conversation is complete. Be polite and natural - say goodbye, confirm next steps, or provide a friendly closing.',
        inputSchema: {
          type: 'object',
          properties: {
            call_id: {
              type: 'string',
              description: 'The call ID returned from initiate_call',
            },
            message: {
              type: 'string',
              description: 'Your closing message. Examples: "Sounds good, I\'ll get started on that. Have a great day!", "Perfect, I\'ll implement that now. Talk soon!"',
            },
          },
          required: ['call_id', 'message'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const manager = getCallManager();

  try {
    if (request.params.name === 'initiate_call') {
      const { message } = request.params.arguments as { message: string };

      const result = await manager.initiateCall(message);

      return {
        content: [
          {
            type: 'text',
            text: `Call initiated successfully.\n\nCall ID: ${result.callId}\n\nUser's response:\n${result.response}\n\nYou can continue this conversation with continue_call or end it with end_call.`,
          },
        ],
      };
    } else if (request.params.name === 'continue_call') {
      const { call_id, message } = request.params.arguments as {
        call_id: string;
        message: string;
      };

      const response = await manager.continueCall(call_id, message);

      return {
        content: [
          {
            type: 'text',
            text: `User's response:\n${response}`,
          },
        ],
      };
    } else if (request.params.name === 'end_call') {
      const { call_id, message } = request.params.arguments as {
        call_id: string;
        message: string;
      };

      await manager.endCall(call_id, message);

      return {
        content: [
          {
            type: 'text',
            text: 'Call ended successfully.',
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}\n\nPlease ensure:\n1. Environment variables are configured (.env file)\n2. Twilio credentials are valid\n3. OpenAI API key is valid\n4. Public URL is accessible (use ngrok for development)\n5. For continue_call/end_call, the call_id is from an active call\n\nSee README.md for setup instructions.`,
        },
      ],
      isError: true,
    };
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.error('\nShutting down...');
  if (callManager) {
    callManager.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\nShutting down...');
  if (callManager) {
    callManager.shutdown();
  }
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Hey Boss MCP server running on stdio');
  console.error('Stateful call manager ready - supports multi-turn conversations');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
