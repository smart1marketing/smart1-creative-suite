import dotenv from 'dotenv';
dotenv.config();

const env = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const bool = (key, fallback = false) => {
  const v = env(key, String(fallback)).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

// Bump with every meaningful change so Diagnostics can prove what is running.
export const APP_VERSION = '1.8.0';
export const APP_FEATURES = [
  'light brand theme',
  'language picker (English, Spanish, +31)',
  'accent dropdown (3 common, +27)',
  'music beds: library, compose, upload',
  'ElevenLabs error translation',
  'status badge',
  'pacing recalibrated + learned per voice',
  'extend a short spot with website and phone',
  'banner render verification with fallback',
  'banner template: logo top, headline centre, root domain bottom',
  'contrast solved from artwork colours, not assumed',
  'project numbers, back buttons, clone a project',
  'music bed level presets and custom slider',
  'iframe height reporting'
];

export const config = {
  port: Number(env('PORT', '3000')),
  // Inside the Smart 1 Suite the studio lives under /radio, so review links
  // and webhook URLs must carry the prefix. RADIO_PUBLIC_URL overrides;
  // otherwise suite mode appends /radio to the shared PUBLIC_URL.
  publicUrl: (env('RADIO_PUBLIC_URL')
    || (env('PUBLIC_URL', '').replace(/\/$/, '') + (process.env.SUITE_MODE ? '/radio' : ''))
  ).replace(/\/$/, ''),
  // e.g. https://smart1marketing.com — permits that site to iframe the studio.
  embedOrigin: env('EMBED_ORIGIN', '').replace(/\/$/, ''),

  auth: {
    // Shared password for the Smart 1 team. Reviewers never need it — their
    // link carries a per-project token instead.
    password: env('STUDIO_PASSWORD'),
    secret: env('SESSION_SECRET', 'change-me-in-production'),
    sessionDays: Number(env('SESSION_DAYS', '14')),
    // Set to 'None' when the studio is embedded in an iframe on another
    // domain — a Lax cookie is not sent in a cross-site frame, so sign-in
    // would silently fail. 'None' also forces Secure, so HTTPS is required.
    sameSite: ['lax', 'none', 'strict'].includes(env('COOKIE_SAMESITE', 'Lax').toLowerCase())
      ? env('COOKIE_SAMESITE', 'Lax') : 'Lax'
  },

  openai: {
    key: env('OPENAI_API_KEY'),
    base: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    textModel: env('OPENAI_MODEL', 'gpt-4o'),
    imageModel: env('OPENAI_IMAGE_MODEL', 'gpt-image-1')
  },

  brandfetch: {
    key: env('BRANDFETCH_API_KEY'),
    base: 'https://api.brandfetch.io/v2'
  },

  elevenlabs: {
    key: env('ELEVENLABS_API_KEY'),
    base: 'https://api.elevenlabs.io/v1',
    model: env('ELEVENLABS_MODEL', 'eleven_multilingual_v2'),
    musicModel: env('ELEVENLABS_MUSIC_MODEL', 'music_v2')
  },

  cloudinary: {
    cloudName: env('CLOUDINARY_CLOUD_NAME'),
    apiKey: env('CLOUDINARY_API_KEY'),
    apiSecret: env('CLOUDINARY_API_SECRET'),
    rootFolder: env('CLOUDINARY_ROOT_FOLDER', 'smart1-radio-studio'),
    // Upload licensed music beds here and they show up as choices in the studio.
    bedFolder: env('CLOUDINARY_BED_FOLDER', 'smart1-radio-studio/music-beds')
  },

  ghl: {
    opportunityWebhook: env('GHL_OPPORTUNITY_WEBHOOK_URL'),
    approvalWebhook: env('GHL_APPROVAL_WEBHOOK_URL'),
    // Fires when the reviewer actually clicks approve or asks for changes.
    responseWebhook: env('GHL_APPROVAL_RESPONSE_WEBHOOK_URL')
  },

  audio: {
    enabled: bool('AUDIO_POST_ENABLED', true),
    targetLufs: Number(env('AUDIO_TARGET_LUFS', '-16')),
    truePeak: Number(env('AUDIO_TRUE_PEAK', '-1.5')),
    bedDb: Number(env('AUDIO_BED_DB', '-17'))
  },

  dataDir: env('DATA_DIR', './data')
};

export const missingKeys = () => {
  const checks = {
    STUDIO_PASSWORD: config.auth.password,
    SESSION_SECRET: config.auth.secret === 'change-me-in-production' ? '' : config.auth.secret,
    OPENAI_API_KEY: config.openai.key,
    BRANDFETCH_API_KEY: config.brandfetch.key,
    ELEVENLABS_API_KEY: config.elevenlabs.key,
    CLOUDINARY_CLOUD_NAME: config.cloudinary.cloudName,
    CLOUDINARY_API_KEY: config.cloudinary.apiKey,
    CLOUDINARY_API_SECRET: config.cloudinary.apiSecret,
    GHL_OPPORTUNITY_WEBHOOK_URL: config.ghl.opportunityWebhook,
    GHL_APPROVAL_WEBHOOK_URL: config.ghl.approvalWebhook
  };
  return Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
};
