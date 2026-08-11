import { showLoader, stopLoader } from './svg.js';
import { ensureAuth, signOut, api, esc, mountStatus } from './auth.js';

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

const stage = document.getElementById('stage');
const onair = document.getElementById('onair');
const onairText = document.getElementById('onairText');

const STATIONS = [
  { freq: '88.1', call: 'Setup' }, { freq: '91.3', call: 'Brief' }, { freq: '94.7', call: 'Copy' },
  { freq: '98.5', call: 'Cast' }, { freq: '101.9', call: 'Booth' }, { freq: '105.3', call: 'Package' },
  { freq: '108.1', call: 'Send' }
];

const state = {
  step: 1, projectId: null, project: null,
  catalog: { tones: [], voiceCharacteristics: [], provenTones: [] },
  brand: null, analysis: null, currentTone: null,
  voices: [], voiceProfile: null, beds: [], boothIndex: 0, reuse: null, busy: 0
};

function setBusy(on, label = 'Working') {
  state.busy = Math.max(0, state.busy + (on ? 1 : -1));
  const live = state.busy > 0;
  onair.classList.toggle('live', live);
  onairText.textContent = live ? label : 'Standby';
}

function toast(message, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

async function awaitJob(jobId, { timeoutMs = 240000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1400));
    try {
      const { job } = await api(`/jobs/${jobId}`);
      if (job.status === 'done') return job.result;
      if (job.status === 'error') throw new Error(job.error);
    } catch (err) {
      if (err.expired) throw new Error('The studio restarted while that was running. Run the step again.');
      throw err;
    }
  }
  throw new Error('That took longer than expected. Try the step again.');
}

async function withLoader(el, kind, jobId) {
  showLoader(el, kind);
  setBusy(true, kind.replace(/-/g, ' '));
  try { return await awaitJob(jobId); }
  finally { setBusy(false); stopLoader(); }
}

/* ------------------------------------------------------------------ */
/* Session recovery — the project lives in the URL                     */
/* ------------------------------------------------------------------ */

