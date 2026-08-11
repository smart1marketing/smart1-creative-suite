import { config } from '../config.js';
import { log } from './store.js';

function headers(extra = {}) {
  if (!config.elevenlabs.key) throw new Error('ElevenLabs key is not set. Add ELEVENLABS_API_KEY.');
  return { 'xi-api-key': config.elevenlabs.key, ...extra };
}

/**
 * Turn ElevenLabs' raw error JSON into something actionable. The prefix
 * error in particular is almost always an OpenAI key (sk-) pasted into the
 * ElevenLabs slot (sk_), or a legacy key from before the prefix existed.
 */
export function elevenError(status, body) {
  let detail = {};
  try { detail = JSON.parse(body)?.detail || {}; } catch { /* plain text */ }
  const code = detail.status || detail.code || '';

  if (code === 'invalid_api_key_prefix') {
    const key = config.elevenlabs.key;
    const looksOpenAI = key.startsWith('sk-');
    return new Error(
      `ElevenLabs rejected the API key: it must start with "sk_". ` +
      (looksOpenAI
        ? 'The value in ELEVENLABS_API_KEY starts with "sk-", which is an OpenAI key — the two are easy to mix up. Put the OpenAI key in OPENAI_API_KEY and generate an ElevenLabs key at elevenlabs.io under Developers, API Keys.'
        : 'This looks like a legacy key from before ElevenLabs added the prefix. Generate a fresh one at elevenlabs.io under Developers, API Keys, and copy it straight away — it is only shown once.')
    );
  }
  if (code === 'invalid_api_key' || status === 401) {
    return new Error('ElevenLabs did not accept that API key. Check it was copied whole, with no trailing space, and that it has not been revoked.');
  }
  if (status === 403) {
    return new Error('That ElevenLabs key is valid but lacks permission for this action, or the request came from an IP outside the key\'s allowlist.');
  }
  if (status === 429) {
    return new Error('ElevenLabs rate limit or character quota reached. Check remaining characters on the plan.');
  }
  return new Error(`ElevenLabs ${status}: ${String(body).slice(0, 200)}`);
}

let cache = { at: 0, voices: [] };

export async function listVoices({ force = false } = {}) {
  if (!force && cache.voices.length && Date.now() - cache.at < 5 * 60 * 1000) return cache.voices;

  const res = await fetch(`${config.elevenlabs.base}/voices`, { headers: headers() });
  if (!res.ok) throw elevenError(res.status, await res.text());
  const data = await res.json();
  const voices = (data.voices || []).map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
    previewUrl: v.preview_url,
    description: v.description || v.labels?.description || '',
    labels: v.labels || {}
  }));
  cache = { at: Date.now(), voices };
  return voices;
}

const norm = (s = '') => String(s).toLowerCase().replace(/[^a-z]/g, '');

const ACCENT_ALIASES = {
  american: ['american', 'us', 'usa', 'transatlantic'],
  spanish: ['spanish', 'castilian', 'latin', 'mexican', 'espanol'],
  german: ['german', 'deutsch'],
  british: ['british', 'english', 'uk', 'received'],
  irish: ['irish', 'ireland'],
  scottish: ['scottish', 'scots', 'scotland'],
  australian: ['australian', 'aussie'],
  new_zealand: ['new zealand', 'kiwi'],
  canadian: ['canadian', 'canada', 'american'],
  transatlantic: ['transatlantic', 'american', 'british'],
  southern_us: ['southern', 'south', 'texas', 'american'],
  new_york: ['new york', 'brooklyn', 'american'],
  mexican: ['mexican', 'mexico', 'latin', 'spanish'],
  castilian: ['castilian', 'spain', 'spanish'],
  latin_american: ['latin', 'latino', 'spanish'],
  brazilian: ['brazilian', 'brazil', 'portuguese'],
  chinese: ['chinese', 'mandarin']
};

const ENERGY_WORDS = {
  laid_back: ['calm', 'relaxed', 'soothing', 'soft', 'chill', 'gentle', 'meditative'],
  conversational: ['conversational', 'casual', 'natural', 'friendly', 'warm'],
  energetic: ['energetic', 'upbeat', 'excited', 'confident', 'expressive'],
  explosive: ['intense', 'powerful', 'shouty', 'dramatic', 'strong', 'energetic']
};

const DELIVERY_WORDS = {
  announcer: ['announcer', 'commercial', 'advertisement', 'broadcast', 'promo'],
  narrator: ['narration', 'narrator', 'audiobook', 'documentary'],
  best_friend: ['conversational', 'casual', 'friendly', 'social media'],
  spokesperson: ['commercial', 'advertisement', 'professional', 'corporate', 'news'],
  character: ['characters', 'animation', 'video games', 'character']
};

