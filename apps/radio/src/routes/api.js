import { Router } from 'express';
import { config, missingKeys, APP_VERSION, APP_FEATURES } from '../config.js';
import { TONES, VOICE_CHARACTERISTICS, LANGUAGES_PRIMARY, LANGUAGES_MORE, toneById } from '../catalog.js';
import { store, log, id } from '../services/store.js';
import { startJob, getJob } from '../services/jobs.js';
import { fetchBrand } from '../services/brandfetch.js';
import * as ai from '../services/openai.js';
import * as eleven from '../services/elevenlabs.js';
import * as cdn from '../services/cloudinary.js';
import * as bannerQa from '../services/bannerQa.js';
import { HEADLINE_MAX_WORDS, SUPPORT_MAX_WORDS } from '../services/bannerLayout.js';
import { plateFor, rootDomain } from '../services/contrast.js';
import * as ghl from '../services/ghl.js';
import * as speech from '../services/speech.js';
import * as audio from '../services/audio.js';
import { insights } from '../services/insights.js';
import { issueSession, clearSession, currentSession, requireTeam, checkReviewToken, reviewLink } from '../services/auth.js';

export const api = Router();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, status, message, extra = {}) => res.status(status).json({ ok: false, error: message, ...extra });

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    log.error(`api:${req.method} ${req.path}`, err.message);
    fail(res, 500, err.message);
  });

function requireProject(req, res) {
  const project = store.get(req.params.projectId);
  if (!project) {
    fail(res, 404, 'That project is no longer on file. Start a new one.');
    return null;
  }
  return project;
}

/* ================================================================== */
/* Sign in                                                             */
/* ================================================================== */

api.post('/auth/login', (req, res) => {
  if (!config.auth.password) return ok(res, { session: { who: 'open' }, open: true });
  const supplied = String(req.body.password || '');
  const expected = config.auth.password;
  if (supplied.length !== expected.length || supplied !== expected) {
    log.warn('auth', 'Failed sign-in attempt.');
    return fail(res, 401, "That password doesn't match.");
  }
  const session = issueSession(res, String(req.body.who || 'Smart 1 team').slice(0, 60));
  ok(res, { session });
});

api.post('/auth/logout', (_req, res) => { clearSession(res); ok(res, {}); });

api.get('/auth/me', (req, res) => {
  if (!config.auth.password) return ok(res, { session: { who: 'open' }, open: true });
  const session = currentSession(req);
  return session ? ok(res, { session }) : fail(res, 401, 'Sign in to use the studio.', { needsLogin: true });
});

/* ================================================================== */
/* Reviewer routes — token in the link, no team password needed        */
/* ================================================================== */

function reviewerProject(req, res) {
  const project = store.get(req.params.projectId);
  const token = req.query.token || req.body?.token;
  if (!project || !checkReviewToken(project, token)) {
    fail(res, 403, 'This review link is no longer valid. Ask your Smart 1 contact for a new one.');
    return null;
  }
  return project;
}

api.get('/review/:projectId', (req, res) => {
  const project = reviewerProject(req, res);
  if (!project) return;
  const c = project.customer;
  ok(res, {
    review: {
      company: c.company || c.customerName,
      projectName: c.projectName,
      teamMember: c.teamMember,
      logo: project.brand?.logo || null,
      offer: project.analysis?.offer || c.promotion || '',
      comments: project.approvalRequest?.comments || '',
      clickThroughUrl: c.landingUrl || c.homeUrl || '',
      decision: project.reviewDecision,
      spots: project.playlist.map((i) => ({
        toneLabel: i.toneLabel, seconds: i.seconds, script: i.script,
        voiceName: i.voiceName, audioUrl: i.audioUrl,
        bannerUrl: i.bannerUrl, bannerSizes: i.bannerSizes,
        measuredSeconds: i.finalSeconds || null
      }))
    }
  });
});

api.post('/review/:projectId/decision', wrap(async (req, res) => {
  const project = reviewerProject(req, res);
  if (!project) return;
  const outcome = req.body.outcome === 'approved' ? 'approved' : 'changes';
  const decision = {
    outcome,
    comments: String(req.body.comments || '').slice(0, 4000),
    by: String(req.body.by || project.approvalRequest?.recipientEmail || '').slice(0, 120),
    decidedAt: new Date().toISOString()
  };

  store.update(project.projectId, {
    reviewDecision: decision,
    status: outcome === 'approved' ? 'client-approved' : 'changes-requested'
  });
  if (outcome === 'approved') {
    for (const item of project.playlist) insights.reviewerApproved(item.toneId);
  }

  let delivered = null;
  try {
    delivered = await ghl.sendReviewDecision(store.get(project.projectId), decision);
  } catch (err) {
    log.error('ghl.review-decision', err.message);
  }
  ok(res, { decision, delivered: Boolean(delivered) });
}));

/* ================================================================== */
/* Status badge — cheap, cached, no session needed                     */
/* ================================================================== */

let statusCache = { at: 0, body: null };

async function probe(fn) {
  try { await fn(); return true; } catch { return false; }
}

/**
 * A one-line health summary for the header badge. Cached for a minute so
 * polling it never costs a round of live API calls, and it reports counts
 * rather than service names so it is safe to read without signing in.
 */
api.get('/status', wrap(async (_req, res) => {
  if (statusCache.body && Date.now() - statusCache.at < 60000) {
    return ok(res, { status: { ...statusCache.body, cached: true } });
  }

  const results = await Promise.all([
    probe(async () => {
      const r = await fetch(`${config.openai.base}/models/${config.openai.textModel}`, {
        headers: { Authorization: `Bearer ${config.openai.key}` }
      });
      if (!r.ok) throw new Error();
    }),
    probe(() => fetchBrand('smart1marketing.com')),
    probe(() => eleven.accountCheck()),
    probe(() => cdn.usage()),
    probe(async () => { if (!config.ghl.opportunityWebhook) throw new Error(); }),
    probe(async () => { if (!config.auth.password || config.auth.secret === 'change-me-in-production') throw new Error(); }),
    probe(async () => { if (!config.audio.enabled || !(await audio.ffmpegAvailable())) throw new Error(); })
  ]);

  const total = results.length;
  const passing = results.filter(Boolean).length;
  const body = {
    version: APP_VERSION,
    ok: passing === total,
    passing,
    total,
    failing: total - passing,
    label: passing === total ? 'All systems go' : `${total - passing} of ${total} need attention`,
    checkedAt: new Date().toISOString()
  };
  statusCache = { at: Date.now(), body };
  ok(res, { status: body });
}));

