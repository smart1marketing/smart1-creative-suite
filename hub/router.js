/**
 * The hub API, mounted at /api/hub. Everything is read IN-PROCESS from the
 * two build apps and the committed Knack data — no HTTP, no tokens, nothing
 * to fall out of sync.
 */
import fs from 'fs';
import { Router } from 'express';
import { createRequire } from 'module';
import { config } from './config.js';
import { knackIndex } from './knack.js';
import { issueSession, clearSession, currentSession, requireTeam, checkPassword } from './auth.js';

const require = createRequire(import.meta.url);

export function hubRouter({ radioStore }) {
  const api = Router();
  const ok = (res, data) => res.json({ ok: true, ...data });
  const fail = (res, status, message, extra = {}) => res.status(status).json({ ok: false, error: message, ...extra });
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[hub] ${req.method} ${req.path}: ${err.message}`);
    fail(res, 500, err.message);
  });

  /* ---------------- the ad builder's project store, in-process ------- */
  // The compiled store class; the same OUTPUT_DIR the ad builder writes to.
  const { ProjectStore } = require('../apps/ads/dist/src/projects.js');
  const adsProjects = () => new ProjectStore(config.adsOutDir);

  const mapAdsProject = (p) => ({
    type: 'display',
    id: p.projectId,
    name: p.projectName,
    client: p.client,
    campaign: p.campaignName,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    adCount: (p.batches || []).reduce((n, b) => n + (b.ads?.length || 0), 0),
    landingPage: p.landingPage || null,
    openUrl: `/build?request=${encodeURIComponent(p.requestId || '')}`,
  });

  const mapRadioProject = (p) => ({
    type: 'radio',
    id: p.projectId,
    projectNumber: p.projectNumber,
    name: p.customer?.projectName || '',
    client: p.customer?.company || p.brand?.name || p.customer?.customerName || '',
    status: p.reviewDecision?.outcome || p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    spotCount: p.playlist?.length || 0,
    tones: p.tones || [],
    openUrl: '/radio/library.html',
    cloneUrl: `/radio/#clone=${p.projectId}`,
  });

  const settle = (fn) => { try { return { value: fn(), error: null }; } catch (e) { return { value: null, error: e.message }; } };

  /* ---------------- sign in ---------------- */

  api.post('/auth/login', (req, res) => {
    if (!config.auth.password) return ok(res, { session: { who: 'open' }, open: true });
    if (!checkPassword(req.body.password)) return fail(res, 401, "That password doesn't match.");
    ok(res, { session: issueSession(res, String(req.body.who || 'Smart 1 team').slice(0, 60)) });
  });
  api.post('/auth/logout', (_req, res) => { clearSession(res); ok(res, {}); });
  api.get('/auth/me', (req, res) => {
    if (!config.auth.password) return ok(res, { session: { who: 'open' }, open: true });
    const session = currentSession(req);
    return session ? ok(res, { session }) : fail(res, 401, 'Sign in to use the hub.', { needsLogin: true });
  });

  api.use(requireTeam);

  /* ---------------- config + health ---------------- */

  api.get('/config', (_req, res) =>
    ok(res, { adBuilderUrl: '', radioUrl: '/radio', lookupUrl: '/lookup' }));

  api.get('/health', wrap(async (_req, res) => {
    const checks = [
      { name: 'adBuilder', ...settle(() => adsProjects().search({ limit: 1 }) && true) },
      { name: 'radio', ...settle(() => radioStore.library('') && true) },
      { name: 'lookup', ...settle(() => knackIndex().counts) },
    ];
    ok(res, { services: checks.map((c) => ({ name: c.name, ok: !c.error, reason: c.error || undefined })) });
  }));

  /* ---------------- overview / creatives / clients ---------------- */

  api.get('/overview', wrap(async (_req, res) => {
    const ads = settle(() => adsProjects().search({ limit: 15 }).map(mapAdsProject));
    const radio = settle(() => radioStore.library('').map(mapRadioProject));
    const knack = settle(() => knackIndex());
    const recent = [...(ads.value || []), ...(radio.value || [])]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 20);
    ok(res, {
      recent,
      counts: knack.value?.counts || null,
      errors: { adBuilder: ads.error, radio: radio.error, lookup: knack.error },
    });
  }));

  api.get('/creatives', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const ads = settle(() => adsProjects().search({ q, limit: 40 }).map(mapAdsProject));
    const radio = settle(() => radioStore.library(q).map(mapRadioProject));
    const results = [...(ads.value || []), ...(radio.value || [])]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    ok(res, { results, errors: { adBuilder: ads.error, radio: radio.error } });
  }));

  api.get('/clients', wrap(async (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    const index = knackIndex();
    const rows = index.rows
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.website?.domain || '').toLowerCase().includes(q))
      .sort((a, b) => b.liveMonthly - a.liveMonthly || a.name.localeCompare(b.name))
      .slice(0, 60)
      .map(({ records, live, ...summary }) => summary);
    ok(res, { clients: rows, generatedAt: index.generatedAt });
  }));

  api.get('/clients/:key', wrap(async (req, res) => {
    const index = knackIndex();
    const client = index.rows.find((c) => c.key === req.params.key);
    if (!client) return fail(res, 404, 'No client with that name in the Knack data.');

    const probe = client.name.split(/\s+/).slice(0, 2).join(' ');
    const ads = settle(() => adsProjects().search({ q: probe, limit: 25 }).map(mapAdsProject));
    const radio = settle(() => radioStore.library(probe).map(mapRadioProject));

    const byYear = {};
    for (const r of client.records) {
      const year = String(r.start || '').slice(-4);
      const y = /^\d{4}$/.test(year) ? year : 'undated';
      (byYear[y] ||= []).push({
        io: r.io, product: r.product, campaign: r.campaign, status: r.status,
        monthly: r.monthly, total: r.total, start: r.start, end: r.end, sales: r.sales,
      });
    }

    ok(res, {
      client: {
        name: client.name, key: client.key, sales: client.sales, partner: client.partner,
        dash: client.dash, website: client.website, liveCount: client.liveCount,
        liveMonthly: client.liveMonthly, products: client.products, years: client.years,
        history: byYear, live: client.live,
      },
      displayProjects: ads.value || [],
      radioProjects: radio.value || [],
      errors: { adBuilder: ads.error, radio: radio.error },
    });
  }));

  return api;
}