function writeHash() {
  if (!state.projectId) return;
  const parts = [`p=${state.projectId}`, `s=${state.step}`];
  if (state.currentTone) parts.push(`t=${state.currentTone}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const params = Object.fromEntries(raw.split('&').map((kv) => kv.split('=')));
  return params.p ? { projectId: params.p, step: Number(params.s) || 1, tone: params.t || null } : null;
}

/* ------------------------------------------------------------------ */
/* Dial                                                                */
/* ------------------------------------------------------------------ */

function paintDial() {
  document.getElementById('dialStations').innerHTML = STATIONS.map((s, i) => {
    const n = i + 1;
    const cls = n === state.step ? 'here' : n < state.step ? 'done' : '';
    return `<div class="station ${cls}"><b>${s.freq}</b>${esc(s.call)}</div>`;
  }).join('');
  const pct = ((state.step - 0.5) / STATIONS.length) * 100;
  document.getElementById('dialBand').style.width = `${pct}%`;
  document.getElementById('dialNeedle').style.left = `calc(${pct}% - 1.5px)`;
  document.getElementById('dial').setAttribute('aria-valuenow', String(state.step));
}

function goto(step) {
  state.step = step;
  paintDial(); writeHash();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

function slugLabel() {
  const c = state.project?.customer;
  const num = state.project?.projectNumber;
  document.getElementById('projectSlug').textContent = c
    ? `${num ? num + ' · ' : ''}${c.company || c.customerName} · ${c.projectName}`
    : 'new session';
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

const panel = (eyebrow, title, inner) =>
  `<div class="panel"><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2>${inner}</div>`;

/** Step back a station without losing anything already done. */
const backBar = () => state.step > 1
  ? `<button class="linkbtn" id="stepBack" style="padding-left:0;margin-bottom:10px">&larr; Back to ${esc(STATIONS[state.step - 2].call)}</button>`
  : '';

function wireBack() {
  document.getElementById('stepBack')?.addEventListener('click', () => goto(state.step - 1));
}

const field = (name, label, opts = {}) => `
  <label class="field">
    <span class="lbl">${esc(label)}${opts.required ? ' *' : ''}</span>
    ${opts.textarea
      ? `<textarea name="${name}" placeholder="${esc(opts.placeholder || '')}">${esc(opts.value || '')}</textarea>`
      : `<input type="${opts.type || 'text'}" name="${name}" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}">`}
    ${opts.help ? `<span class="help">${esc(opts.help)}</span>` : ''}
  </label>`;

const radioCard = (group, value, title, sub, checked, badge) => `
  <label class="opt">
    <input type="radio" name="${group}" value="${esc(value)}" ${checked ? 'checked' : ''}>
    <span class="face"><b>${esc(title)}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</span>
    ${badge ? `<span class="pick">${esc(badge)}</span>` : ''}
  </label>`;

const form = (el) => Object.fromEntries(new FormData(el).entries());

/**
 * A few common choices as radio buttons, then one "Other" that reveals a
 * dropdown. Twenty-odd languages or accents as radio buttons is unreadable.
 */
function radioWithOther(group, primary, more, selected) {
  const isOther = selected && !primary.some((o) => o.id === selected);
  return `
    <div class="options">
      ${primary.map((o) => radioCard(group, o.id, o.label, '', selected === o.id)).join('')}
      <label class="opt">
        <input type="radio" name="${group}" value="__other" ${isOther ? 'checked' : ''} data-other="${group}">
        <span class="face"><b>Other…</b><em>choose from the list</em></span>
      </label>
    </div>
    <div class="otherwrap" data-otherwrap="${group}" ${isOther ? '' : 'hidden'}>
      <label class="field" style="margin:12px 0 0">
        <span class="lbl">Choose one</span>
        <select name="${group}_other">
          <option value="">Select…</option>
          ${more.map((o) => `<option value="${esc(o.id)}" ${selected === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </label>
    </div>`;
}

/** Show or hide the dropdown as the radios change, inside one form. */
function wireOther(formEl) {
  formEl.querySelectorAll('[data-other]').forEach((otherInput) => {
    const group = otherInput.dataset.other;
    const wrap = formEl.querySelector(`[data-otherwrap="${CSS.escape(group)}"]`);
    formEl.querySelectorAll(`input[name="${CSS.escape(group)}"]`).forEach((input) => {
      input.addEventListener('change', () => {
        const on = otherInput.checked;
        wrap.hidden = !on;
        if (on) wrap.querySelector('select')?.focus();
      });
    });
  });
}

/** Collapse "__other" + its dropdown back into a single value. */
function resolveOther(values, group) {
  if (values[group] === '__other') values[group] = values[`${group}_other`] || 'any';
  delete values[`${group}_other`];
  return values;
}

const toneLabel = (id) => state.catalog.tones.find((t) => t.id === id)?.label || id;

/** Words-to-clock meter shown under every editable script. */
function meter(script, target) {
  const words = String(script).split(/\s+/).filter(Boolean).length;
  const rate = state.project?.measuredRate || 3.1;
  const secs = Math.round((words / rate) * 10) / 10;
  const pct = Math.min(140, (secs / target) * 100);
  const state_ = secs > target + 0.4 ? 'over' : secs < target - 1.2 ? 'under' : 'ok';
  const note = state_ === 'over' ? `${(secs - target).toFixed(1)}s over`
    : state_ === 'under' ? `${(target - secs).toFixed(1)}s short — add words` : 'on the clock';
  return `<div class="meter ${state_}">
    <div class="bar"><span style="width:${Math.min(100, pct)}%"></span><i style="left:${Math.min(100, (100 / 1.4))}%"></i></div>
    <div class="readout mono">${words} words · ~${secs.toFixed(1)}s of :${target} · ${note}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Station 1 — Setup                                                   */
/* ------------------------------------------------------------------ */

function renderSetup() {
  const s = state.reuse || {};
  const c = s.customer || state.prefill || {};

  stage.innerHTML = `
    ${state.reuse ? `<div class="notice">Starting from <b>${esc(state.reuse.sourceProjectName)}</b>. Everything below is pre-filled — change whatever is different this time.</div>` : ''}

    ${panel('Station 88.1', 'Who are we making this for?', `
      <p class="muted small">Give us the client and the promotion. We'll pull their brand from the web address and read the pages while you choose a tone.</p>
      <form id="setupForm">
        <div class="grid2">
          ${field('customerName', 'Client contact', { required: true, value: c.customerName, placeholder: 'Dana Whitfield' })}
          ${field('email', 'Client email', { required: true, type: 'email', value: c.email, placeholder: 'dana@example.com' })}
          ${field('company', 'Business name', { value: c.company, placeholder: 'Filled in from the website' })}
          ${field('teamMember', 'Smart 1 team member', { required: true, value: c.teamMember, placeholder: 'Your name' })}
          ${field('projectName', 'Project name', { required: true, value: state.reuse ? '' : (c.projectName || ''), placeholder: 'Fall Service Push' })}
          ${field('homeUrl', 'Home page', { required: true, type: 'url', value: c.homeUrl, placeholder: 'https://example.com' })}
        </div>
        ${field('phone', 'Phone number', { value: c.phone, placeholder: '614-536-0768', help: 'Spoken in the spot when the copy needs filling out. Read digit by digit so it lands.' })}
        ${field('landingUrl', 'Landing page for this campaign', { type: 'url', value: c.landingUrl, placeholder: 'https://example.com/fall-offer', help: 'Companion banners are clickable — this is where a tap lands.' })}
        ${field('promotion', 'Promotion details', { textarea: true, placeholder: 'The offer, the dates, anything that has to be said word for word, anything to stay away from.' })}
        ${field('disclaimer', 'Required disclaimer', { textarea: true, value: c.disclaimer, placeholder: 'Offer ends August 31. See dealer for details. APR subject to credit approval.', help: 'Read verbatim in every spot. It eats into the word budget, so the scripts are written shorter to make room.' })}

        <div class="chargroup" style="margin-bottom:6px">
          <div class="grouplabel">Which language should the spot be in?</div>
          ${radioWithOther('language',
            state.catalog.languagesPrimary || [{ id: 'en', label: 'English' }],
            state.catalog.languagesMore || [],
            c.language || 'en')}
          <span class="help">The script is written natively in this language, not translated, and the voice reads it in the same language.</span>
        </div>

        <div class="actions">
          <button type="button" class="btn ghost" id="lookupBrand">Pull brand from the website</button>
          <span class="spacer"></span>
          <button type="submit" class="btn">Start the brief</button>
        </div>
      </form>
      <div id="brandBox"></div>
    `)}

    ${state.reuse ? '' : panel('Shortcut', 'Reuse a previous playlist', `
      <p class="muted small">If this client has been through the studio before, start from those settings — brand, tones, voice, pronunciations and all.</p>
      <label class="field"><span class="lbl">Search by client or project</span><input type="search" id="reuseSearch" placeholder="Client name, business or project"></label>
      <div id="reuseResults" class="small muted">Type to search saved playlists.</div>
    `)}
  `;

  document.getElementById('lookupBrand').addEventListener('click', lookupBrand);
  document.getElementById('setupForm').addEventListener('submit', submitSetup);
  wireOther(document.getElementById('setupForm'));

  const search = document.getElementById('reuseSearch');
  if (search) {
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => searchReuse(search.value), 320); });
  }
}

async function lookupBrand() {
  const el = document.getElementById('setupForm');
  const url = form(el).homeUrl;
  const box = document.getElementById('brandBox');
  if (!url) return toast('Add the home page address first.', true);

  showLoader(box, 'default');
  setBusy(true, 'Brand lookup');
  try {
    const { brand } = await api('/brand', { method: 'POST', body: { url } });
    state.brand = brand;
    if (brand.name && !el.company.value) el.company.value = brand.name;
    paintBrand(box, brand);
  } catch (err) {
    box.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally { setBusy(false); stopLoader(); }
}

function paintBrand(box, brand) {
  const hasLogo = Boolean(brand?.logo);
  box.innerHTML = `
    ${brand?.found === false ? `<div class="notice warn">Brandfetch has no record for ${esc(brand.domain)}. Fill the business name in by hand and upload a logo below.</div>` : ''}
    ${hasLogo || brand?.found ? `
      <div class="rowcard" style="margin-top:14px">
        ${hasLogo ? `<img class="thumb" src="${esc(brand.logo)}" alt="${esc(brand.name)} logo" style="background:#fff;padding:8px">` : ''}
        <div>
          <h3>${esc(brand.name || brand.domain)}</h3>
          <p class="small muted">${esc((brand.description || '').slice(0, 220))}</p>
          <div class="tags">
            ${brand.industry ? `<span class="tag">${esc(brand.industry)}</span>` : ''}
            ${brand.location ? `<span class="tag">${esc(brand.location)}</span>` : ''}
            ${(brand.colors || []).slice(0, 4).map((c) => `<span class="tag" style="border-color:${esc(c.hex)};color:${esc(c.hex)}">${esc(c.hex)}</span>`).join('')}
          </div>
        </div>
      </div>` : ''}
    ${hasLogo ? '' : `
      <div class="notice warn" style="margin-top:12px">
        No logo found. Companion banners need one — upload a PNG, JPG or SVG.
        <div style="margin-top:10px"><input type="file" id="logoFile" accept="image/png,image/jpeg,image/svg+xml"></div>
      </div>`}
  `;
  const file = document.getElementById('logoFile');
  if (file) file.addEventListener('change', () => stageLogo(file.files[0]));
}

/** Held in memory until the project exists, then uploaded. */
function stageLogo(file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) return toast('That logo is over 3 MB. Try a smaller file.', true);
  const reader = new FileReader();
  reader.onload = () => {
    state.pendingLogo = reader.result;
    state.brand = { ...(state.brand || { found: false, colors: [] }), logo: reader.result };
    toast(`${file.name} ready — it uploads with the project.`);
  };
  reader.readAsDataURL(file);
}

async function searchReuse(q) {
  const box = document.getElementById('reuseResults');
  if (!q.trim()) return (box.innerHTML = 'Type to search saved playlists.');
  try {
    const { results } = await api(`/library?q=${encodeURIComponent(q)}`);
    if (!results.length) return (box.innerHTML = 'Nothing saved under that name yet.');
    box.innerHTML = results.slice(0, 6).map((r) => `
      <div class="rowcard" style="margin-top:8px">
        <div style="flex:1">
          <h3>${esc(r.company || r.customerName)}</h3>
          <div class="small muted">${esc(r.projectName)} · ${r.spotCount} spot${r.spotCount === 1 ? '' : 's'} · ${new Date(r.createdAt).toLocaleDateString()}</div>
        </div>
        <button class="btn ghost sm" data-reuse="${esc(r.projectId)}">Use these settings</button>
      </div>`).join('');
    box.querySelectorAll('[data-reuse]').forEach((b) => b.addEventListener('click', () => applyReuse(b.dataset.reuse)));
  } catch (err) {
    box.innerHTML = `<span class="mono" style="color:var(--peak)">${esc(err.message)}</span>`;
  }
}

async function applyReuse(projectId) {
  try {
    const { settings } = await api(`/library/${projectId}/settings`);
    state.reuse = settings;
    state.brand = settings.brand;
    render();
    toast(`Loaded settings from ${settings.sourceProjectName}.`);
  } catch (err) { toast(err.message, true); }
}

async function submitSetup(ev) {
  ev.preventDefault();
  const customer = resolveOther(form(ev.target), 'language');
  if (!customer.language || customer.language === 'any') customer.language = 'en';
  setBusy(true, 'Opening project');
  try {
    if (!state.brand && customer.homeUrl) {
      state.brand = await api('/brand', { method: 'POST', body: { url: customer.homeUrl } }).then((d) => d.brand).catch(() => null);
    }
    const { project } = await api('/projects', {
      method: 'POST',
      body: {
        customer, brand: state.brand,
        pronunciations: state.reuse?.pronunciations || [],
        reusedFrom: state.reuse?.sourceProjectId || null
      }
    });
    state.projectId = project.projectId;
    state.project = project;
    slugLabel(); writeHash();

    if (state.pendingLogo) {
      await api(`/projects/${project.projectId}/logo`, { method: 'POST', body: { dataUrl: state.pendingLogo } })
        .then((r) => { state.project = r.project; state.brand = r.project.brand; })
        .catch((err) => toast(`The logo didn't upload: ${err.message}`, true));
      state.pendingLogo = null;
    }

    const { jobId } = await api(`/projects/${project.projectId}/analyze`, { method: 'POST' });
    state.analysisJobId = jobId;
    goto(2);
  } catch (err) { toast(err.message, true); }
  finally { setBusy(false); }
}

/* ------------------------------------------------------------------ */
/* Station 2 — Brief and tone                                          */
/* ------------------------------------------------------------------ */

function renderBrief() {
  const done = state.project?.tones || [];
  const proven = new Set(state.catalog.provenTones || []);

  stage.innerHTML = `
    ${panel('Station 91.3', 'How should this one sound?', `
      <div id="briefBox"></div>
      <form id="toneForm">
        <div class="options" id="toneOptions">
          ${state.catalog.tones.map((t) =>
            radioCard('tone', t.id, t.label, t.blurb, t.id === state.currentTone, proven.has(t.id) ? 'Proven' : '')).join('')}
        </div>
        <div class="actions">
          ${done.length ? '<button type="button" class="btn ghost" id="backToCopy">Back to the scripts</button>' : ''}
          <span class="spacer"></span>
          <button type="submit" class="btn">Write the :15 and :30</button>
        </div>
      </form>
    `)}
    ${done.length ? `<div class="notice">Already written: ${done.map((t) => esc(toneLabel(t))).join(', ')}. Pick a different tone to add another spot.</div>` : ''}
  `;

  document.getElementById('toneForm').addEventListener('submit', submitTone);
  document.getElementById('backToCopy')?.addEventListener('click', () => goto(3));

  if (state.analysis) paintBrief(); else waitForAnalysis();
}

async function waitForAnalysis() {
  const box = document.getElementById('briefBox');
  if (!state.analysisJobId) {
    if (state.project?.analysis) { state.analysis = state.project.analysis; return paintBrief(); }
    return (box.innerHTML = '');
  }
  try {
    state.analysis = await withLoader(box, 'analyze', state.analysisJobId);
    state.analysisJobId = null;
    paintBrief();
  } catch (err) {
    box.innerHTML = `<div class="notice bad">The site review didn't finish: ${esc(err.message)} You can still choose a tone and write from the promotion details.</div>`;
  }
}

function paintBrief() {
  const a = state.analysis;
  const box = document.getElementById('briefBox');
  const recs = a.recommendedTones || [];

  box.innerHTML = `
    <div class="sheet" style="margin-bottom:16px">
      <div class="slug"><span class="timecode alt">Brief</span><span class="tag">${esc(a.offer || 'No offer supplied')}</span></div>
      <p class="small">${esc(a.summary || '')}</p>
      <p class="small muted"><b>Listener:</b> ${esc(a.audience || '')}</p>
      <p class="small muted"><b>Call to action:</b> ${esc(a.callToAction || '')}</p>
      ${(a.differentiators || []).length ? `<div class="tags">${a.differentiators.slice(0, 5).map((d) => `<span class="tag">${esc(d)}</span>`).join('')}</div>` : ''}
      ${a.sources?.home?.ok === false ? '<div class="direction">Couldn\'t read the home page — writing from the promotion details instead.</div>' : ''}
    </div>
    ${recs.length ? `<p class="small muted">We'd start with one of these three, marked below: ${recs.map((r) => `<b>${esc(toneLabel(r.toneId))}</b>`).join(', ')}.</p>` : ''}
  `;

  recs.forEach((r, i) => {
    const input = document.querySelector(`#toneOptions input[value="${CSS.escape(r.toneId)}"]`);
    if (!input) return;
    const card = input.closest('.opt');
    const existing = card.querySelector('.pick');
    const label = i === 0 ? 'Top pick' : 'Suggested';
    if (existing) existing.textContent = `${label} · ${existing.textContent}`;
    else {
      const tag = document.createElement('span');
      tag.className = 'pick'; tag.textContent = label; tag.title = r.why || '';
      card.appendChild(tag);
    }
    if (i === 0 && !document.querySelector('#toneOptions input:checked')) input.checked = true;
  });
}