/* ================================================================== */
/* Everything below needs a team session                               */
/* ================================================================== */

api.use(requireTeam);

api.get('/catalog', (_req, res) =>
  ok(res, {
    tones: TONES,
    voiceCharacteristics: VOICE_CHARACTERISTICS,
    languagesPrimary: LANGUAGES_PRIMARY,
    languagesMore: LANGUAGES_MORE,
    provenTones: insights.topTones(4).map((t) => t.toneId),
    audioPost: config.audio.enabled
  })
);

api.get('/insights', (_req, res) => ok(res, { insights: insights.snapshot() }));

api.post('/brand', wrap(async (req, res) => {
  const brand = await fetchBrand(req.body.url);
  ok(res, { brand });
}));

api.get('/beds', wrap(async (_req, res) => {
  try {
    ok(res, { beds: await cdn.listBeds() });
  } catch (err) {
    log.warn('beds', err.message);
    ok(res, { beds: [], note: `No music beds available: ${err.message}` });
  }
}));

/** Ask the model for a music prompt that suits this tone and this listener. */
api.post('/projects/:projectId/bed-prompt', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const toneId = req.body.toneId || project.tones?.[0];
  const job = startJob('bed-prompt', () =>
    ai.bedPrompt({ analysis: project.analysis, customer: project.customer, brand: project.brand, toneId }),
    { projectId: project.projectId });
  ok(res, { jobId: job.jobId });
}));

/** Compose a bed with Eleven Music and file it with the rest of the library. */
api.post('/beds/generate', wrap(async (req, res) => {
  const prompt = String(req.body.prompt || '').trim();
  if (!prompt) return fail(res, 400, 'Describe the music you want.');
  const seconds = Math.min(120, Math.max(10, Number(req.body.seconds) || 35));
  const name = String(req.body.name || '').trim() || prompt.slice(0, 40);

  const job = startJob('compose-bed', async () => {
    const buffer = await eleven.composeMusic({ prompt, seconds });
    const uploaded = await cdn.uploadBuffer(buffer, {
      folder: `${config.cloudinary.bedFolder}/generated`,
      publicId: `${cdn.slug(name)}-${Date.now().toString(36)}`,
      resourceType: 'video',
      tags: ['music-bed', 'generated-bed'],
      context: { name, prompt: prompt.slice(0, 400), project: String(req.body.project || '').slice(0, 80) }
    });
    return {
      publicId: uploaded.public_id,
      url: uploaded.secure_url,
      name,
      seconds: uploaded.duration || seconds,
      source: 'generated',
      prompt
    };
  }, { prompt: prompt.slice(0, 80) });

  ok(res, { jobId: job.jobId });
}));

/** Upload a bed the agency already owns the rights to. */
api.post('/beds/upload', wrap(async (req, res) => {
  const dataUrl = String(req.body.dataUrl || '');
  const match = dataUrl.match(/^data:(audio\/[a-z0-9.+-]+|application\/octet-stream);base64,(.+)$/i);
  if (!match) return fail(res, 400, 'Upload an MP3, WAV, M4A or OGG file.');

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 20 * 1024 * 1024) return fail(res, 400, 'That file is over 20 MB. Trim it or export a smaller version.');

  const name = String(req.body.name || 'uploaded bed').trim();
  const uploaded = await cdn.uploadBuffer(buffer, {
    folder: `${config.cloudinary.bedFolder}/uploaded`,
    publicId: `${cdn.slug(name)}-${Date.now().toString(36)}`,
    resourceType: 'video',
    tags: ['music-bed', 'uploaded-bed'],
    context: { name, project: String(req.body.project || '').slice(0, 80) }
  });

  ok(res, {
    bed: {
      publicId: uploaded.public_id, url: uploaded.secure_url, name,
      seconds: uploaded.duration || null, source: 'uploaded'
    }
  });
}));

/* ---------------- projects ---------------- */

api.post('/projects', wrap(async (req, res) => {
  const c = req.body.customer || {};
  const required = ['customerName', 'email', 'teamMember', 'projectName', 'homeUrl'];
  const missing = required.filter((k) => !String(c[k] || '').trim());
  if (missing.length) return fail(res, 400, `Still need: ${missing.join(', ')}.`);

  const project = store.create({
    customer: {
      customerName: c.customerName.trim(),
      company: (c.company || '').trim(),
      email: c.email.trim(),
      teamMember: c.teamMember.trim(),
      projectName: c.projectName.trim(),
      homeUrl: c.homeUrl.trim(),
      landingUrl: (c.landingUrl || '').trim(),
      promotion: (c.promotion || '').trim(),
      disclaimer: (c.disclaimer || '').trim(),
      language: (c.language || 'en').trim(),
      phone: (c.phone || '').trim()
    },
    brand: req.body.brand || null,
    pronunciations: req.body.pronunciations || [],
    reusedFrom: req.body.reusedFrom || null
  });

  ok(res, { project });
}));

api.get('/projects/:projectId', (req, res) => {
  const project = requireProject(req, res);
  if (project) ok(res, { project });
});

/** Brandfetch had no logo — let the team upload one so banners still work. */
api.post('/projects/:projectId/logo', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const dataUrl = String(req.body.dataUrl || '');
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return fail(res, 400, 'Upload a PNG, JPG or SVG logo file.');

  const folder = cdn.folderFor(project.customer, project.createdAt);
  const uploaded = await cdn.uploadBuffer(Buffer.from(match[2], 'base64'), {
    folder, publicId: 'client-logo', resourceType: 'image', tags: ['logo', 'uploaded']
  });

  const brand = { ...(project.brand || { found: false, colors: [] }), logo: uploaded.secure_url };
  store.update(project.projectId, {
    brand,
    logoAsset: { url: uploaded.secure_url, publicId: uploaded.public_id }
  });
  ok(res, { logo: uploaded.secure_url, project: store.get(project.projectId) });
}));

