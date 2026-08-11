import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';

const dir = path.resolve(config.dataDir);
const file = path.join(dir, 'projects.json');

let db = { projects: {} };
let writeTimer = null;

function ensure() {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    try {
      db = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!db.projects) db.projects = {};
    } catch {
      db = { projects: {} };
    }
  }
}
ensure();

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.writeFileSync(file, JSON.stringify(db, null, 2));
    } catch (err) {
      log.error('store.persist', err.message);
    }
  }, 150);
}

const reviewToken = () => crypto.randomBytes(18).toString('base64url');

/** Human-quotable job number: S1-YYMM-0042, sequential within the month. */
function nextProjectNumber() {
  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const used = Object.values(db.projects)
    .map((p) => p.projectNumber)
    .filter((n) => typeof n === 'string' && n.startsWith(`S1-${stamp}-`))
    .map((n) => Number(n.split('-')[2]) || 0);
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `S1-${stamp}-${String(next).padStart(4, '0')}`;
}

export const id = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const store = {
  create(project) {
    const projectId = id('prj');
    const now = new Date().toISOString();
    db.projects[projectId] = {
      projectId,
      projectNumber: nextProjectNumber(),
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      customer: {},
      brand: null,
      analysis: null,
      tones: [],
      commercials: [],
      drafts: [],            // every version ever written, newest last
      banners: {},
      voiceProfile: null,
      voiceCharacteristics: null,
      pronunciations: [],    // client-specific "say it like this" overrides
      musicBed: null,        // { publicId, url, name } or null for a dry read
      bedPercent: 25,        // bed level as a share of the voice
      singleVoice: true,     // one voice across the campaign unless turned off
      playlist: [],
      cloudinaryFolder: null,
      approvalRequest: null,
      reviewDecision: null,
      reviewToken: reviewToken(),
      ...project
    };
    persist();
    return db.projects[projectId];
  },

  get(projectId) {
    return this.ensureShape(db.projects[projectId] || null);
  },

  update(projectId, patch) {
    const p = db.projects[projectId];
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    persist();
    return p;
  },

  /** Mutate in place with a callback, then persist. */
  mutate(projectId, fn) {
    const p = db.projects[projectId];
    if (!p) return null;
    fn(p);
    p.updatedAt = new Date().toISOString();
    persist();
    return p;
  },

  all() {
    return Object.values(db.projects);
  },

  /** Backfill anything added after a project was first saved. */
  ensureShape(project) {
    if (!project) return project;
    project.drafts ||= [];
    project.pronunciations ||= [];
    project.banners ||= {};
    project.playlist ||= [];
    project.commercials ||= [];
    if (project.singleVoice === undefined) project.singleVoice = true;
    if (project.bedPercent === undefined) project.bedPercent = 25;
    if (!project.projectNumber) { project.projectNumber = nextProjectNumber(); persist(); }
    if (!project.reviewToken) {
      project.reviewToken = reviewToken();
      persist();
    }
    return project;
  },

  /**
   * A restart kills in-memory jobs. Anything left mid-render is marked so the
   * studio offers a retry instead of spinning forever.
   */
  sweepStale() {
    let count = 0;
    for (const p of Object.values(db.projects)) {
      for (const c of p.commercials || []) {
        if (c.audioStatus === 'rendering') {
          c.audioStatus = 'stalled';
          count++;
        }
      }
      for (const [toneId, b] of Object.entries(p.banners || {})) {
        if (b?.status === 'running') {
          p.banners[toneId] = { ...b, status: 'stalled' };
          count++;
        }
      }
    }
    if (count) persist();
    return count;
  },

  /** Projects that reached a saved playlist — the searchable library. */
  library(query = '') {
    const q = query.trim().toLowerCase();
    return this.all()
      .filter((p) => p.playlist && p.playlist.length > 0)
      .filter((p) => {
        if (!q) return true;
        const hay = [
          p.projectNumber,
          p.customer?.customerName,
          p.customer?.company,
          p.customer?.email,
          p.customer?.projectName,
          p.customer?.teamMember,
          p.brand?.name
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
};

/* ---------- diagnostics log ---------- */
const LOG_LIMIT = 250;
const entries = [];

export const log = {
  push(level, scope, message, meta) {
    entries.unshift({
      at: new Date().toISOString(),
      level,
      scope,
      message: String(message).slice(0, 1200),
      meta: meta ? String(JSON.stringify(meta)).slice(0, 1200) : null
    });
    if (entries.length > LOG_LIMIT) entries.length = LOG_LIMIT;
    if (level === 'error') console.error(`[${scope}] ${message}`);
  },
  info: (scope, message, meta) => log.push('info', scope, message, meta),
  warn: (scope, message, meta) => log.push('warn', scope, message, meta),
  error: (scope, message, meta) => log.push('error', scope, message, meta),
  recent: (n = 100) => entries.slice(0, n),
  clear: () => (entries.length = 0)
};
