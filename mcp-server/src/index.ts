#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { makePhoneCall } from './phone-call.js';

const server = new Server(
  {
    name: 'hey-boss',
    version: '1.0.0',
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
        name: 'call_user_for_input',
        description: 'Call the user on the phone to get their input, clarification, or decision. Use this when you need real-time voice communication, complex explanations, or when text interaction is insufficient. The tool acts as a simple voice bridge - YOU (Claude Code) provide the question/context, the tool converts it to speech, captures the user\'s voice response, transcribes it, and returns the text to you. No other AI is involved - you control the entire interaction.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question or context you need to communicate to the user. Be specific about what you need to know.',
            },
            urgency: {
              type: 'string',
              enum: ['normal', 'high'],
              description: 'Urgency level of the call. Use "high" only for critical decisions.',
              default: 'normal',
            },
          },
          required: ['question'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'call_user_for_input') {
    const { question, urgency = 'normal' } = request.params.arguments as {
      question: string;
      urgency?: string;
    };

    try {
      const result = await makePhoneCall(question, urgency);

      return {
        content: [
          {
            type: 'text',
            text: `Phone call completed successfully.\n\nUser Response:\n${result.transcript}\n\nCall Duration: ${result.duration}s\nStatus: ${result.status}`,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        content: [
          {
            type: 'text',
            text: `Failed to complete phone call: ${errorMessage}\n\nPlease ensure:\n1. Environment variables are configured (.env file)\n2. Twilio credentials are valid\n3. OpenAI API key is valid\n4. Public URL is accessible (use ngrok for development)\n\nSee README.md for setup instructions.`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Hey Boss MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