api.post('/projects/:projectId/pronunciations', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const list = (req.body.pronunciations || [])
    .filter((p) => String(p?.from || '').trim() && String(p?.to || '').trim())
    .slice(0, 40)
    .map((p) => ({ from: String(p.from).trim().slice(0, 60), to: String(p.to).trim().slice(0, 80) }));
  store.update(project.projectId, { pronunciations: list });
  ok(res, { pronunciations: list });
}));

api.post('/projects/:projectId/settings', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const patch = {};
  if (req.body.musicBed !== undefined) patch.musicBed = req.body.musicBed;
  if (req.body.singleVoice !== undefined) patch.singleVoice = Boolean(req.body.singleVoice);
  if (req.body.bedPercent !== undefined) {
    patch.bedPercent = Math.max(2, Math.min(60, Number(req.body.bedPercent) || 25));
  }
  store.update(project.projectId, patch);
  ok(res, { project: store.get(project.projectId) });
}));

/* ---------------- brief ---------------- */

api.post('/projects/:projectId/analyze', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;

  const job = startJob('analyze', async () => {
    const historyHint = insights.topTones(4).map((t) => toneById(t.toneId)?.label).filter(Boolean);
    const analysis = await ai.analyzeProject({ brand: project.brand, customer: project.customer, historyHint });
    store.update(project.projectId, { analysis, status: 'analyzed' });
    return analysis;
  }, { projectId: project.projectId });

  ok(res, { jobId: job.jobId });
}));

api.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return fail(res, 404, 'That job is gone — the studio may have restarted. Run the step again.', { expired: true });
  ok(res, { job: { jobId: job.jobId, kind: job.kind, status: job.status, result: job.result, error: job.error } });
});

/* ---------------- tones, banners, casting ---------------- */

api.post('/projects/:projectId/tones', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const tones = (req.body.tones || []).filter((t) => toneById(t));
  if (!tones.length) return fail(res, 400, 'Pick at least one tone.');

  store.update(project.projectId, { tones, status: 'tones-selected' });

  const needBanners = tones.filter((t) => !['ready', 'running'].includes(project.banners?.[t]?.status));
  const bannerJobs = needBanners.map((toneId) => startBannerJob(project.projectId, toneId));
  const profileJob = startJob('voice-profile', async () => {
    const p = store.get(project.projectId);
    const profile = await ai.suggestVoiceProfile({ analysis: p.analysis, customer: p.customer, toneIds: tones });
    store.update(p.projectId, { voiceProfile: profile });
    return profile;
  }, { projectId: project.projectId });

  ok(res, {
    project: store.get(project.projectId),
    bannerJobIds: bannerJobs.map((j) => j.jobId),
    voiceProfileJobId: profileJob.jobId
  });
}));