async function submitTone(ev) {
  ev.preventDefault();
  const toneId = form(ev.target).tone;
  if (!toneId) return toast('Pick a tone first.', true);
  state.currentTone = toneId;

  const tones = [...new Set([...(state.project.tones || []), toneId])];
  setBusy(true, 'Setting up');
  try {
    const res = await api(`/projects/${state.projectId}/tones`, { method: 'POST', body: { tones } });
    state.project = res.project;
    state.voiceProfileJobId = res.voiceProfileJobId;
    const { jobId } = await api(`/projects/${state.projectId}/scripts`, { method: 'POST', body: { toneId } });
    state.scriptsJobId = jobId;
    goto(3);
  } catch (err) { toast(err.message, true); }
  finally { setBusy(false); }
}

/* ------------------------------------------------------------------ */
/* Station 3 — Copy                                                    */
/* ------------------------------------------------------------------ */

async function renderCopy() {
  stage.innerHTML = panel('Station 94.7', `${toneLabel(state.currentTone)} — the scripts`, '<div id="copyBox"></div>');
  const box = document.getElementById('copyBox');

  if (state.scriptsJobId) {
    try {
      await withLoader(box, 'scripts', state.scriptsJobId);
      state.scriptsJobId = null;
      await refreshProject();
    } catch (err) {
      box.innerHTML = `<div class="notice bad">${esc(err.message)}</div>
        <div class="actions"><button class="btn ghost" id="retryScripts">Try again</button></div>`;
      document.getElementById('retryScripts')?.addEventListener('click', () => goto(2));
      return;
    }
  }
  paintCopy();
}

const spotsForTone = (toneId) =>
  (state.project.commercials || []).filter((c) => c.toneId === toneId && c.status !== 'rejected').sort((a, b) => a.seconds - b.seconds);

function paintCopy() {
  const box = document.getElementById('copyBox');
  const spots = spotsForTone(state.currentTone);
  if (!spots.length) return (box.innerHTML = '<div class="notice warn">No scripts on file for this tone yet.</div>');

  const allApproved = spots.every((s) => s.status === 'approved');

  box.innerHTML = `
    <p class="muted small">Read them out loud — radio is heard, not read. Edit the words directly, ask for a rewrite, or approve.</p>
    ${spots.map((s) => `
      <div class="sheet" style="margin-bottom:14px" data-spot="${esc(s.id)}">
        <div class="slug">
          <span class="timecode${s.seconds === 30 ? ' alt' : ''}">:${s.seconds}</span>
          ${s.status === 'approved' ? '<span class="tag good">Approved</span>' : ''}
          ${s.edited ? '<span class="tag">Edited by hand</span>' : ''}
          ${(s.revisions || []).length ? `<span class="tag">Revision ${s.revisions.length}</span>` : ''}
          <span class="spacer"></span>
          <button class="linkbtn" data-hear="${esc(s.id)}">How it will be read</button>
          <button class="linkbtn" data-history="${esc(s.pairId)}">Version history</button>
        </div>

        <div data-view="${esc(s.id)}">
          <div class="copy">${esc(s.script)}</div>
          ${meter(s.script, s.seconds)}
          ${s.notes ? `<div class="direction">Direction: ${esc(s.notes)}</div>` : ''}
          <div class="actions">
            ${s.status === 'approved' ? '' : `<button class="btn sm" data-approve="${esc(s.id)}">Approve</button>`}
            <button class="btn ghost sm" data-edit="${esc(s.id)}">Edit words</button>
            <button class="btn ghost sm" data-revise="${esc(s.id)}">Ask for a rewrite</button>
            ${s.status === 'approved' ? '' : `<button class="btn danger sm" data-reject="${esc(s.id)}">Not this one</button>`}
          </div>
        </div>
        <div data-panel="${esc(s.id)}"></div>
      </div>`).join('')}

    ${allApproved ? `
      <div class="panel flat" style="margin-top:16px">
        <div class="eyebrow">Before we roll</div>
        <h3>Is this everything you want to record?</h3>
        <p class="small muted">${(state.project.commercials || []).filter((c) => c.status === 'approved').length} approved spot(s). Casting them all at once keeps the voice consistent.</p>
        <div class="actions">
          <button class="btn ghost" id="addAnother">No — add another tone</button>
          <span class="spacer"></span>
          <button class="btn" id="toStudio">Yes, take me to the studio</button>
        </div>
      </div>` : ''}
  `;

  box.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.approve, 'approve')));
  box.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.reject, 'reject')));
  box.querySelectorAll('[data-revise]').forEach((b) => b.addEventListener('click', () => askRevision(b.dataset.revise)));
  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editInline(b.dataset.edit)));
  box.querySelectorAll('[data-hear]').forEach((b) => b.addEventListener('click', () => speechPreview(b.dataset.hear)));
  box.querySelectorAll('[data-history]').forEach((b) => b.addEventListener('click', () => showHistory(b.dataset.history)));
  document.getElementById('addAnother')?.addEventListener('click', () => goto(2));
  document.getElementById('toStudio')?.addEventListener('click', () => goto(4));
}

async function decide(spotId, decision) {
  setBusy(true, decision === 'approve' ? 'Approving' : 'Updating');
  try {
    const res = await api(`/projects/${state.projectId}/commercials/${spotId}/decision`, { method: 'POST', body: { decision } });
    state.project = res.project;
    paintCopy();
  } catch (err) { toast(err.message, true); }
  finally { setBusy(false); }
}

/** Type straight into the script, with the clock updating as you go. */
function editInline(spotId) {
  const spot = state.project.commercials.find((c) => c.id === spotId);
  const view = stage.querySelector(`[data-view="${CSS.escape(spotId)}"]`);
  view.innerHTML = `
    <form data-editform>
      <textarea name="script" class="scriptedit" spellcheck="true">${esc(spot.script)}</textarea>
      <div data-livemeter>${meter(spot.script, spot.seconds)}</div>
      <div class="actions">
        <button class="btn sm" type="submit">Save the words</button>
        <button class="btn ghost sm" type="button" data-canceledit>Cancel</button>
        <span class="spacer"></span>
        <span class="small muted">Saving clears the recorded take — it no longer matches.</span>
      </div>
    </form>`;

  const area = view.querySelector('textarea');
  const live = view.querySelector('[data-livemeter]');
  area.focus();
  area.addEventListener('input', () => { live.innerHTML = meter(area.value, spot.seconds); });
  view.querySelector('[data-canceledit]').addEventListener('click', paintCopy);
  view.querySelector('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setBusy(true, 'Saving');
    try {
      const res = await api(`/projects/${state.projectId}/commercials/${spotId}`, { method: 'PATCH', body: { script: area.value } });
      state.project = res.project;
      paintCopy();
      toast('Saved.');
    } catch (err) { toast(err.message, true); }
    finally { setBusy(false); }
  });
}