function scoreVoice(voice, want) {
  const l = voice.labels || {};
  const bag = norm([l.description, l.use_case, l.usecase, l.descriptive, voice.description, voice.name].join(' '));
  let score = 0;
  const reasons = [];

  if (want.gender && want.gender !== 'any') {
    if (norm(l.gender) === norm(want.gender)) { score += 5; reasons.push(want.gender); }
    else if (l.gender) score -= 4;
  }
  if (want.age && want.age !== 'any') {
    if (norm(l.age) === norm(want.age)) { score += 3; reasons.push(String(l.age).replace('_', ' ')); }
  }
  if (want.accent && want.accent !== 'any') {
    const aliases = ACCENT_ALIASES[want.accent] || [String(want.accent).replace(/_/g, ' ')];
    if (aliases.some((a) => norm(l.accent).includes(norm(a)))) { score += 3; reasons.push(l.accent); }
  }
  if (want.energy) {
    const hits = (ENERGY_WORDS[want.energy] || []).filter((w) => bag.includes(norm(w)));
    score += Math.min(hits.length, 2) * 2;
    if (hits.length) reasons.push(want.energy.replace('_', ' '));
  }
  if (want.delivery) {
    const hits = (DELIVERY_WORDS[want.delivery] || []).filter((w) => bag.includes(norm(w)));
    score += Math.min(hits.length, 2) * 2;
    if (hits.length) reasons.push(want.delivery.replace('_', ' '));
  }
  for (const term of want.searchTerms || []) {
    if (bag.includes(norm(term))) score += 1;
  }
  // Nudge toward voices actually tagged for ads.
  if (bag.includes('advertisement') || bag.includes('commercial')) score += 1;

  return { score, reasons: [...new Set(reasons)] };
}

/** Return the best `count` matches for the picked characteristics. */
export async function matchVoices(want, count = 3) {
  const voices = await listVoices();
  const ranked = voices
    .map((v) => ({ ...v, ...scoreVoice(v, want) }))
    .sort((a, b) => b.score - a.score);

  const picked = ranked.slice(0, Math.max(count, 1));
  if (!picked.length) throw new Error('No voices came back from ElevenLabs. Check the API key and account.');
  return picked.map((v) => ({
    voiceId: v.voiceId,
    name: v.name,
    previewUrl: v.previewUrl,
    accent: v.labels?.accent || '',
    age: v.labels?.age || '',
    gender: v.labels?.gender || '',
    descriptor: v.labels?.description || v.labels?.descriptive || '',
    useCase: v.labels?.use_case || v.labels?.usecase || '',
    matchReasons: v.reasons,
    score: v.score
  }));
}

/** Look up one specific voice the user pasted in by ID. */
export async function getVoice(voiceId) {
  const res = await fetch(`${config.elevenlabs.base}/voices/${encodeURIComponent(voiceId)}`, { headers: headers() });
  if (res.status === 404) throw new Error(`No ElevenLabs voice with the ID ${voiceId}.`);
  if (!res.ok) throw elevenError(res.status, await res.text());
  const v = await res.json();
  return {
    voiceId: v.voice_id,
    name: v.name,
    previewUrl: v.preview_url,
    accent: v.labels?.accent || '',
    age: v.labels?.age || '',
    gender: v.labels?.gender || '',
    descriptor: v.labels?.description || '',
    useCase: v.labels?.use_case || '',
    matchReasons: ['added by ID'],
    custom: true
  };
}

/** Render the script to MP3. Returns a Buffer. */
export async function renderAudio({ voiceId, script, energy = 'conversational' }) {
  const style = { laid_back: 0.15, conversational: 0.3, energetic: 0.55, explosive: 0.75 }[energy] ?? 0.3;

  const res = await fetch(
    `${config.elevenlabs.base}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
      body: JSON.stringify({
        text: script,
        model_id: config.elevenlabs.model,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style, use_speaker_boost: true }
      })
    }
  );
  if (!res.ok) {
    const body = await res.text();
    log.error('elevenlabs.tts', body.slice(0, 300));
    throw elevenError(res.status, body);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Compose an instrumental bed with Eleven Music.
 *
 * Two things matter for a radio bed and neither is the default: it has to be
 * instrumental (vocals fight the read) and it has to leave the midrange open
 * so the voiceover sits on top instead of under. Both are pushed hard in the
 * prompt, and the sidechain duck in audio.js cleans up the rest.
 */
export async function composeMusic({ prompt, seconds = 35 }) {
  const ms = Math.min(300000, Math.max(3000, Math.round(seconds * 1000)));
  const guarded = [
    prompt,
    'Fully instrumental. No vocals, no singing, no lyrics, no spoken word, no vocal samples.',
    'Steady consistent energy with no dramatic drops or silence, suitable for looping under a voiceover.',
    'Leave the midrange uncluttered so a spoken voice sits clearly on top.',
    'No sudden endings — resolve gently.'
  ].join(' ');

  const res = await fetch(`${config.elevenlabs.base}/music?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
    body: JSON.stringify({
      prompt: guarded.slice(0, 4100),
      music_length_ms: ms,
      model_id: config.elevenlabs.musicModel
    })
  });

  if (!res.ok) {
    const body = await res.text();
    log.error('elevenlabs.music', body.slice(0, 300));
    if (res.status === 403 && !/invalid_api_key/.test(body)) {
      throw new Error('Your ElevenLabs plan does not include Music. A paid plan is required, and it also carries the commercial licence.');
    }
    throw elevenError(res.status, body);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function accountCheck() {
  const res = await fetch(`${config.elevenlabs.base}/user/subscription`, { headers: headers() });
  if (!res.ok) throw elevenError(res.status, await res.text());
  const d = await res.json();
  return {
    tier: d.tier,
    charactersUsed: d.character_count,
    characterLimit: d.character_limit,
    remaining: (d.character_limit ?? 0) - (d.character_count ?? 0)
  };
}