function startBannerJob(projectId, toneId) {
  return startJob('banner', async () => {
    const project = store.get(projectId);
    const tone = toneById(toneId);
    store.mutate(projectId, (p) => { p.banners[toneId] = { toneId, status: 'running' }; });

    let copy = await ai.bannerCopy({
      analysis: project.analysis, brand: project.brand, customer: project.customer, toneId
    }).catch(() => ({ headline: tone.line, support: project.brand?.name || '', cta: tone.line }));

    // Word budget, enforced the way the ad builder enforces it: an
    // over-budget line goes back to the copywriter with a hard cap, and
    // only if that also fails is it clamped at a word boundary.
    const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
    if (words(copy.headline).length > HEADLINE_MAX_WORDS || words(copy.support).length > SUPPORT_MAX_WORDS) {
      const retry = await ai.bannerCopy({
        analysis: project.analysis, brand: project.brand, customer: project.customer, toneId,
        shorten: { headline: HEADLINE_MAX_WORDS, support: SUPPORT_MAX_WORDS }
      }).catch(() => null);
      if (retry && words(retry.headline).length <= HEADLINE_MAX_WORDS) copy = retry;
      copy.headline = words(copy.headline).slice(0, HEADLINE_MAX_WORDS).join(' ');
      copy.support = words(copy.support).slice(0, SUPPORT_MAX_WORDS).join(' ');
    }

    // Get the logo into the account first so the banner can overlay it
    // natively instead of fetching it from the client's website.
    let logoAsset = project.logoAsset || null;
    if (!logoAsset && project.brand?.logo) {
      const folder0 = cdn.folderFor(project.customer, project.createdAt);
      const up = await cdn.uploadRemote(project.brand.logo, { folder: folder0, publicId: 'client-logo', tags: ['logo'], colors: true });
      if (up) {
        logoAsset = {
          url: up.secure_url, publicId: up.public_id,
          colors: (up.colors || []).slice(0, 4).map((c) => c[0])
        };
        store.update(projectId, { logoAsset });
      } else {
        log.warn('banner', "Couldn't copy the client logo into Cloudinary — the banner will be built without it.");
      }
    }

    const art = await ai.bannerArt({
      brand: project.brand, toneId, headline: copy.cta || copy.headline, analysis: project.analysis
    });
    const folder = cdn.folderFor(project.customer, project.createdAt);
    const uploaded = await cdn.uploadBuffer(Buffer.from(art.b64, 'base64'), {
      folder: `${folder}/banners`, publicId: `banner-art-${toneId}`, resourceType: 'image',
      tags: ['companion-banner', toneId], colors: true,
      context: { tone: tone.label, project: project.customer.projectName }
    });
    const artColors = (uploaded.colors || []).slice(0, 5).map((c) => c[0]);

    const accent = (project.brand?.colors?.[0]?.hex || '#FFB020').replace('#', '');

    // Colour fixes BEFORE the build, the way the ad builder substitutes a
    // readable pair when the brand palette can't carry text: a dark accent
    // is lightened for the support line, and a mid-tone accent that can't
    // letter its own bar hands the domain to the dark panel. Both are noted.
    const autoFixes = [];
    const supportFix = bannerQa.readableSupportColor(accent);
    if (supportFix.adjusted) autoFixes.push(`The brand accent could not read on the dark panel, so the support line uses a lightened version (${supportFix.hex}).`);
    const domainFix = bannerQa.readableDomainBar(accent);
    if (domainFix.adjusted) autoFixes.push('Neither white nor black cleared 4.5:1 on the accent bar, so the web address sits on the dark panel instead.');

    const shared = {
      logoPublicId: logoAsset?.publicId || null,
      logoUrl: logoAsset ? null : project.brand?.logo,
      logoColors: logoAsset?.colors || [],
      artColors,
      headline: copy.headline || copy.cta,
      support: copy.support || copy.offer,
      homeUrl: project.customer.homeUrl,
      landingUrl: project.customer.landingUrl,
      accent,
      supportColor: supportFix.color,
      domainBar: domainFix.bar
    };

    // Build it, then prove it renders. The commonest failure is the logo:
    // Cloudinary blocks fetch overlays unless the account allows them, and a
    // single bad layer fails the whole image rather than degrading.
    const build = (opts, quality = null) => ({
      '300x250': cdn.bannerUrl(uploaded.public_id, { width: 300, height: 250, quality, ...opts }),
      '640x640': cdn.bannerUrl(uploaded.public_id, { width: 640, height: 640, quality, ...opts })
    });

    let sizes = build(shared);
    let note = null;
    let check = await cdn.verifyDerived(sizes['300x250']);

    let finalOpts = shared;   // the overlay set that actually rendered
    let composed = true;      // false when we fell all the way back to raw art

    if (!check.ok && (shared.logoPublicId || shared.logoUrl)) {
      log.warn('banner', `With logo: ${check.reason}. Retrying without it.`);
      finalOpts = { ...shared, logoUrl: null, logoPublicId: null };
      sizes = build(finalOpts);
      const second = await cdn.verifyDerived(sizes['300x250']);
      if (second.ok) {
        note = 'The logo could not be placed on the banner, so it was built without it. The rest of the banner is fine.';
      } else {
        log.error('banner', `Without logo too: ${second.reason}`);
        finalOpts = { ...shared, logoUrl: null, logoPublicId: null, support: null };
        sizes = build(finalOpts);
        const third = await cdn.verifyDerived(sizes['300x250']);
        note = third.ok
          ? 'Only the headline could be placed on the banner. Check the Cloudinary log for the failing layer.'
          : `The banner artwork rendered but the overlays failed: ${second.reason}`;
        if (!third.ok) { sizes = { '300x250': uploaded.secure_url, '640x640': uploaded.secure_url }; composed = false; }
      }
    } else if (!check.ok) {
      log.error('banner', check.reason);
      note = `Banner overlays failed: ${check.reason}`;
      sizes = { '300x250': uploaded.secure_url, '640x640': uploaded.secure_url };
      composed = false;
    }

    // ---- The ad-builder QA gate, applied here ------------------------
    // 1. File weight: never reject, make it fit — step the quality down
    //    until every size is under the 150 KB ceiling.
    // 2. Then run the full check suite against the delivered pixels.
    let qa = null;
    if (composed) {
      try {
        const fitted = await bannerQa.fitBannerWeight((q) => build(finalOpts, q), sizes);
        sizes = fitted.sizes;
        if (fitted.note) autoFixes.push(fitted.note);

        let logoBuffer = null;
        if (finalOpts.logoPublicId && logoAsset?.url) {
          logoBuffer = await fetch(logoAsset.url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? Buffer.from(b) : null)).catch(() => null);
        }
        qa = await bannerQa.runBannerQa({
          sizes,
          textFreeUrl: cdn.bannerUrl(uploaded.public_id, { width: 300, height: 250, ...finalOpts, textFree: true }),
          title: finalOpts.headline || '',
          sub: finalOpts.support || '',
          domain: rootDomain(finalOpts.homeUrl, finalOpts.landingUrl),
          accentHex: accent,
          supportColorHex: supportFix.adjusted ? supportFix.hex : null,
          domainBarFixed: domainFix.adjusted,
          logoBuffer,
          logoPlate: plateFor(logoAsset?.colors || []).plate
        });
        qa.autoFixes = autoFixes;
        if (qa.verdict === 'fail') log.warn('banner-qa', `${toneId}: ${qa.findings.filter((f) => f.status === 'fail').map((f) => `${f.check} — ${f.detail}`).join('; ')}`);
      } catch (err) {
        log.warn('banner-qa', `QA could not run: ${err.message}`);
        qa = { findings: [{ check: 'qa', status: 'warn', detail: `QA could not run: ${err.message}` }], verdict: 'warn', autoFixes };
      }
    } else {
      qa = {
        findings: [{ check: 'render', status: 'fail', detail: 'Overlays failed — the raw artwork shipped with no text or logo. Rebuild before sending this to a client.' }],
        verdict: 'fail',
        autoFixes
      };
    }

    const banner = {
      toneId, toneLabel: tone.label, status: 'ready', ...copy,
      artPublicId: uploaded.public_id, artUrl: uploaded.secure_url,
      // Companion banners are clickable — this is where a tap lands.
      clickThroughUrl: project.customer.landingUrl || project.customer.homeUrl || '',
      note,
      contrast: cdn.bannerContrastReport({ accent, artColors, logoColors: logoAsset?.colors || [] }),
      qa,
      sizes
    };
    banner.url = banner.sizes['300x250'];
    store.mutate(projectId, (p) => { p.banners[toneId] = banner; });
    return banner;
  }, { projectId, toneId });
}

api.post('/projects/:projectId/banners/:toneId/retry', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  ok(res, { jobId: startBannerJob(project.projectId, req.params.toneId).jobId });
}));

/* ---------------- scripts ---------------- */

function spotShape(toneId, block, seconds, written, pairId) {
  const tone = toneById(toneId);
  const script = block.script || '';
  return {
    id: id('spot'), pairId, toneId, toneLabel: tone.label, seconds,
    hook: written.hook, script, notes: block.notes,
    wordCount: speech.countWords(script),
    estimatedSeconds: speech.estimateSeconds(script),
    status: 'review', revisions: [], edited: false,
    voiceId: null, voiceName: null, audioUrl: null, audioPublicId: null,
    audioStatus: null, finalSeconds: null, durationGrade: null,
    createdAt: new Date().toISOString()
  };
}