async function speechPreview(spotId) {
  const holder = stage.querySelector(`[data-panel="${CSS.escape(spotId)}"]`);
  if (holder.dataset.open === 'speech') { holder.innerHTML = ''; holder.dataset.open = ''; return; }
  holder.dataset.open = 'speech';
  holder.innerHTML = '<p class="small muted mono">Working out the read…</p>';
  try {
    const { preview } = await api(`/projects/${state.projectId}/commercials/${spotId}/speech-preview`, { method: 'POST', body: {} });
    holder.innerHTML = `
      <div class="subpanel">
        <div class="eyebrow">Spoken form</div>
        <p class="small">${esc(preview.spoken)}</p>
        ${preview.changes.length ? `
          <table class="data" style="margin-top:10px">
            <tr><th>Written</th><th>Read as</th><th>Why</th></tr>
            ${preview.changes.map((c) => `<tr><td class="mono small">${esc(c.from)}</td><td class="small">${esc(c.to)}</td><td class="small muted">${esc(c.why)}</td></tr>`).join('')}
          </table>` : '<p class="small muted">Nothing needed changing — it reads as written.</p>'}
        <form data-pronform style="margin-top:12px">
          <div class="grid2">
            <label class="field"><span class="lbl">Say this word</span><input type="text" name="from" placeholder="Reynoldsburg"></label>
            <label class="field"><span class="lbl">Like this</span><input type="text" name="to" placeholder="RAY nolds burg"></label>
          </div>
          <button class="btn ghost sm" type="submit">Add pronunciation</button>
        </form>
        ${(state.project.pronunciations || []).length ? `<div class="tags" style="margin-top:8px">${state.project.pronunciations.map((p) => `<span class="tag good">${esc(p.from)} → ${esc(p.to)}</span>`).join('')}</div>` : ''}
      </div>`;
    holder.querySelector('[data-pronform]').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const entry = form(ev.target);
      if (!entry.from || !entry.to) return;
      const list = [...(state.project.pronunciations || []), entry];
      await api(`/projects/${state.projectId}/pronunciations`, { method: 'POST', body: { pronunciations: list } });
      await refreshProject();
      holder.dataset.open = '';
      speechPreview(spotId);
    });
  } catch (err) {
    holder.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

async function showHistory(pairId) {
  const spot = state.project.commercials.find((c) => c.pairId === pairId);
  const holder = stage.querySelector(`[data-panel="${CSS.escape(spot.id)}"]`);
  if (holder.dataset.open === 'history') { holder.innerHTML = ''; holder.dataset.open = ''; return; }
  holder.dataset.open = 'history';
  try {
    const { drafts } = await api(`/projects/${state.projectId}/drafts?pairId=${encodeURIComponent(pairId)}`);
    holder.innerHTML = `
      <div class="subpanel">
        <div class="eyebrow">Every version</div>
        ${drafts.length <= 1 ? '<p class="small muted">Only the first draft so far.</p>' : ''}
        ${drafts.map((d, i) => `
          <div class="rowcard" style="margin-top:8px">
            <div style="flex:1">
              <div class="small mono muted">${new Date(d.at).toLocaleString()}${d.note ? ` · ${esc(d.note)}` : ''}</div>
              ${d.spots.map((s) => `<p class="small" style="margin:6px 0 0"><span class="timecode${s.seconds === 30 ? ' alt' : ''}">:${s.seconds}</span> ${esc(s.script.slice(0, 150))}${s.script.length > 150 ? '…' : ''}</p>`).join('')}
            </div>
            ${i === 0 ? '<span class="tag good">Current</span>' : `<button class="btn ghost sm" data-restore="${esc(d.draftId)}">Restore</button>`}
          </div>`).join('')}
      </div>`;
    holder.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      const res = await api(`/projects/${state.projectId}/drafts/${b.dataset.restore}/restore`, { method: 'POST' });
      state.project = res.project;
      paintCopy();
      toast('Restored that version.');
    }));
  } catch (err) {
    holder.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

function askRevision(spotId) {
  const holder = stage.querySelector(`[data-panel="${CSS.escape(spotId)}"]`);
  holder.dataset.open = 'revise';
  holder.innerHTML = `
    <form data-revform class="subpanel">
      <label class="field"><span class="lbl">What should change?</span>
        <textarea name="note" placeholder="Lead with the free estimate. Drop the word 'premier'. Say the phone number twice." required></textarea></label>
      <div class="actions">
        <button class="btn sm" type="submit">Rewrite both lengths</button>
        <button class="btn ghost sm" type="button" data-cancel>Cancel</button>
      </div>
    </form>`;
  holder.querySelector('[data-cancel]').addEventListener('click', () => { holder.innerHTML = ''; holder.dataset.open = ''; });
  holder.querySelector('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const note = form(ev.target).note;
    const box = document.getElementById('copyBox');
    try {
      const { jobId } = await api(`/projects/${state.projectId}/commercials/${spotId}/decision`, { method: 'POST', body: { decision: 'revise', note } });
      await withLoader(box, 'revise', jobId);
      await refreshProject();
      paintCopy();
      toast('Rewritten with your note.');
    } catch (err) { toast(err.message, true); paintCopy(); }
  });
}

/* ------------------------------------------------------------------ */
/* Station 4 — Cast                                                    */
/* ------------------------------------------------------------------ */

async function renderCast() {
  const groups = state.catalog.voiceCharacteristics;
  const single = state.project.singleVoice !== false;

  stage.innerHTML = panel('Station 98.5', 'Cast the voice', `
    <div id="castSuggestion" class="small muted">Pulling a casting suggestion…</div>

    <div class="subpanel" style="margin-top:16px">
      <label class="switch">
        <input type="checkbox" id="singleVoice" ${single ? 'checked' : ''}>
        <span>Use one voice across the whole campaign</span>
      </label>
      <p class="small muted" style="margin:6px 0 0">Recommended. Different voices across spots hurts brand recall — turn this off only if a spot is deliberately a different character.</p>
    </div>

    <div class="subpanel" style="margin-top:12px">
      <div class="eyebrow">Music bed</div>
      <div id="bedBox" class="small muted">Loading beds…</div>
    </div>

    <form id="castForm" style="margin-top:18px">
      ${groups.map((g) => `
        <div class="chargroup">
          <div class="grouplabel">${esc(g.label)}</div>
          ${g.more && g.more.length
            ? radioWithOther(g.id, g.options, g.more, state.project.voiceCharacteristics?.[g.id] || g.options[0].id)
            : `<div class="options">${g.options.map((o, i) => radioCard(g.id, o.id, o.label, '', i === 0)).join('')}</div>`}
        </div>`).join('')}
      <div class="actions"><button type="submit" class="btn">Find three voices</button></div>
    </form>

    <details style="margin-top:8px">
      <summary class="small muted" style="cursor:pointer">Already know the voice? Add an ElevenLabs voice ID</summary>
      <form id="customVoiceForm" style="margin-top:10px">
        <label class="field"><span class="lbl">ElevenLabs voice ID</span><input type="text" name="voiceId" placeholder="21m00Tcm4TlvDq8ikWAM"></label>
        <button class="btn ghost sm" type="submit">Add this voice</button>
      </form>
    </details>
    <div id="voiceBox"></div>
  `);

  document.getElementById('castForm').addEventListener('submit', findVoices);
  wireOther(document.getElementById('castForm'));
  document.getElementById('customVoiceForm').addEventListener('submit', addCustomVoice);
  document.getElementById('singleVoice').addEventListener('change', async (ev) => {
    await api(`/projects/${state.projectId}/settings`, { method: 'POST', body: { singleVoice: ev.target.checked } });
    await refreshProject();
    if (state.voices.length) paintVoicePicker();
  });

  loadVoiceProfile();
  loadBeds();
}

async function loadBeds() {
  const box = document.getElementById('bedBox');
  try {
    const { beds, note } = await api('/beds');
    state.beds = beds;
    state.bedNote = note || null;
    // Nothing in the library yet? Land on Compose rather than an empty list.
    if (!state.bedTab) state.bedTab = 'generate';
    paintBeds();
  } catch (err) {
    box.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
  }
}

function paintBeds() {
  const box = document.getElementById('bedBox');
  const chosen = state.project.musicBed?.publicId || '';
  const tab = state.bedTab || 'library';

  box.innerHTML = `
    <p class="small muted">The bed sits under the read and ducks out of its way. Everything is mastered to broadcast loudness afterward.</p>

    <div class="tabrow">
      <button class="tabbtn ${tab === 'generate' ? 'on' : ''}" data-bedtab="generate">Compose one</button>
      <button class="tabbtn ${tab === 'upload' ? 'on' : ''}" data-bedtab="upload">Upload a track</button>
      <button class="tabbtn ${tab === 'library' ? 'on' : ''}" data-bedtab="library">Library${state.beds.length ? ` (${state.beds.length})` : ''}</button>
    </div>

    <div id="bedPanel"></div>
  `;

  box.querySelectorAll('[data-bedtab]').forEach((b) => b.addEventListener('click', () => {
    state.bedTab = b.dataset.bedtab;
    paintBeds();
  }));

  const panel_ = document.getElementById('bedPanel');
  if (tab === 'library') paintBedLibrary(panel_, chosen);
  if (tab === 'generate') paintBedGenerate(panel_);
  if (tab === 'upload') paintBedUpload(panel_);
}

function paintBedLibrary(panel_, chosen) {
  if (!state.beds.length) {
    panel_.innerHTML = `<div class="notice warn">${esc(state.bedNote || 'Nothing in the bed library yet.')}
      A dry voice read sounds thin next to produced commercials — compose one on the next tab, or upload a track you have the rights to.</div>`;
    return;
  }
  panel_.innerHTML = `
    <div class="options">
      ${radioCard('bed', '', 'No music', 'Dry voice only', !chosen)}
      ${state.beds.map((b) => radioCard('bed', b.publicId, b.name,
        [b.project || '', b.createdAt ? new Date(b.createdAt).toLocaleDateString() : '', b.seconds ? `${Math.round(b.seconds)}s` : '']
          .filter(Boolean).join(' · '),
        chosen === b.publicId)).join('')}
    </div>
    <div id="bedPreview"></div>`;

  panel_.querySelectorAll('input[name=bed]').forEach((input) => input.addEventListener('change', () => chooseBed(input.value)));
}

async function chooseBed(publicId) {
  const bed = state.beds.find((b) => b.publicId === publicId) || null;
  await api(`/projects/${state.projectId}/settings`, { method: 'POST', body: { musicBed: bed } });
  await refreshProject();
  const preview = document.getElementById('bedPreview');
  if (preview) {
    preview.innerHTML = bed
      ? `<audio controls preload="none" src="${esc(bed.url)}"></audio>${bed.prompt ? `<p class="small muted mono" style="margin-top:6px">${esc(bed.prompt)}</p>` : ''}`
      : '';
  }
  toast(bed ? `Bed set to ${bed.name}.` : 'Recording dry, no music.');
}

