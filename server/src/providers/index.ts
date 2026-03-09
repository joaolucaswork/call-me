/**
 * Provider Factory
 *
 * Creates and configures providers based on environment variables.
 * Uses Twilio for phone, OpenAI or ElevenLabs for TTS, OpenAI for STT.
 */

import type { PhoneProvider, TTSProvider, RealtimeSTTProvider, ProviderRegistry } from './types.js';
import { TwilioPhoneProvider } from './phone-twilio.js';
import { OpenAITTSProvider } from './tts-openai.js';
import { ElevenLabsTTSProvider } from './tts-elevenlabs.js';
import { OpenAIRealtimeSTTProvider } from './stt-openai-realtime.js';

export * from './types.js';

export type TTSProviderType = 'openai' | 'elevenlabs';

export interface ProviderConfig {
  // Twilio credentials
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;

  // TTS provider selection
  ttsProvider: TTSProviderType;

  // OpenAI API key (used for STT, and TTS if ttsProvider=openai)
  openaiApiKey: string;

  // ElevenLabs API key (required if ttsProvider=elevenlabs)
  elevenlabsApiKey?: string;

  // TTS settings
  ttsVoice?: string;
  ttsModel?: string;

  // STT settings
  sttModel?: string;
  sttSilenceDurationMs?: number;
  sttVadThreshold?: number;
}

export function loadProviderConfig(): ProviderConfig {
  const sttSilenceDurationMs = process.env.LEIN_STT_SILENCE_DURATION_MS
    ? parseInt(process.env.LEIN_STT_SILENCE_DURATION_MS, 10)
    : undefined;

  const sttVadThreshold = process.env.LEIN_STT_VAD_THRESHOLD
    ? parseFloat(process.env.LEIN_STT_VAD_THRESHOLD)
    : undefined;

  // Default to openai for TTS if not specified
  const ttsProvider = (process.env.LEIN_TTS_PROVIDER || 'openai') as TTSProviderType;

  // Default voice depends on provider
  const defaultVoice = ttsProvider === 'elevenlabs' ? 'onwK4e9ZLuTAKqWW03F9' : 'onyx';

  return {
    phoneAccountSid: process.env.LEIN_PHONE_ACCOUNT_SID || '',
    phoneAuthToken: process.env.LEIN_PHONE_AUTH_TOKEN || '',
    phoneNumber: process.env.LEIN_PHONE_NUMBER || '',
    ttsProvider,
    openaiApiKey: process.env.LEIN_OPENAI_API_KEY || '',
    elevenlabsApiKey: process.env.LEIN_ELEVENLABS_API_KEY,
    ttsVoice: process.env.LEIN_TTS_VOICE || defaultVoice,
    ttsModel: process.env.LEIN_TTS_MODEL,
    sttModel: process.env.LEIN_STT_MODEL || 'gpt-4o-transcribe',
    sttSilenceDurationMs,
    sttVadThreshold,
  };
}

export function createPhoneProvider(config: ProviderConfig): PhoneProvider {
  const provider = new TwilioPhoneProvider();
  provider.initialize({
    accountSid: config.phoneAccountSid,
    authToken: config.phoneAuthToken,
    phoneNumber: config.phoneNumber,
  });
  return provider;
}

export function createTTSProvider(config: ProviderConfig): TTSProvider {
  if (config.ttsProvider === 'elevenlabs') {
    const provider = new ElevenLabsTTSProvider();
    provider.initialize({
      apiKey: config.elevenlabsApiKey,
      voice: config.ttsVoice,
      model: config.ttsModel,
    });
    return provider;
  }

  const provider = new OpenAITTSProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    voice: config.ttsVoice,
    model: config.ttsModel,
  });
  return provider;
}

export function createSTTProvider(config: ProviderConfig): RealtimeSTTProvider {
  const provider = new OpenAIRealtimeSTTProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    model: config.sttModel,
    silenceDurationMs: config.sttSilenceDurationMs,
    vadThreshold: config.sttVadThreshold,
  });
  return provider;
}

export function createProviders(config: ProviderConfig): ProviderRegistry {
  return {
    phone: createPhoneProvider(config),
    tts: createTTSProvider(config),
    stt: createSTTProvider(config),
  };
}

/**
 * Validate that required config is present
 */
export function validateProviderConfig(config: ProviderConfig): string[] {
  const errors: string[] = [];

  if (!config.phoneAccountSid) {
    errors.push('Missing LEIN_PHONE_ACCOUNT_SID (Twilio Account SID)');
  }
  if (!config.phoneAuthToken) {
    errors.push('Missing LEIN_PHONE_AUTH_TOKEN (Twilio Auth Token)');
  }
  if (!config.phoneNumber) {
    errors.push('Missing LEIN_PHONE_NUMBER');
  }
  if (!config.openaiApiKey) {
    errors.push('Missing LEIN_OPENAI_API_KEY (required for STT)');
  }
  if (config.ttsProvider === 'elevenlabs' && !config.elevenlabsApiKey) {
    errors.push('Missing LEIN_ELEVENLABS_API_KEY (required when TTS provider is elevenlabs)');
  }

  return errors;
}