function buildPair(toneId, written, pairId) {
  return [spotShape(toneId, written.fifteen, 15, written, pairId), spotShape(toneId, written.thirty, 30, written, pairId)];
}

/** Keep every version so "go back to the first one" is always possible. */
function saveDraft(projectId, pairId, toneId, pair, note) {
  store.mutate(projectId, (p) => {
    p.drafts.push({
      draftId: id('draft'), pairId, toneId, note: note || null,
      at: new Date().toISOString(),
      spots: pair.map((s) => ({ seconds: s.seconds, script: s.script, notes: s.notes, wordCount: s.wordCount }))
    });
    if (p.drafts.length > 120) p.drafts.shift();
  });
}

api.post('/projects/:projectId/scripts', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const { toneId } = req.body;
  if (!toneById(toneId)) return fail(res, 400, 'Pick a tone first.');

  const job = startJob('scripts', async () => {
    const p = store.get(project.projectId);
    const written = await ai.writeScripts({ analysis: p.analysis, brand: p.brand, customer: p.customer, toneId });
    const pairId = id('pair');
    const pair = buildPair(toneId, written, pairId);
    store.mutate(p.projectId, (proj) => {
      proj.commercials = proj.commercials.filter((c) => c.toneId !== toneId || c.status === 'approved');
      proj.commercials.push(...pair);
    });
    saveDraft(p.projectId, pairId, toneId, pair, 'first draft');
    insights.scriptWritten(toneId);
    return pair;
  }, { projectId: project.projectId, toneId });

  ok(res, { jobId: job.jobId });
}));

api.post('/projects/:projectId/commercials/:spotId/decision', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const { decision, note } = req.body;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');

  if (decision === 'approve' || decision === 'reject') {
    store.mutate(project.projectId, (p) => {
      p.commercials.find((c) => c.id === spot.id).status = decision === 'approve' ? 'approved' : 'rejected';
    });
    if (decision === 'approve') insights.scriptApproved(spot.toneId);
    return ok(res, { project: store.get(project.projectId) });
  }

  if (decision === 'revise') {
    if (!String(note || '').trim()) return fail(res, 400, 'Tell us what to change.');
    const job = startJob('revise', async () => {
      const p = store.get(project.projectId);
      const pair = p.commercials.filter((c) => c.pairId === spot.pairId);
      const previous = { fifteen: pair.find((c) => c.seconds === 15), thirty: pair.find((c) => c.seconds === 30) };
      const written = await ai.writeScripts({
        analysis: p.analysis, brand: p.brand, customer: p.customer,
        toneId: spot.toneId, revisionNote: note, previous
      });
      const rewritten = buildPair(spot.toneId, written, spot.pairId);
      const history = [...(spot.revisions || []), { at: new Date().toISOString(), note }];
      rewritten.forEach((c) => (c.revisions = history));

      store.mutate(p.projectId, (proj) => {
        proj.commercials = proj.commercials.filter((c) => c.pairId !== spot.pairId);
        proj.commercials.push(...rewritten);
      });
      saveDraft(p.projectId, spot.pairId, spot.toneId, rewritten, note);
      insights.scriptRevised(spot.toneId);
      return rewritten;
    }, { projectId: project.projectId });
    return ok(res, { jobId: job.jobId });
  }

  fail(res, 400, 'Decision must be approve, reject or revise.');
}));

/** Direct edit — a one-word change should not need a whole regenerate. */
api.patch('/projects/:projectId/commercials/:spotId', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');
  const script = String(req.body.script || '').trim();
  if (!script) return fail(res, 400, 'The script cannot be empty.');

  store.mutate(project.projectId, (p) => {
    const s = p.commercials.find((c) => c.id === spot.id);
    s.script = script;
    s.wordCount = speech.countWords(script);
    s.estimatedSeconds = speech.estimateSeconds(script);
    s.edited = true;
    // The recorded take no longer matches the words.
    if (s.audioUrl) { s.audioUrl = null; s.audioStatus = 'needs-rerender'; s.finalSeconds = null; s.durationGrade = null; }
  });
  saveDraft(project.projectId, spot.pairId, spot.toneId,
    store.get(project.projectId).commercials.filter((c) => c.pairId === spot.pairId), 'edited by hand');

  ok(res, { project: store.get(project.projectId) });
}));

/** Cut a read that came back over the slot. */
api.post('/projects/:projectId/commercials/:spotId/tighten', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');
  const trimWords = Number(req.body.trimWords) || spot.durationGrade?.trimWords || 4;

  const job = startJob('tighten', async () => {
    const p = store.get(project.projectId);
    const result = await ai.tightenScript({
      script: spot.script, seconds: spot.seconds, trimWords,
      toneId: spot.toneId, analysis: p.analysis, customer: p.customer
    });
    store.mutate(p.projectId, (proj) => {
      const s = proj.commercials.find((c) => c.id === spot.id);
      s.script = result.script;
      s.wordCount = speech.countWords(result.script);
      s.estimatedSeconds = speech.estimateSeconds(result.script);
      s.audioUrl = null; s.audioStatus = 'needs-rerender'; s.finalSeconds = null; s.durationGrade = null;
    });
    saveDraft(p.projectId, spot.pairId, spot.toneId,
      store.get(p.projectId).commercials.filter((c) => c.pairId === spot.pairId), `tightened: ${result.whatWentAndWhy || ''}`);
    return result;
  }, { projectId: project.projectId, spotId: spot.id });

  ok(res, { jobId: job.jobId });
}));