/** Compose a bed with Eleven Music, seeded by a prompt the model writes. */
function paintBedGenerate(panel_) {
  panel_.innerHTML = `
    <p class="small muted">Eleven Music writes an instrumental bed to order. It comes back vocal-free with the midrange left open, so the read sits on top of it rather than under it.</p>
    <div id="bedSuggestion" class="small muted mono">Thinking about what would suit this spot…</div>
    <form id="bedGenForm" style="margin-top:12px">
      <label class="field"><span class="lbl">Describe the music</span>
        <textarea name="prompt" placeholder="Warm acoustic guitar and light percussion, 90 BPM, optimistic and unhurried, no vocals." required></textarea></label>
      <div class="grid2">
        <label class="field"><span class="lbl">Name it</span><input type="text" name="name" placeholder="Warm acoustic 90"></label>
        <label class="field"><span class="lbl">Length</span>
          <select name="seconds">
            <option value="20">20 seconds</option>
            <option value="35" selected>35 seconds — covers a :30</option>
            <option value="60">60 seconds</option>
          </select></label>
      </div>
      <div class="actions"><button class="btn" type="submit">Compose the bed</button></div>
    </form>
    <div id="bedGenResult"></div>`;

  document.getElementById('bedGenForm').addEventListener('submit', composeBed);
  suggestBedPrompt();
}

async function suggestBedPrompt() {
  const box = document.getElementById('bedSuggestion');
  try {
    const { jobId } = await api(`/projects/${state.projectId}/bed-prompt`, {
      method: 'POST', body: { toneId: state.currentTone }
    });
    const s = await awaitJob(jobId);
    if (!document.getElementById('bedSuggestion')) return;
    const field = document.querySelector('#bedGenForm textarea[name=prompt]');
    if (field && !field.value) field.value = s.prompt || '';
    box.innerHTML = `<div class="notice">${esc(s.why || '')}
      ${(s.alternates || []).length ? `<div class="tags" style="margin-top:8px">${s.alternates.map((a) => `<button type="button" class="tag" data-alt="${esc(a)}">${esc(a)}</button>`).join('')}</div>` : ''}
    </div>`;
    box.querySelectorAll('[data-alt]').forEach((b) => b.addEventListener('click', () => {
      document.querySelector('#bedGenForm textarea[name=prompt]').value = b.dataset.alt;
    }));
  } catch {
    if (box) box.innerHTML = '';
  }
}

async function composeBed(ev) {
  ev.preventDefault();
  const body = form(ev.target);
  const out = document.getElementById('bedGenResult');
  try {
    body.project = state.project.customer.projectName;
    const { jobId } = await api('/beds/generate', { method: 'POST', body });
    const bed = await withLoader(out, 'compose-bed', jobId);
    state.beds = [bed, ...state.beds];
    out.innerHTML = `
      <div class="rowcard" style="margin-top:12px">
        <div style="flex:1">
          <h3>${esc(bed.name)}</h3>
          <p class="small muted">${esc(state.project.customer.projectName)} · ${new Date().toLocaleDateString()}</p>
          <audio controls preload="auto" src="${esc(bed.url)}"></audio>
          <div class="actions">
            <button class="btn sm" id="useBed">Use this bed</button>
            <button class="btn ghost sm" id="againBed">Compose another</button>
          </div>
        </div>
      </div>`;
    document.getElementById('useBed').addEventListener('click', async () => {
      await chooseBed(bed.publicId);
      state.bedTab = 'library';
      paintBeds();
    });
    document.getElementById('againBed').addEventListener('click', () => { out.innerHTML = ''; });
  } catch (err) {
    out.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

/** Upload a track the agency already licensed. */
function paintBedUpload(panel_) {
  panel_.innerHTML = `
    <p class="small muted">MP3, WAV, M4A or OGG, up to 20 MB. Only upload music you hold the rights to — this goes out in a commercial.</p>
    <form id="bedUpForm">
      <label class="field"><span class="lbl">Name it</span><input type="text" name="name" placeholder="Client-supplied theme"></label>
      <label class="field"><span class="lbl">Audio file</span><input type="file" id="bedFile" accept="audio/*"></label>
      <div class="actions"><button class="btn" type="submit" id="bedUpBtn" disabled>Add to the library</button></div>
    </form>
    <div id="bedUpResult"></div>`;

  const file = document.getElementById('bedFile');
  const btn = document.getElementById('bedUpBtn');
  file.addEventListener('change', () => { btn.disabled = !file.files[0]; });
  document.getElementById('bedUpForm').addEventListener('submit', uploadBed);
}

async function uploadBed(ev) {
  ev.preventDefault();
  const file = document.getElementById('bedFile').files[0];
  const out = document.getElementById('bedUpResult');
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return toast('That file is over 20 MB.', true);

  const name = form(ev.target).name || file.name.replace(/\.[^.]+$/, '');
  out.innerHTML = '<p class="small muted mono">Uploading…</p>';
  setBusy(true, 'Uploading bed');
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read that file.'));
      r.readAsDataURL(file);
    });
    const { bed } = await api('/beds/upload', { method: 'POST', body: { dataUrl, name, project: state.project.customer.projectName } });
    state.beds = [bed, ...state.beds];
    out.innerHTML = `
      <div class="rowcard" style="margin-top:12px">
        <div style="flex:1">
          <h3>${esc(bed.name)}</h3>
          <p class="small muted">${esc(state.project.customer.projectName)} · ${new Date().toLocaleDateString()}</p>
          <audio controls preload="none" src="${esc(bed.url)}"></audio>
          <div class="actions"><button class="btn sm" id="useUploaded">Use this bed</button></div>
        </div>
      </div>`;
    document.getElementById('useUploaded').addEventListener('click', async () => {
      await chooseBed(bed.publicId);
      state.bedTab = 'library';
      paintBeds();
    });
  } catch (err) {
    out.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally { setBusy(false); }
}

function applyProfile(profile, box) {
  Object.entries(profile.recommendation || {}).forEach(([group, value]) => {
    const input = document.querySelector(`#castForm input[name="${CSS.escape(group)}"][value="${CSS.escape(value)}"]`);
    if (input) { input.checked = true; return; }
    // Not one of the radio buttons — try the "Other" dropdown for this group.
    const select = document.querySelector(`#castForm select[name="${CSS.escape(group)}_other"]`);
    const option = select && [...select.options].find((o) => o.value === value);
    if (option) {
      select.value = value;
      const other = document.querySelector(`#castForm input[name="${CSS.escape(group)}"][value="__other"]`);
      if (other) { other.checked = true; }
      const wrap = document.querySelector(`#castForm [data-otherwrap="${CSS.escape(group)}"]`);
      if (wrap) wrap.hidden = false;
    }
  });
  box.innerHTML = `<div class="notice">Suggested casting is pre-selected below. ${esc(profile.why || '')}</div>`;
}

async function loadVoiceProfile() {
  const box = document.getElementById('castSuggestion');
  const saved = state.voiceProfile || state.project?.voiceProfile;
  if (saved) return applyProfile(saved, box);
  if (!state.voiceProfileJobId) return (box.innerHTML = '');
  try {
    const profile = await awaitJob(state.voiceProfileJobId);
    state.voiceProfile = profile;
    state.voiceProfileJobId = null;
    applyProfile(profile, box);
  } catch { box.innerHTML = ''; }
}

