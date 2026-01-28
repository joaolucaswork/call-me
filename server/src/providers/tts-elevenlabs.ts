/**
 * ElevenLabs TTS Provider
 *
 * High-quality multilingual TTS with natural-sounding voices.
 * Excellent support for Portuguese and other languages.
 *
 * Pricing: ~$0.30/1k characters (higher than OpenAI but better quality)
 */

import type { TTSProvider, TTSConfig } from './types.js';

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = 'elevenlabs';
  private apiKey: string | null = null;
  private voiceId: string = 'onwK4e9ZLuTAKqWW03F9'; // Daniel - multilingual
  private modelId: string = 'eleven_multilingual_v2';

  initialize(config: TTSConfig): void {
    if (!config.apiKey) {
      throw new Error('ElevenLabs API key required for TTS');
    }

    this.apiKey = config.apiKey;
    this.voiceId = config.voice || 'onwK4e9ZLuTAKqWW03F9';
    this.modelId = config.model || 'eleven_multilingual_v2';

    console.error(`TTS provider: ElevenLabs (${this.modelId}, voice: ${this.voiceId})`);
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.apiKey) throw new Error('ElevenLabs TTS not initialized');

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=pcm_24000`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async *synthesizeStream(text: string): AsyncGenerator<Buffer> {
    if (!this.apiKey) throw new Error('ElevenLabs TTS not initialized');

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?output_format=pcm_24000`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS stream failed: ${response.status} ${error}`);
    }

    const body = response.body;
    if (!body) {
      throw new Error('No response body from ElevenLabs TTS');
    }

    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          yield Buffer.from(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