/** The read came back short — lengthen it with the website and phone. */
api.post('/projects/:projectId/commercials/:spotId/extend', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');
  const addWords = Number(req.body.addWords) || spot.durationGrade?.addWords || 8;

  const job = startJob('extend', async () => {
    const p = store.get(project.projectId);
    const result = await ai.extendScript({
      script: spot.script, seconds: spot.seconds, addWords,
      toneId: spot.toneId, analysis: p.analysis, customer: p.customer
    });
    store.mutate(p.projectId, (proj) => {
      const t = proj.commercials.find((c) => c.id === spot.id);
      t.script = result.script;
      t.wordCount = speech.countWords(result.script);
      t.estimatedSeconds = speech.estimateSeconds(result.script, proj.measuredRate);
      t.audioUrl = null; t.audioStatus = 'needs-rerender'; t.finalSeconds = null; t.durationGrade = null;
    });
    saveDraft(p.projectId, spot.pairId, spot.toneId,
      store.get(p.projectId).commercials.filter((c) => c.pairId === spot.pairId),
      `lengthened: ${result.whatWasAdded || ''}`);
    return result;
  }, { projectId: project.projectId, spotId: spot.id });

  ok(res, { jobId: job.jobId });
}));

/** How the words will actually be read out loud. */
api.post('/projects/:projectId/commercials/:spotId/speech-preview', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');
  const overrides = req.body.pronunciations || project.pronunciations;
  ok(res, { preview: speech.normalizeForSpeech(spot.script, overrides, project.customer.language) });
});

/* ---------------- version history ---------------- */

api.get('/projects/:projectId/drafts', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const pairId = req.query.pairId;
  ok(res, { drafts: project.drafts.filter((d) => !pairId || d.pairId === pairId).slice().reverse() });
});

api.post('/projects/:projectId/drafts/:draftId/restore', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const draft = project.drafts.find((d) => d.draftId === req.params.draftId);
  if (!draft) return fail(res, 404, 'That version is no longer on file.');

  store.mutate(project.projectId, (p) => {
    for (const c of p.commercials) {
      if (c.pairId !== draft.pairId) continue;
      const version = draft.spots.find((s) => s.seconds === c.seconds);
      if (!version) continue;
      c.script = version.script;
      c.notes = version.notes;
      c.wordCount = speech.countWords(version.script);
      c.estimatedSeconds = speech.estimateSeconds(version.script);
      c.audioUrl = null; c.audioStatus = c.audioStatus ? 'needs-rerender' : null;
      c.finalSeconds = null; c.durationGrade = null;
    }
  });
  ok(res, { project: store.get(project.projectId) });
}));

/* ---------------- casting ---------------- */

api.post('/projects/:projectId/voices', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const characteristics = req.body.characteristics || {};
  const searchTerms = project.voiceProfile?.searchTerms || [];
  const voices = await eleven.matchVoices({ ...characteristics, searchTerms }, 3);

  // Mark voices this agency has actually shipped before.
  const proven = new Map(insights.topVoices(20).map((v) => [v.voiceId, v.published]));
  for (const v of voices) if (proven.has(v.voiceId)) v.provenCount = proven.get(v.voiceId);

  store.update(project.projectId, { voiceCharacteristics: characteristics, status: 'casting' });
  ok(res, { voices });
}));

api.post('/projects/:projectId/voices/custom', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const voiceId = String(req.body.voiceId || '').trim();
  if (!voiceId) return fail(res, 400, 'Paste an ElevenLabs voice ID.');
  ok(res, { voice: await eleven.getVoice(voiceId) });
}));

/* ---------------- render ---------------- */

function startRender(projectId, spotId, voice) {
  return startJob('render-audio', async () => {
    const p = store.get(projectId);
    const s = p.commercials.find((c) => c.id === spotId);
    if (!s) throw new Error('That spot is no longer in the project.');

    // 1. Rewrite the copy the way it should be spoken.
    const { spoken, changes } = speech.normalizeForSpeech(s.script, p.pronunciations, p.customer.language);

    // 2. Voice it.
    const raw = await eleven.renderAudio({
      voiceId: voice.voiceId, script: spoken, energy: p.voiceCharacteristics?.energy
    });

    // 3. Bed, duck, normalize to broadcast loudness, pad to the slot.
    const produced = await audio.postProduce(raw, {
      targetSeconds: s.seconds,
      bedUrl: p.musicBed?.url || null,
      bedPercent: p.bedPercent ?? 25
    });

    // 4. File it.
    const folder = cdn.folderFor(p.customer, p.createdAt);
    const uploaded = await cdn.uploadBuffer(produced.buffer, {
      folder: `${folder}/audio`,
      publicId: `${s.toneId}-${s.seconds}s`,
      resourceType: 'video',
      tags: ['radio-spot', s.toneId, `${s.seconds}s`],
      context: { tone: s.toneLabel, voice: voice.name, project: p.customer.projectName }
    });

    const measured = produced.rawSeconds ?? uploaded.duration ?? null;
    // Learn this voice's actual pace so the next estimate is closer.
    const rate = speech.measuredRate(spoken, measured) || p.measuredRate || null;
    const grade = speech.gradeDuration(measured, s.seconds, rate);

    store.mutate(p.projectId, (proj) => {
      const t = proj.commercials.find((c) => c.id === spotId);
      t.voiceId = voice.voiceId;
      t.voiceName = voice.name;
      t.audioUrl = uploaded.secure_url;
      t.audioPublicId = uploaded.public_id;
      t.finalSeconds = produced.finalSeconds ?? uploaded.duration ?? null;
      t.rawSeconds = produced.rawSeconds ?? null;
      t.durationGrade = grade;
      t.speechChanges = changes;
      t.postProduced = produced.postProduced;
      t.bedName = p.musicBed?.name || null;
      t.bedPercent = p.musicBed ? (p.bedPercent ?? 25) : null;
      t.audioStatus = 'ready';
      if (rate) proj.measuredRate = rate;
    });

    return { spotId, audioUrl: uploaded.secure_url, durationGrade: grade, speechChanges: changes };
  }, { projectId, spotId });
}

api.post('/projects/:projectId/commercials/:spotId/voice', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');
  const voice = req.body.voice;
  if (!voice?.voiceId) return fail(res, 400, 'Choose a voice.');

  store.mutate(project.projectId, (p) => {
    const s = p.commercials.find((c) => c.id === spot.id);
    s.voiceId = voice.voiceId; s.voiceName = voice.name;
    s.audioUrl = null; s.audioStatus = 'rendering';
  });

  ok(res, { jobId: startRender(project.projectId, spot.id, voice).jobId });
}));