async function findVoices(ev) {
  ev.preventDefault();
  const characteristics = resolveOther(form(ev.target), 'accent');
  const box = document.getElementById('voiceBox');
  showLoader(box, 'voices');
  setBusy(true, 'Auditioning');
  try {
    const { voices } = await api(`/projects/${state.projectId}/voices`, { method: 'POST', body: { characteristics } });
    state.voices = voices;
    await refreshProject();
    paintVoicePicker();
  } catch (err) {
    box.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally { setBusy(false); stopLoader(); }
}

async function addCustomVoice(ev) {
  ev.preventDefault();
  const { voiceId } = form(ev.target);
  if (!voiceId) return;
  try {
    const { voice } = await api(`/projects/${state.projectId}/voices/custom`, { method: 'POST', body: { voiceId } });
    state.voices = [voice, ...state.voices.filter((v) => v.voiceId !== voice.voiceId)].slice(0, 4);
    paintVoicePicker();
    toast(`Added ${voice.name}.`);
  } catch (err) { toast(err.message, true); }
}

const approvedSpots = () =>
  (state.project.commercials || []).filter((c) => c.status === 'approved')
    .sort((a, b) => (a.toneId === b.toneId ? a.seconds - b.seconds : a.toneId.localeCompare(b.toneId)));

function paintVoicePicker() {
  const box = document.getElementById('voiceBox');
  const spots = approvedSpots();
  const single = state.project.singleVoice !== false;

  box.innerHTML = `
    <h3 style="margin-top:22px">Three takes on that voice</h3>
    <p class="small muted">Play each one, then ${single ? 'pick the voice for the campaign.' : 'set a voice for every spot.'}</p>
    ${state.voices.map((v) => `
      <div class="rowcard">
        <div style="flex:1">
          <h3>${esc(v.name)} ${v.custom ? '<span class="tag">by ID</span>' : ''} ${v.provenCount ? `<span class="tag good">Shipped ${v.provenCount}×</span>` : ''}</h3>
          <div class="tags" style="margin:6px 0">
            ${[v.gender, v.age, v.accent, v.descriptor, v.useCase].filter(Boolean).map((x) => `<span class="tag">${esc(String(x).replace(/_/g, ' '))}</span>`).join('')}
          </div>
          ${v.previewUrl ? `<audio controls preload="none" src="${esc(v.previewUrl)}"></audio>` : '<p class="small muted">No preview clip on this voice.</p>'}
        </div>
      </div>`).join('')}

    <form id="assignForm">
      ${single ? `
        <h3 style="margin-top:26px">Voice for the campaign</h3>
        <div class="options">${state.voices.map((v) => radioCard('campaignVoice', v.voiceId, v.name, [v.gender, v.accent].filter(Boolean).join(' · '), spots[0]?.voiceId === v.voiceId)).join('')}</div>
        <p class="small muted" style="margin-top:8px">All ${spots.length} spot${spots.length === 1 ? '' : 's'} will use it.</p>
      ` : `
        <h3 style="margin-top:26px">Assign a voice to each spot</h3>
        ${spots.map((s) => `
          <div class="panel flat" style="padding:14px">
            <div class="slug" style="margin-bottom:8px">
              <span class="timecode${s.seconds === 30 ? ' alt' : ''}">:${s.seconds}</span>
              <b>${esc(s.toneLabel)}</b>
              ${s.voiceName ? `<span class="tag good">Set: ${esc(s.voiceName)}</span>` : ''}
            </div>
            <div class="options">${state.voices.map((v) => radioCard(`spot_${s.id}`, v.voiceId, v.name, [v.gender, v.accent].filter(Boolean).join(' · '), s.voiceId === v.voiceId)).join('')}</div>
          </div>`).join('')}
      `}
      <div class="actions">
        <button type="button" class="btn ghost" id="recast">Different characteristics</button>
        <span class="spacer"></span>
        <button type="submit" class="btn">Record and send to the listening room</button>
      </div>
    </form>
    <div id="renderBox"></div>
  `;

  document.getElementById('recast').addEventListener('click', () => goto(4));
  document.getElementById('assignForm').addEventListener('submit', recordAll);
}

async function recordAll(ev) {
  ev.preventDefault();
  const picks = form(ev.target);
  const spots = approvedSpots();
  const single = state.project.singleVoice !== false;

  if (single && !picks.campaignVoice) return toast('Pick the campaign voice.', true);
  if (!single) {
    const missing = spots.filter((s) => !picks[`spot_${s.id}`]);
    if (missing.length) return toast(`Still need a voice for ${missing.length} spot${missing.length === 1 ? '' : 's'}.`, true);
  }

  const box = document.getElementById('renderBox');
  showLoader(box, 'render-audio');
  setBusy(true, 'Rendering');
  try {
    const jobIds = [];
    for (const s of spots) {
      const chosen = single ? picks.campaignVoice : picks[`spot_${s.id}`];
      const voice = state.voices.find((v) => v.voiceId === chosen);
      const { jobId } = await api(`/projects/${state.projectId}/commercials/${s.id}/voice`, { method: 'POST', body: { voice } });
      jobIds.push(jobId);
    }
    Promise.allSettled(jobIds.map((j) => awaitJob(j))).then(refreshProject);
    state.boothIndex = 0;
    goto(5);
  } catch (err) {
    box.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally { setBusy(false); stopLoader(); }
}

/* ------------------------------------------------------------------ */
/* Station 5 — Listening room                                          */
/* ------------------------------------------------------------------ */

function renderBooth() {
  const queue = approvedSpots().filter((s) => s.audioStatus !== 'published');
  if (!queue.length) return goto(6);

  const s = queue[Math.min(state.boothIndex, queue.length - 1)];
  const banner = state.project.banners?.[s.toneId];
  const grade = s.durationGrade;
  const stalled = ['stalled', 'needs-rerender'].includes(s.audioStatus);

  stage.innerHTML = panel('Station 101.9', 'Listening room', `
    <p class="muted small">One at a time. Play the spot, look at the companion banner beside it, then approve it or try again. ${queue.length} left to review.</p>

    <div class="sheet">
      <div class="slug">
        <span class="timecode${s.seconds === 30 ? ' alt' : ''}">:${s.seconds}</span>
        <b>${esc(s.toneLabel)}</b>
        <span class="tag">${esc(s.voiceName || 'no voice set')}</span>
        ${s.bedName ? `<span class="tag">${esc(s.bedName)}</span>` : '<span class="tag">dry read</span>'}
        ${s.postProduced ? '<span class="tag good">Mastered</span>' : ''}
      </div>
      <div class="copy" style="font-size:.98rem">${esc(s.script)}</div>

      ${grade ? `<div class="notice ${grade.status === 'good' ? '' : grade.status === 'long' ? 'bad' : 'warn'}" style="margin-top:12px">
        <b>${grade.status === 'good' ? 'Length' : grade.status === 'long' ? 'Runs over' : 'Runs short'}:</b> ${esc(grade.label)}
        ${grade.status === 'long' ? ' Most ad servers reject a spot that overruns its slot.' : ''}
        ${grade.status === 'long' ? `<div class="actions"><button class="btn sm" id="tighten">Cut ${grade.trimWords} word${grade.trimWords === 1 ? '' : 's'} and re-record</button></div>` : ''}
        ${grade.status === 'short' ? `<div class="actions"><button class="btn sm" id="extend">Add ${grade.addWords} words and re-record</button></div>` : ''}
      </div>` : ''}

      ${stalled ? `<div class="notice warn" style="margin-top:12px">
        ${s.audioStatus === 'stalled' ? 'The studio restarted while this was rendering.' : 'The words changed since this was recorded.'}
        <div class="actions"><button class="btn sm" id="rerender">Record it again</button></div>
      </div>` : ''}

      <div id="audioBox">${s.audioUrl
        ? `<audio controls preload="auto" src="${esc(s.audioUrl)}"></audio>`
        : stalled ? '' : '<div class="loader" id="audioLoader"></div>'}</div>

      ${s.bedName ? `
        <div class="subpanel" style="margin-top:14px">
          <div class="grouplabel">Music bed level — ${esc(s.bedName)}</div>
          <div class="options" id="bedLevels">
            ${[[15, 'Low'], [25, 'Default'], [35, 'Strong']].map(([v, label]) =>
              radioCard('bedlevel', String(v), `${label} ${v}%`, '', (state.project.bedPercent ?? 25) === v)).join('')}
            <label class="opt">
              <input type="radio" name="bedlevel" value="custom" ${![15, 25, 35].includes(state.project.bedPercent ?? 25) ? 'checked' : ''}>
              <span class="face"><b>Custom</b><em>set it by hand</em></span>
            </label>
          </div>
          <div id="bedSlider" ${[15, 25, 35].includes(state.project.bedPercent ?? 25) ? 'hidden' : ''} style="margin-top:12px">
            <input type="range" id="bedRange" min="5" max="50" step="1" value="${state.project.bedPercent ?? 25}" style="width:100%;max-width:360px">
            <div class="small muted mono" id="bedReadout">${state.project.bedPercent ?? 25}% of the voice</div>
          </div>
          <div class="actions"><button class="btn sm" id="applyBed">Apply and re-record</button></div>
        </div>` : ''}

      ${(s.speechChanges || []).length ? `<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">${s.speechChanges.length} thing${s.speechChanges.length === 1 ? '' : 's'} were re-spelled for the read</summary>
        <table class="data" style="margin-top:8px"><tr><th>Written</th><th>Read as</th></tr>
        ${s.speechChanges.map((c) => `<tr><td class="mono small">${esc(c.from)}</td><td class="small">${esc(c.to)}</td></tr>`).join('')}</table></details>` : ''}
    </div>

    <h3 style="margin-top:22px">Companion banner</h3>
    <p class="small muted">This runs on the listener's screen while the spot plays, and a tap goes to ${esc(state.project.customer.landingUrl || state.project.customer.homeUrl || 'their site')}.</p>
    <div id="bannerBox">${bannerMarkup(banner)}</div>

    <div class="actions">
      <button class="btn ghost" id="retryVoice">Try a different voice</button>
      <span class="spacer"></span>
      <button class="btn vu" id="approveSpot" ${s.audioUrl ? '' : 'disabled'}>Approve — add to playlist</button>
    </div>
  `);

  document.getElementById('approveSpot').addEventListener('click', () => publishSpot(s.id));
  document.getElementById('retryVoice').addEventListener('click', () => goto(4));
  document.getElementById('tighten')?.addEventListener('click', () => tightenSpot(s.id));
  document.getElementById('extend')?.addEventListener('click', () => extendSpot(s.id));
  document.getElementById('rerender')?.addEventListener('click', () => rerenderSpot(s.id));

  // bed level: presets, custom slider, then re-record with the new mix
  const levels = document.getElementById('bedLevels');
  if (levels) {
    const slider = document.getElementById('bedSlider');
    const range = document.getElementById('bedRange');
    const readout = document.getElementById('bedReadout');
    levels.querySelectorAll('input[name=bedlevel]').forEach((input) => {
      input.addEventListener('change', () => {
        const custom = input.value === 'custom';
        slider.hidden = !custom;
        if (!custom) { range.value = input.value; readout.textContent = `${input.value}% of the voice`; }
      });
    });
    range.addEventListener('input', () => { readout.textContent = `${range.value}% of the voice`; });
    document.getElementById('applyBed').addEventListener('click', async () => {
      const picked = levels.querySelector('input[name=bedlevel]:checked')?.value;
      const pct = picked === 'custom' ? Number(range.value) : Number(picked);
      await api(`/projects/${state.projectId}/settings`, { method: 'POST', body: { bedPercent: pct } });
      await refreshProject();
      toast(`Bed set to ${pct}%. Re-recording.`);
      await rerenderSpot(s.id);
    });
  }

  document.getElementById('rebuildBanner')?.addEventListener('click', async () => {
    const holder = document.getElementById('bannerBox');
    const { jobId } = await api(`/projects/${state.projectId}/banners/${s.toneId}/retry`, { method: 'POST' });
    await withLoader(holder, 'banner', jobId);
    await refreshProject();
    render();
  });

  if (!banner || ['running', 'stalled'].includes(banner.status)) pollBanner(s.toneId);
  if (!s.audioUrl && !stalled) pollAudio(s.id);
}

async function tightenSpot(spotId) {
  const box = document.getElementById('audioBox');
  try {
    const { jobId } = await api(`/projects/${state.projectId}/commercials/${spotId}/tighten`, { method: 'POST', body: {} });
    const result = await withLoader(box, 'tighten', jobId);
    toast(result.whatWentAndWhy || 'Tightened.');
    await rerenderSpot(spotId);
  } catch (err) { toast(err.message, true); }
}

async function extendSpot(spotId) {
  const box = document.getElementById('audioBox');
  try {
    const { jobId } = await api(`/projects/${state.projectId}/commercials/${spotId}/extend`, { method: 'POST', body: {} });
    const result = await withLoader(box, 'extend', jobId);
    toast(result.whatWasAdded || 'Lengthened.');
    await rerenderSpot(spotId);
  } catch (err) { toast(err.message, true); }
}

async function rerenderSpot(spotId) {
  const box = document.getElementById('audioBox');
  try {
    const { jobId } = await api(`/projects/${state.projectId}/commercials/${spotId}/rerender`, { method: 'POST', body: {} });
    await withLoader(box, 'render-audio', jobId);
    await refreshProject();
    render();
  } catch (err) { toast(err.message, true); }
}

function bannerMarkup(banner) {
  if (!banner || banner.status === 'running') return '<div class="loader" id="bannerLoader"></div>';
  if (banner.status === 'stalled') return `<div class="notice warn">The banner was interrupted by a restart. <button class="btn ghost sm" id="retryBanner">Build it again</button></div>`;
  if (!banner.sizes) return '<div class="notice warn">The banner didn\'t come back. You can approve the audio and rebuild the banner later.</div>';
  const noteHtml = banner.note
    ? `<div class="notice warn" style="margin-top:10px">${esc(banner.note)}
         <div class="actions"><button class="btn ghost sm" id="rebuildBanner">Build it again</button></div>
       </div>`
    : '';
  return `
    <div class="rowcard">
      <img class="thumb" style="width:300px" src="${esc(banner.sizes['300x250'])}" alt="Companion banner, 300 by 250">
      <div>
        <h3>${esc(banner.headline || banner.cta || '')}</h3>
        <p class="small muted">${esc(banner.support || banner.offer || '')}</p>
        ${banner.contrast ? `<div class="tags" style="margin-top:8px">
          <span class="tag ${banner.contrast.textOnArtworkPasses ? 'good' : 'hot'}">Headline ${esc(banner.contrast.textOnArtwork)}</span>
          <span class="tag ${banner.contrast.urlBarPasses ? 'good' : 'hot'}">URL bar ${esc(banner.contrast.urlBar)}</span>
          <span class="tag">${esc(banner.contrast.logoPlate)}</span>
        </div>` : ''}
        ${bannerQaMarkup(banner.qa)}
        <div class="tags">
          <a class="tag" href="${esc(banner.sizes['300x250'])}" target="_blank" rel="noopener">300×250</a>
          <a class="tag" href="${esc(banner.sizes['640x640'])}" target="_blank" rel="noopener">640×640</a>
        </div>
      </div>
    </div>${noteHtml}`;
}

/**
 * The ad-builder QA verdict, shown the way the build screen shows it:
 * one verdict chip, then only the findings that need eyes. A clean pass
 * stays quiet — a wall of green teaches people to stop reading.
 */
function bannerQaMarkup(qa) {
  if (!qa) return '';
  const label = qa.verdict === 'pass' ? 'QA: all checks pass'
    : qa.verdict === 'warn' ? 'QA: needs a look' : 'QA: failed';
  const cls = qa.verdict === 'pass' ? 'good' : qa.verdict === 'warn' ? 'warn' : 'hot';
  const issues = (qa.findings || []).filter((f) => f.status !== 'pass');
  const fixes = qa.autoFixes || [];
  const passCount = (qa.findings || []).length - issues.length;
  return `
    <div class="tags" style="margin-top:8px"><span class="tag ${cls}">${esc(label)}</span>
      ${passCount ? `<span class="tag">${passCount} check${passCount === 1 ? '' : 's'} clean</span>` : ''}</div>
    ${issues.length ? `<ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${issues.map((f) => `<li class="${f.status === 'fail' ? 'hot' : 'muted'}"><b>${esc(f.check)}</b> — ${esc(f.detail)}</li>`).join('')}
    </ul>` : ''}
    ${fixes.length ? `<p class="small muted" style="margin:6px 0 0">${fixes.map(esc).join(' ')}</p>` : ''}`;
}

async function pollBanner(toneId) {
  const holder = document.getElementById('bannerBox');
  const retry = document.getElementById('retryBanner');
  if (retry) {
    retry.addEventListener('click', async () => {
      const { jobId } = await api(`/projects/${state.projectId}/banners/${toneId}/retry`, { method: 'POST' });
      await withLoader(holder, 'banner', jobId);
      await refreshProject();
      holder.innerHTML = bannerMarkup(state.project.banners?.[toneId]);
    });
    return;
  }
  if (holder?.querySelector('#bannerLoader')) showLoader(holder, 'banner');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!document.getElementById('bannerBox')) return stopLoader();
    await refreshProject();
    const b = state.project.banners?.[toneId];
    if (b && b.status !== 'running') {
      stopLoader();
      const box = document.getElementById('bannerBox');
      if (box) box.innerHTML = bannerMarkup(b);
      return;
    }
  }
  stopLoader();
}

