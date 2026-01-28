/**
 * Provider Factory
 *
 * Creates and configures providers based on environment variables.
 * Supports Telnyx or Twilio for phone, OpenAI for TTS and Realtime STT.
 */

import type { PhoneProvider, TTSProvider, RealtimeSTTProvider, ProviderRegistry } from './types.js';
import { TelnyxPhoneProvider } from './phone-telnyx.js';
import { TwilioPhoneProvider } from './phone-twilio.js';
import { OpenAITTSProvider } from './tts-openai.js';
import { ElevenLabsTTSProvider } from './tts-elevenlabs.js';
import { OpenAIRealtimeSTTProvider } from './stt-openai-realtime.js';

export * from './types.js';

export type PhoneProviderType = 'telnyx' | 'twilio';
export type TTSProviderType = 'openai' | 'elevenlabs';

export interface ProviderConfig {
  // Phone provider selection
  phoneProvider: PhoneProviderType;

  // Phone credentials (interpretation depends on provider)
  // Telnyx: accountSid = Connection ID, authToken = API Key
  // Twilio: accountSid = Account SID, authToken = Auth Token
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;

  // Telnyx webhook public key (for signature verification)
  // Get from: Mission Control > Account Settings > Keys & Credentials > Public Key
  telnyxPublicKey?: string;

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
}

export function loadProviderConfig(): ProviderConfig {
  const sttSilenceDurationMs = process.env.CALLME_STT_SILENCE_DURATION_MS
    ? parseInt(process.env.CALLME_STT_SILENCE_DURATION_MS, 10)
    : undefined;

  // Default to telnyx if not specified
  const phoneProvider = (process.env.CALLME_PHONE_PROVIDER || 'telnyx') as PhoneProviderType;

  // Default to openai for TTS if not specified
  const ttsProvider = (process.env.CALLME_TTS_PROVIDER || 'openai') as TTSProviderType;

  // Default voice depends on provider
  const defaultVoice = ttsProvider === 'elevenlabs' ? 'onwK4e9ZLuTAKqWW03F9' : 'onyx';

  return {
    phoneProvider,
    phoneAccountSid: process.env.CALLME_PHONE_ACCOUNT_SID || '',
    phoneAuthToken: process.env.CALLME_PHONE_AUTH_TOKEN || '',
    phoneNumber: process.env.CALLME_PHONE_NUMBER || '',
    telnyxPublicKey: process.env.CALLME_TELNYX_PUBLIC_KEY,
    ttsProvider,
    openaiApiKey: process.env.CALLME_OPENAI_API_KEY || '',
    elevenlabsApiKey: process.env.CALLME_ELEVENLABS_API_KEY,
    ttsVoice: process.env.CALLME_TTS_VOICE || defaultVoice,
    ttsModel: process.env.CALLME_TTS_MODEL,
    sttModel: process.env.CALLME_STT_MODEL || 'gpt-4o-transcribe',
    sttSilenceDurationMs,
  };
}

export function createPhoneProvider(config: ProviderConfig): PhoneProvider {
  let provider: PhoneProvider;

  if (config.phoneProvider === 'twilio') {
    provider = new TwilioPhoneProvider();
  } else {
    provider = new TelnyxPhoneProvider();
  }

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

  // Provider-specific credential descriptions
  const credentialDesc = config.phoneProvider === 'twilio'
    ? { accountSid: 'Twilio Account SID', authToken: 'Twilio Auth Token' }
    : { accountSid: 'Telnyx Connection ID', authToken: 'Telnyx API Key' };

  if (!config.phoneAccountSid) {
    errors.push(`Missing CALLME_PHONE_ACCOUNT_SID (${credentialDesc.accountSid})`);
  }
  if (!config.phoneAuthToken) {
    errors.push(`Missing CALLME_PHONE_AUTH_TOKEN (${credentialDesc.authToken})`);
  }
  if (!config.phoneNumber) {
    errors.push('Missing CALLME_PHONE_NUMBER');
  }
  if (!config.openaiApiKey) {
    errors.push('Missing CALLME_OPENAI_API_KEY (required for STT)');
  }
  if (config.ttsProvider === 'elevenlabs' && !config.elevenlabsApiKey) {
    errors.push('Missing CALLME_ELEVENLABS_API_KEY (required when TTS provider is elevenlabs)');
  }

  return errors;
}