/** Re-record after an edit, a tighten, or a restart that stranded a job. */
api.post('/projects/:projectId/commercials/:spotId/rerender', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');
  const voice = req.body.voice || (spot.voiceId ? { voiceId: spot.voiceId, name: spot.voiceName } : null);
  if (!voice) return fail(res, 400, 'Pick a voice for this spot first.');

  store.mutate(project.projectId, (p) => {
    const s = p.commercials.find((c) => c.id === spot.id);
    s.audioUrl = null; s.audioStatus = 'rendering';
  });
  ok(res, { jobId: startRender(project.projectId, spot.id, voice).jobId });
}));

/* ---------------- playlist ---------------- */

api.post('/projects/:projectId/commercials/:spotId/publish', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const spot = project.commercials.find((c) => c.id === req.params.spotId);
  if (!spot) return fail(res, 404, 'That spot is not in this project.');
  if (!spot.audioUrl) return fail(res, 400, 'The audio is still rendering.');

  const banner = project.banners?.[spot.toneId];
  const entry = {
    spotId: spot.id, toneId: spot.toneId, toneLabel: spot.toneLabel, seconds: spot.seconds,
    script: spot.script, notes: spot.notes, voiceId: spot.voiceId, voiceName: spot.voiceName,
    audioUrl: spot.audioUrl, audioPublicId: spot.audioPublicId,
    finalSeconds: spot.finalSeconds, durationGrade: spot.durationGrade,
    bedName: spot.bedName || null, postProduced: spot.postProduced || false,
    bannerUrl: banner?.url || null, bannerSizes: banner?.sizes || null,
    clickThroughUrl: banner?.clickThroughUrl || project.customer.landingUrl || project.customer.homeUrl || '',
    addedAt: new Date().toISOString()
  };

  store.mutate(project.projectId, (p) => {
    p.playlist = p.playlist.filter((i) => i.spotId !== spot.id);
    p.playlist.push(entry);
    p.commercials.find((c) => c.id === spot.id).audioStatus = 'published';
    p.cloudinaryFolder = cdn.folderFor(p.customer, p.createdAt);
    p.status = 'playlist';
  });
  insights.spotPublished(spot.toneId, spot.voiceId, spot.voiceName);

  ok(res, { project: store.get(project.projectId) });
}));

api.post('/projects/:projectId/finalize', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!project.playlist.length) return fail(res, 400, 'Approve at least one commercial first.');

  const folder = cdn.folderFor(project.customer, project.createdAt);
  const notices = [];

  let logoAsset = project.logoAsset || null;
  if (project.brand?.logo && !logoAsset) {
    const uploaded = await cdn.uploadRemote(project.brand.logo, { folder, publicId: 'client-logo', tags: ['logo'] });
    if (uploaded) logoAsset = { url: uploaded.secure_url, publicId: uploaded.public_id };
    else notices.push("The logo couldn't be copied to Cloudinary. Everything else saved.");
  }
  if (!project.brand?.logo) notices.push('No logo on file — the companion banners went out without their mark.');

  const long = project.playlist.filter((i) => i.durationGrade?.status === 'long');
  if (long.length) notices.push(`${long.length} spot${long.length === 1 ? ' runs' : 's run'} over the slot. Most ad servers will reject that.`);

  store.update(project.projectId, {
    cloudinaryFolder: folder, logoAsset, status: 'complete', reviewUrl: reviewLink(project)
  });

  let opportunity = null;
  try {
    opportunity = await ghl.sendOpportunity(store.get(project.projectId));
    store.update(project.projectId, { opportunitySentAt: new Date().toISOString() });
  } catch (err) {
    notices.push(`The opportunity didn't reach GoHighLevel: ${err.message}`);
    log.error('ghl.opportunity', err.message);
  }

  ok(res, { project: store.get(project.projectId), opportunity, notices });
}));

api.post('/projects/:projectId/approval', wrap(async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const { recipientName, recipientEmail, comments } = req.body;
  if (!recipientEmail) return fail(res, 400, 'Who should review it? Add an email address.');

  store.update(project.projectId, { reviewUrl: reviewLink(project) });
  const result = await ghl.sendForApproval(store.get(project.projectId), { recipientName, recipientEmail, comments });
  store.update(project.projectId, {
    approvalRequest: { recipientName, recipientEmail, comments, sentAt: new Date().toISOString() },
    status: 'sent-for-approval'
  });
  ok(res, { result, project: store.get(project.projectId), reviewUrl: reviewLink(project) });
}));

/* ---------------- library ---------------- */

api.get('/library', (req, res) => {
  const results = store.library(req.query.q || '').map((p) => ({
    projectId: p.projectId, projectNumber: p.projectNumber,
    createdAt: p.createdAt, updatedAt: p.updatedAt, status: p.status,
    customerName: p.customer?.customerName, company: p.customer?.company || p.brand?.name || '',
    email: p.customer?.email, teamMember: p.customer?.teamMember, projectName: p.customer?.projectName,
    homeUrl: p.customer?.homeUrl, tones: p.tones, spotCount: p.playlist?.length || 0,
    cloudinaryFolder: p.cloudinaryFolder, logo: p.brand?.logo || null,
    reviewDecision: p.reviewDecision?.outcome || null
  }));
  ok(res, { results });
});

api.get('/library/:projectId/settings', (req, res) => {
  const p = store.get(req.params.projectId);
  if (!p) return fail(res, 404, 'That project is no longer on file.');
  ok(res, {
    settings: {
      customer: {
        customerName: p.customer.customerName, company: p.customer.company, email: p.customer.email,
        teamMember: p.customer.teamMember, homeUrl: p.customer.homeUrl,
        landingUrl: p.customer.landingUrl, disclaimer: p.customer.disclaimer || '',
        language: p.customer.language || 'en'
      },
      brand: p.brand, tones: p.tones, voiceCharacteristics: p.voiceCharacteristics,
      pronunciations: p.pronunciations || [], musicBed: p.musicBed || null,
      singleVoice: p.singleVoice !== false,
      voices: [...new Map((p.playlist || []).map((i) => [i.voiceId, { voiceId: i.voiceId, name: i.voiceName }])).values()],
      sourceProjectId: p.projectId, sourceProjectName: p.customer.projectName
    }
  });
});

