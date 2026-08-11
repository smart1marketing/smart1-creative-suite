import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { log } from './store.js';

/**
 * A running tally of what Smart 1's clients actually approve. After a few
 * dozen projects this is better casting advice than any generic prior, so it
 * gets folded into the tone recommendations and the voice ordering.
 */

const dir = path.resolve(config.dataDir);
const file = path.join(dir, 'insights.json');

let data = { tones: {}, voices: {}, revisions: { total: 0, projects: 0 }, updatedAt: null };
let timer = null;

try {
  if (fs.existsSync(file)) data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} catch {
  /* start fresh */
}

function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn('insights', err.message);
    }
  }, 300);
}

const bump = (bucket, key, field, by = 1) => {
  if (!key) return;
  data[bucket][key] = data[bucket][key] || {};
  data[bucket][key][field] = (data[bucket][key][field] || 0) + by;
  persist();
};

export const insights = {
  scriptWritten: (toneId) => bump('tones', toneId, 'written'),
  scriptRevised: (toneId) => {
    bump('tones', toneId, 'revisions');
    data.revisions.total += 1;
    persist();
  },
  scriptApproved: (toneId) => bump('tones', toneId, 'approved'),
  spotPublished: (toneId, voiceId, voiceName) => {
    bump('tones', toneId, 'published');
    if (voiceId) {
      data.voices[voiceId] = data.voices[voiceId] || { name: voiceName, published: 0 };
      data.voices[voiceId].name = voiceName || data.voices[voiceId].name;
      data.voices[voiceId].published += 1;
      persist();
    }
  },
  reviewerApproved: (toneId) => bump('tones', toneId, 'clientApproved'),

  /** Tone ids ordered by how often they survive to a published spot. */
  topTones(n = 5) {
    return Object.entries(data.tones)
      .map(([toneId, s]) => ({
        toneId,
        written: s.written || 0,
        published: s.published || 0,
        revisions: s.revisions || 0,
        // Fewest rewrites per published spot wins ties.
        score: (s.published || 0) * 2 + (s.clientApproved || 0) * 3 - (s.revisions || 0) * 0.5
      }))
      .filter((t) => t.written > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  },

  /** Voice ids ordered by how often Smart 1 actually ships them. */
  topVoices(n = 8) {
    return Object.entries(data.voices)
      .map(([voiceId, v]) => ({ voiceId, ...v }))
      .sort((a, b) => b.published - a.published)
      .slice(0, n);
  },

  snapshot: () => ({ ...data, topTones: insights.topTones(6), topVoices: insights.topVoices(8) })
};