async function pollAudio(spotId) {
  const holder = document.getElementById('audioLoader');
  if (holder) showLoader(holder.parentElement, 'render-audio');
  for (let i = 0; i < 70; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!document.getElementById('audioBox')) return stopLoader();
    await refreshProject();
    const spot = (state.project.commercials || []).find((c) => c.id === spotId);
    if (spot?.audioUrl) { stopLoader(); return render(); }
    if (spot?.audioStatus === 'stalled') { stopLoader(); return render(); }
  }
  stopLoader();
  const box = document.getElementById('audioBox');
  if (box) box.innerHTML = '<div class="notice bad">The render didn\'t come back. Try recording it again, or check Diagnostics.</div>';
}

async function publishSpot(spotId) {
  setBusy(true, 'Filing');
  try {
    const res = await api(`/projects/${state.projectId}/commercials/${spotId}/publish`, { method: 'POST' });
    state.project = res.project;
    toast('Added to the playlist.');
    state.boothIndex = 0;
    render();
  } catch (err) { toast(err.message, true); }
  finally { setBusy(false); }
}

/* ------------------------------------------------------------------ */
/* Station 6 — Package                                                 */
/* ------------------------------------------------------------------ */

async function renderPackage() {
  stage.innerHTML = panel('Station 105.3', 'The playlist', '<div id="pkgBox"></div>');
  const box = document.getElementById('pkgBox');
  showLoader(box, 'banner');
  setBusy(true, 'Packaging');
  try {
    const res = await api(`/projects/${state.projectId}/finalize`, { method: 'POST' });
    state.project = res.project;
    paintPackage(res.notices || []);
  } catch (err) {
    box.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally { setBusy(false); stopLoader(); }
}

function paintPackage(notices) {
  const p = state.project;
  const c = p.customer;

  document.getElementById('pkgBox').innerHTML = `
    ${notices.map((n) => `<div class="notice warn">${esc(n)}</div>`).join('')}
    <p class="muted small">Everything below is saved in Cloudinary under <span class="mono">${esc(p.cloudinaryFolder || '')}</span> — audio, companion banners and the client's logo, together.</p>

    <table class="data" style="margin:16px 0">
      <tr><th>Client</th><td>${esc(c.company || c.customerName)} — ${esc(c.customerName)}, ${esc(c.email)}</td></tr>
      <tr><th>Project number</th><td class="mono">${esc(p.projectNumber || '')}</td></tr>
      <tr><th>Project</th><td>${esc(c.projectName)}</td></tr>
      <tr><th>Smart 1</th><td>${esc(c.teamMember)}</td></tr>
      <tr><th>Offer</th><td>${esc(p.analysis?.offer || c.promotion || '—')}</td></tr>
      ${c.disclaimer ? `<tr><th>Disclaimer</th><td>${esc(c.disclaimer)}</td></tr>` : ''}
      <tr><th>Banner click</th><td>${esc(c.landingUrl || c.homeUrl)}</td></tr>
      <tr><th>Tones</th><td>${(p.tones || []).map((t) => esc(toneLabel(t))).join(', ')}</td></tr>
      <tr><th>Spots</th><td>${p.playlist.length}</td></tr>
    </table>

    ${p.playlist.map((i) => `
      <div class="rowcard">
        ${i.bannerUrl ? `<img class="thumb" src="${esc(i.bannerUrl)}" alt="Companion banner for ${esc(i.toneLabel)}">` : ''}
        <div style="flex:1">
          <div class="slug" style="margin-bottom:6px">
            <span class="timecode${i.seconds === 30 ? ' alt' : ''}">:${i.seconds}</span>
            <b>${esc(i.toneLabel)}</b>
            <span class="tag">Voice #: ${esc(i.voiceName || '')}${i.voiceId ? ` (${esc(String(i.voiceId).slice(0, 8))})` : ''}</span>
            ${i.bedName ? `<span class="tag">Bed: ${esc(i.bedName)}${i.bedPercent ? ` at ${i.bedPercent}%` : ''}</span>` : '<span class="tag">No bed</span>'}
            ${i.durationGrade ? `<span class="tag ${i.durationGrade.status === 'good' ? 'good' : 'hot'}">${esc(i.durationGrade.label.split('—')[0].trim())}</span>` : ''}
          </div>
          <p class="small">${esc(i.script)}</p>
          <audio controls preload="none" src="${esc(i.audioUrl)}"></audio>
          <div class="tags" style="margin-top:8px">
            <a class="tag" href="${esc(i.audioUrl)}" target="_blank" rel="noopener">MP3</a>
            ${i.bannerSizes ? `<a class="tag" href="${esc(i.bannerSizes['300x250'])}" target="_blank" rel="noopener">Banner 300×250</a>
            <a class="tag" href="${esc(i.bannerSizes['640x640'])}" target="_blank" rel="noopener">Banner 640×640</a>` : ''}
          </div>
        </div>
      </div>`).join('')}

    ${p.opportunitySentAt ? '<div class="notice" style="margin-top:16px">The project was pushed to GoHighLevel as an opportunity.</div>' : ''}

    <div class="actions">
      <button class="btn ghost" id="addMore">Record another spot</button>
      <span class="spacer"></span>
      <button class="btn" id="toSend">Send this playlist for approval</button>
    </div>
  `;

  document.getElementById('addMore').addEventListener('click', () => goto(2));
  document.getElementById('toSend').addEventListener('click', () => goto(7));
}

/* ------------------------------------------------------------------ */
/* Station 7 — Send                                                    */
/* ------------------------------------------------------------------ */

function renderSend() {
  const p = state.project;

  if (p.approvalRequest) {
    const link = p.reviewUrl || `${location.origin}/review.html#${p.projectId}.${p.reviewToken}`;
    const d = p.reviewDecision;
    stage.innerHTML = panel('Station 108.1', 'Sent for approval', `
      <div class="notice">Sent to ${esc(p.approvalRequest.recipientName || '')} at <b>${esc(p.approvalRequest.recipientEmail)}</b> on ${new Date(p.approvalRequest.sentAt).toLocaleString()}.</div>
      ${d ? `<div class="notice ${d.outcome === 'approved' ? '' : 'warn'}" style="margin-top:10px">
        <b>${d.outcome === 'approved' ? 'Approved' : 'Changes requested'}</b> ${new Date(d.decidedAt).toLocaleString()}${d.comments ? ` — “${esc(d.comments)}”` : ''}
      </div>` : '<p class="small muted">Waiting on the reviewer. Their decision lands here and in GoHighLevel.</p>'}
      <label class="field" style="margin-top:14px"><span class="lbl">Review link</span><input type="text" id="reviewLink" value="${esc(link)}" readonly></label>
      <div class="actions">
        <button class="btn ghost" id="copyLink">Copy the link</button>
        <a class="btn ghost" href="/radio/library.html">Open the library</a>
        <span class="spacer"></span>
        <a class="btn" href="/radio/">Start another project</a>
      </div>`);
    document.getElementById('copyLink').addEventListener('click', () => {
      navigator.clipboard?.writeText(link).then(() => toast('Link copied.'), () => toast('Select the field and copy it.', true));
    });
    return;
  }

  stage.innerHTML = panel('Station 108.1', 'Who signs off on this?', `
    <p class="muted small">They get a page with every spot and banner, and Approve / Request changes buttons on it. Their decision comes back here and into GoHighLevel.</p>
    <form id="sendForm">
      <div class="grid2">
        ${field('recipientName', 'Reviewer', { value: p.customer.customerName })}
        ${field('recipientEmail', 'Reviewer email', { required: true, type: 'email', value: p.customer.email })}
      </div>
      ${field('comments', 'Anything they should know', { textarea: true, placeholder: 'Flight starts the 14th. The :15 is the one we want on Pandora.' })}
      <div class="actions">
        <button type="button" class="btn ghost" id="backPkg">Back to the playlist</button>
        <span class="spacer"></span>
        <button type="submit" class="btn">Send for approval</button>
      </div>
    </form>`);

  document.getElementById('backPkg').addEventListener('click', () => goto(6));
  document.getElementById('sendForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setBusy(true, 'Sending');
    try {
      const res = await api(`/projects/${state.projectId}/approval`, { method: 'POST', body: form(ev.target) });
      state.project = res.project;
      render();
    } catch (err) { toast(err.message, true); }
    finally { setBusy(false); }
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function refreshProject() {
  if (!state.projectId) return;
  const { project } = await api(`/projects/${state.projectId}`);
  state.project = project;
  if (project.analysis) state.analysis = project.analysis;
  slugLabel();
  return project;
}

function render() {
  writeHash();
  const painted = paintStation();
  // Every station gets a way back, added after the station has drawn.
  if (state.step > 1 && !document.getElementById('stepBack')) {
    stage.insertAdjacentHTML('afterbegin', backBar());
    wireBack();
  }
  return painted;
}

function paintStation() {
  switch (state.step) {
    case 1: return renderSetup();
    case 2: return renderBrief();
    case 3: return renderCopy();
    case 4: return renderCast();
    case 5: return renderBooth();
    case 6: return renderPackage();
    case 7: return renderSend();
    default: return renderSetup();
  }
}

/**
 * When the studio is framed by the marketing site, a cross-origin iframe
 * cannot size itself. Post our height on every change so the host page can.
 */
function reportHeight() {
  if (window.parent === window) return;
  const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  window.parent.postMessage({ source: 's1-radio-studio', height: h }, '*');
}

(async function boot() {
  paintDial();
  new ResizeObserver(reportHeight).observe(document.body);
  setInterval(reportHeight, 1200);
  await ensureAuth(stage);

  document.getElementById('signOut')?.addEventListener('click', signOut);

  try {
    const catalog = await api('/catalog');
    state.catalog = catalog;
  } catch (err) {
    if (err.needsLogin) {
      // Signed in a moment ago, refused now: the cookie was not stored.
      stage.innerHTML = `
        <div class="panel" style="max-width:520px;margin:60px auto">
          <div class="eyebrow">Session</div>
          <h2>Your browser didn't keep you signed in</h2>
          <p class="small muted">The password was accepted, but the session cookie was discarded. This happens when the studio runs inside a frame on another site, or when third-party cookies are blocked.</p>
          <div class="actions">
            <a class="btn" href="${location.origin}${location.pathname}" target="_blank" rel="noopener">Open the studio in its own tab</a>
            <button class="btn ghost" onclick="location.reload()">Try again</button>
          </div>
        </div>`;
      return;
    }
    stage.innerHTML = `<div class="panel"><div class="notice bad">The studio can't reach its own API: ${esc(err.message)}</div>
      <p class="small muted">Check <a href="/radio/diagnostics.html">Diagnostics</a> for what's not connected.</p></div>`;
    return;
  }

  // Prefill from the Creative Hub: #prefill=<base64url JSON> carrying
  // { company, homeUrl, customerName, email, projectName }. Lighter than a
  // clone — just the setup form filled in, nothing else assumed.
  const prefillMatch = location.hash.match(/prefill=([\w-]+=*)/);
  if (prefillMatch) {
    try {
      const b64 = prefillMatch[1].replace(/-/g, '+').replace(/_/g, '/');
      state.prefill = JSON.parse(decodeURIComponent(escape(atob(b64))));
      history.replaceState(null, '', location.pathname);
      toast('Client details filled in from the Creative Hub.');
    } catch {
      history.replaceState(null, '', location.pathname);
    }
  }

  // Cloning: same client and settings, new project name and promotion.
  const cloneMatch = location.hash.match(/clone=([\w-]+)/);
  if (cloneMatch) {
    try {
      const { settings } = await api(`/library/${cloneMatch[1]}/settings`);
      state.reuse = settings;
      state.brand = settings.brand;
      history.replaceState(null, '', location.pathname);
      state.step = 1;
      paintDial();
      render();
      toast(`Cloned from ${settings.sourceProjectName}. Change the project name and promotion, then go.`);
      return;
    } catch {
      history.replaceState(null, '', location.pathname);
    }
  }

  // Pick a project back up after a refresh, a dropped signal, or a restart.
  const resume = readHash();
  if (resume) {
    try {
      const { project } = await api(`/projects/${resume.projectId}`);
      state.projectId = project.projectId;
      state.project = project;
      state.analysis = project.analysis || null;
      state.voiceProfile = project.voiceProfile || null;
      state.currentTone = resume.tone || project.tones?.[project.tones.length - 1] || null;
      state.step = Math.min(Math.max(resume.step, 1), 7);
      slugLabel();
      paintDial();
      // Never re-run the packaging call on a resume — go look at it instead.
      if (state.step === 6) { paintPackageOnResume(); return; }
      render();
      toast('Picked up where you left off.');
      return;
    } catch {
      history.replaceState(null, '', location.pathname);
      toast("That project link is no longer valid — starting fresh.", true);
    }
  }
  render();
})();

function paintPackageOnResume() {
  stage.innerHTML = panel('Station 105.3', 'The playlist', '<div id="pkgBox"></div>');
  paintPackage([]);
}