/* ---------------- diagnostics ---------------- */

async function timed(name, fn) {
  const started = Date.now();
  try {
    return { name, status: 'ok', ms: Date.now() - started, detail: await fn() };
  } catch (err) {
    return { name, status: 'error', ms: Date.now() - started, detail: err.message };
  }
}

api.get('/diagnostics', wrap(async (_req, res) => {
  const checks = await Promise.all([
    timed('OpenAI', async () => {
      const r = await fetch(`${config.openai.base}/models/${config.openai.textModel}`, {
        headers: { Authorization: `Bearer ${config.openai.key}` }
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
      return `Model ${config.openai.textModel} reachable`;
    }),
    timed('Brandfetch', async () => {
      const b = await fetchBrand('smart1marketing.com');
      return b.found ? `Resolved ${b.name || b.domain}` : 'Reachable, no record for the test domain';
    }),
    timed('ElevenLabs', async () => {
      const a = await eleven.accountCheck();
      return `${a.tier} plan, ${a.remaining?.toLocaleString?.() ?? a.remaining} characters left`;
    }),
    timed('Cloudinary', async () => {
      const u = await cdn.usage();
      return `Plan ${u.plan}, ${u.credits ?? 0} credits used`;
    }),
    timed('Music beds', async () => {
      const beds = await cdn.listBeds();
      if (!beds.length) throw new Error(`No beds in ${config.cloudinary.bedFolder} — spots will ship dry.`);
      return `${beds.length} bed${beds.length === 1 ? '' : 's'} available`;
    }),
    timed('Eleven Music', async () => {
      if (!config.elevenlabs.key) throw new Error('No ElevenLabs key.');
      return `Ready to compose with ${config.elevenlabs.musicModel} (paid plan required — it carries the commercial licence)`;
    }),
    timed('Audio mastering', async () => {
      if (!config.audio.enabled) throw new Error('Turned off by AUDIO_POST_ENABLED.');
      if (!(await audio.ffmpegAvailable())) throw new Error('ffmpeg is not runnable on this host.');
      return `ffmpeg ready, mastering to ${config.audio.targetLufs} LUFS`;
    }),
    timed('Sign-in', async () => {
      if (!config.auth.password) throw new Error('No STUDIO_PASSWORD — anyone with the URL can spend your API credits.');
      if (config.auth.secret === 'change-me-in-production') throw new Error('SESSION_SECRET is still the default.');
      return 'Password and session secret set';
    }),
    timed('GHL opportunity webhook', async () => {
      if (!config.ghl.opportunityWebhook) throw new Error('No URL configured.');
      return 'URL configured (not called — sending a test would create a record)';
    }),
    timed('GHL approval webhook', async () => {
      if (!config.ghl.approvalWebhook) throw new Error('No URL configured.');
      return 'URL configured (not called — sending a test would email a reviewer)';
    })
  ]);

  ok(res, {
    checks,
    missingKeys: missingKeys(),
    runtime: {
      appVersion: APP_VERSION,
      buildIncludes: APP_FEATURES.join(' · '),
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      projectsOnFile: store.all().length,
      playlistsOnFile: store.library().length,
      textModel: config.openai.textModel,
      imageModel: config.openai.imageModel,
      voiceModel: config.elevenlabs.model,
      loudnessTarget: `${config.audio.targetLufs} LUFS`,
      publicUrl: config.publicUrl || '(not set — review links will be relative)',
      cookieSameSite: config.auth.sameSite,
      embedOrigin: config.embedOrigin || '(not set — the studio cannot be framed by another site)',
      dataDir: config.dataDir
    }
  });
}));

api.post('/diagnostics/ghl-test', wrap(async (req, res) => {
  const which = req.body.which === 'approval' ? config.ghl.approvalWebhook : config.ghl.opportunityWebhook;
  if (!which) return fail(res, 400, 'That webhook URL is not configured.');
  const r = await fetch(which, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'Smart 1 Radio Studio', test: true, sentAt: new Date().toISOString() })
  });
  ok(res, { status: r.status, body: (await r.text()).slice(0, 400) });
}));

/**
 * Compose a banner against Cloudinary's built-in `sample` image and report
 * exactly what breaks. Costs nothing and needs no project — the fastest way
 * to find out whether it is the text layer, the logo layer, or the account.
 */
api.post('/diagnostics/banner-test', wrap(async (_req, res) => {
  const steps = [];
  const run = async (name, opts) => {
    const url = cdn.bannerUrl('sample', { width: 300, height: 250, ...opts });
    const check = await cdn.verifyDerived(url);
    steps.push({ name, ok: check.ok, reason: check.reason || null, url });
    return check.ok;
  };

  await run('Resize and scrim only', {});
  await run('Plus headline text', { headline: 'Stay warm' });
  await run('Plus subline and CTA', { headline: 'Stay warm', subline: '$89 tune-up', cta: 'Book now' });

  // Only meaningful if a logo has actually been filed in the account.
  const withLogo = store.all().map((p) => p.logoAsset?.publicId).filter(Boolean)[0];
  if (withLogo) await run('Plus a client logo overlay', { headline: 'Stay warm', logoPublicId: withLogo });
  else steps.push({ name: 'Plus a client logo overlay', ok: null, reason: 'No client logo on file yet — run a project first.', url: null });

  const firstFail = steps.find((x) => x.ok === false);
  ok(res, {
    steps,
    verdict: firstFail
      ? `First failure: ${firstFail.name} — ${firstFail.reason}`
      : 'Every layer composed. Banner rendering is healthy.'
  });
}));

api.post('/diagnostics/speech-test', (req, res) => {
  ok(res, { preview: speech.normalizeForSpeech(String(req.body.text || ''), req.body.pronunciations || []) });
});

api.get('/logs', (req, res) => ok(res, { logs: log.recent(Number(req.query.n) || 100) }));
api.delete('/logs', (_req, res) => { log.clear(); ok(res, {}); });
