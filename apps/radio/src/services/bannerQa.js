/**
 * Companion-banner QA — the display-ad builder's rulebook, applied to the
 * radio studio's banners.
 *
 * This is a port of smart1-ad-builder/src/qa.ts and image-budget.ts. The
 * same rules, the same thresholds, the same machine-readable findings:
 *
 *   file-weight   every delivered banner under 150 KB, and the fix is
 *                 "make it fit" (step the quality down), not "reject"
 *   dimensions    the derived image is exactly the size it claims
 *   contrast      measured against what actually sits behind the text —
 *                 the artwork+scrim render is fetched and its real pixels
 *                 sampled, not just the predicted colour maths
 *   logo-contrast the logo's own ink against its plate, ignoring
 *                 transparent padding
 *   legibility    nothing delivers below the 11px floor
 *   hierarchy     headline >= 1.4x the supporting line
 *   safe-area     every element inside the margin
 *   word-count    glance budgets: 3-5 word headline, support <= 8
 *
 * Findings carry { action: 'shorten', role, maxWords } fixes exactly like
 * the ad builder's, so the copy step can act on them without a human.
 */

import sharp from 'sharp';
import {
  bannerLayout, withinSafe, wordCount,
  MIN_FONT_PX, HIERARCHY_MIN, CONTRAST_MIN, MAX_BANNER_BYTES,
  HEADLINE_MAX_WORDS, SUPPORT_MAX_WORDS
} from './bannerLayout.js';
import { contrastRatio, luminance, toHex, pickTextColor, WHITE, NEAR_BLACK } from './contrast.js';

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/* ------------------------------------------------------------------ */
/* Pixel sampling — the part that makes this real                      */
/* ------------------------------------------------------------------ */

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const reason = res.headers.get('x-cld-error') || `HTTP ${res.status}`;
    throw new Error(`Could not fetch ${url.slice(0, 80)}…: ${reason}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Mean colour of a region of an image buffer. The ad builder learned the
 * hard way that sharp's .stats() reports on the INPUT image and ignores an
 * .extract() in the same pipeline — the crop must be materialised first.
 */
async function regionMeanHex(buffer, box, imgW, imgH) {
  const left = Math.max(0, Math.min(imgW - 1, Math.round(box.x)));
  const top = Math.max(0, Math.min(imgH - 1, Math.round(box.y)));
  const width = Math.max(1, Math.min(imgW - left, Math.round(box.w)));
  const height = Math.max(1, Math.min(imgH - top, Math.round(box.h)));
  const crop = await sharp(buffer).extract({ left, top, width, height }).toBuffer(); // materialise!
  const stats = await sharp(crop).stats();
  const [r, g, b] = stats.channels;
  return toHex({ r: r.mean, g: g.mean, b: b.mean });
}

/**
 * Mean luminance of a logo's VISIBLE ink — transparent padding must not
 * count, or a white mark on a transparent canvas averages out to "grey"
 * and sneaks past the check. Direct port of qa.ts logoInkLuminance.
 */
export async function logoInkLuminance(buffer) {
  try {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, weight = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const a = data[i + 3] / 255;
      if (a < 0.1) continue;
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      sum += lum * a;
      weight += a;
    }
    return weight > 0 ? sum / weight : null;
  } catch {
    return null;
  }
}

const lumContrast = (la, lb) => {
  const [hi, lo] = [la, lb].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

/* ------------------------------------------------------------------ */
/* Colour fixes the builder applies before the banner ships            */
/* ------------------------------------------------------------------ */

/**
 * The support line renders in the brand accent on the dark panel. A dark
 * accent is illegible there, so — like the ad builder substituting a
 * readable pair when Brandfetch reports a bad palette — walk the accent
 * toward white until it clears the floor, and say so.
 */
export function readableSupportColor(accentHex) {
  const clean = `#${String(accentHex).replace('#', '')}`;
  if (contrastRatio(clean, NEAR_BLACK) >= CONTRAST_MIN) return { color: null, adjusted: false };
  let c = clean;
  for (let i = 0; i < 8; i++) {
    const rgb = {
      r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16)
    };
    c = toHex({ r: rgb.r + (255 - rgb.r) * 0.3, g: rgb.g + (255 - rgb.g) * 0.3, b: rgb.b + (255 - rgb.b) * 0.3 });
    if (contrastRatio(c, NEAR_BLACK) >= CONTRAST_MIN) {
      return { color: `rgb:${c.slice(1)}`, adjusted: true, hex: c };
    }
  }
  return { color: 'white', adjusted: true, hex: WHITE };
}

/**
 * The domain bar is filled with the accent and lettered with whichever of
 * white/near-black reads better. On a mid-tone accent NEITHER clears
 * 4.5:1 — the ad builder's answer to an unusable pair is to substitute
 * one that works and report it, so: dark panel, white text, honestly noted.
 */
export function readableDomainBar(accentHex) {
  const clean = `#${String(accentHex).replace('#', '')}`;
  const best = pickTextColor(clean);
  if (best.ratio >= CONTRAST_MIN) return { bar: null, adjusted: false, ratio: best.ratio };
  return {
    bar: { bg: 'rgb:0B1220', text: 'white' },
    adjusted: true,
    ratio: contrastRatio(NEAR_BLACK, WHITE)
  };
}

/* ------------------------------------------------------------------ */
/* The QA run                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} input
 *   sizes            { '300x250': url, '640x640': url } — final rendered banners
 *   textFreeUrl      background-only render at 300x250, for pixel sampling
 *   title, sub, domain  the copy actually composited
 *   accentHex        brand accent (no #)
 *   supportColorHex  hex actually used for the support line (after any fix)
 *   domainBarFixed   true when the domain bar was swapped to the dark panel
 *   logoBuffer       the logo image, when there is one
 *   logoPlate        'white' | 'rgb:0B1220' — the plate behind the logo
 * @returns { findings, verdict, weights }
 */
export async function runBannerQa(input) {
  const {
    sizes = {}, textFreeUrl, title = '', sub = '', domain = '',
    accentHex = 'FFB020', supportColorHex = null, domainBarFixed = false,
    logoBuffer = null, logoPlate = 'white'
  } = input;

  const findings = [];
  const pass = (check, detail) => findings.push({ check, status: 'pass', detail });
  const warn = (check, detail, fix) => findings.push({ check, status: 'warn', detail, fix });
  const fail = (check, detail, fix) => findings.push({ check, status: 'fail', detail, fix });

  /* ------------------------------------------------- file weight + dimensions */
  const weights = {};
  for (const [size, url] of Object.entries(sizes)) {
    const [w, h] = size.split('x').map(Number);
    try {
      const buf = await fetchBuffer(url);
      weights[size] = buf.length;
      if (buf.length > MAX_BANNER_BYTES) {
        fail('file-weight', `${size} is ${kb(buf.length)}, over the ${kb(MAX_BANNER_BYTES)} ceiling`, { action: 'compress', size });
      } else {
        pass('file-weight', `${size} ${kb(buf.length)} of ${kb(MAX_BANNER_BYTES)}`);
      }
      const meta = await sharp(buf).metadata();
      if (meta.width === w && meta.height === h) {
        pass('dimensions', `${size} delivered exactly ${meta.width}x${meta.height}`);
      } else {
        fail('dimensions', `${size} delivered ${meta.width}x${meta.height}`);
      }
    } catch (err) {
      fail('render', `${size}: ${err.message}`);
    }
  }

  /* --------------------------------------------------------- geometry checks */
  const W = 300, H = 250;
  const layout = bannerLayout(W, H, { title, sub, domain, hasLogo: Boolean(logoBuffer) });

  // Safe area — every element inside the margin.
  const offenders = Object.entries(layout.boxes)
    .filter(([, box]) => !withinSafe(box, W, H, layout.safeMargin))
    .map(([role]) => role);
  if (offenders.length) {
    warn('safe-area', `outside the ${layout.safeMargin}px margin: ${offenders.join(', ')}`);
  } else {
    pass('safe-area', `all elements inside the ${layout.safeMargin}px margin`);
  }

  // Legibility — the 11px floor, checked at the smallest delivered scale.
  const smallest = Object.entries(layout.deliveredFonts).sort((a, b) => a[1] - b[1])[0];
  if (smallest && smallest[1] < MIN_FONT_PX) {
    warn('legibility', `"${smallest[0]}" delivers at ${smallest[1]}px, below the ${MIN_FONT_PX}px floor`, { action: 'shorten', role: smallest[0] });
  } else if (smallest) {
    pass('legibility', `smallest text ("${smallest[0]}") ${smallest[1]}px`);
  }

  // Hierarchy — headline vs support. Derived sizes make this true by
  // construction; the check stays so a future edit cannot silently break it.
  if (title && sub) {
    const ratio = layout.fonts.headline / layout.fonts.support;
    if (ratio < HIERARCHY_MIN) {
      warn('hierarchy', `headline is only ${ratio.toFixed(2)}x the supporting line; aim for ${HIERARCHY_MIN}x or more`, { action: 'shorten', role: 'headline' });
    } else {
      pass('hierarchy', `headline ${ratio.toFixed(2)}x supporting text`);
    }
  }

  // Word budgets — glance format.
  const titleWords = wordCount(title);
  if (titleWords > HEADLINE_MAX_WORDS) {
    warn('word-count', `headline carries ${titleWords} words; the glance budget is ${HEADLINE_MAX_WORDS}`, { action: 'shorten', role: 'headline', maxWords: HEADLINE_MAX_WORDS });
  } else if (title) {
    pass('word-count', `headline ${titleWords} word${titleWords === 1 ? '' : 's'} (budget ${HEADLINE_MAX_WORDS})`);
  }
  const subWords = wordCount(sub);
  if (subWords > SUPPORT_MAX_WORDS) {
    warn('word-count', `support line carries ${subWords} words; the budget is ${SUPPORT_MAX_WORDS}`, { action: 'shorten', role: 'support', maxWords: SUPPORT_MAX_WORDS });
  }

  /* ----------------------------------------------------- contrast, measured */
  // The text panels are solid, so their ratios are exact maths; the artwork
  // behind everything is measured from the actual scrimmed render, because
  // predicted colour maths and delivered pixels are not the same thing.
  const accent = `#${String(accentHex).replace('#', '')}`;

  const lowContrast = [];
  // headline: white on the near-black panel — fixed, but assert it.
  if (title) {
    const r = contrastRatio(WHITE, NEAR_BLACK);
    if (r < CONTRAST_MIN) lowContrast.push(`headline ${r.toFixed(1)}:1`);
  }
  // support: the colour actually used (accent, or the QA-adjusted colour).
  if (sub) {
    const used = supportColorHex || accent;
    const r = contrastRatio(used, NEAR_BLACK);
    if (r < CONTRAST_MIN) lowContrast.push(`support ${r.toFixed(1)}:1`);
  }
  // domain bar: as shipped (accent bar with best text, or the dark fix).
  if (domain) {
    const r = domainBarFixed ? contrastRatio(WHITE, NEAR_BLACK) : pickTextColor(accent).ratio;
    if (r < CONTRAST_MIN) lowContrast.push(`domain bar ${r.toFixed(1)}:1`);
  }

  // The measured pass: sample the real scrimmed artwork under the text
  // bands. Text can wrap a line beyond its panel, so white copy must also
  // survive against the wash itself.
  if (textFreeUrl) {
    try {
      const bg = await fetchBuffer(textFreeUrl);
      const meta = await sharp(bg).metadata();
      for (const role of ['headline', 'support']) {
        const box = layout.boxes[role];
        if (!box) continue;
        const behind = await regionMeanHex(bg, box, meta.width, meta.height);
        const ink = role === 'support' && supportColorHex ? supportColorHex : WHITE;
        const r = contrastRatio(ink, behind);
        if (r < CONTRAST_MIN) lowContrast.push(`${role} vs artwork ${r.toFixed(1)}:1 (measured)`);
      }
      pass('contrast-sampled', 'artwork luminance measured from the delivered render, not predicted');
    } catch (err) {
      warn('contrast-sampled', `could not sample the rendered background (${err.message}) — falling back to predicted colours`);
    }
  }

  if (lowContrast.length) {
    warn('contrast', `below ${CONTRAST_MIN}:1 — ${lowContrast.join(', ')}`, { action: 'rescrim' });
  } else {
    pass('contrast', `all text at or above ${CONTRAST_MIN}:1 against what sits behind it`);
  }

  /* --------------------------------------------------------- logo contrast */
  if (logoBuffer) {
    const ink = await logoInkLuminance(logoBuffer);
    if (ink !== null) {
      const plateLum = luminance(logoPlate === 'white' ? WHITE : NEAR_BLACK);
      const r = lumContrast(ink, plateLum);
      if (r < 1.7) {
        warn('logo-contrast', `the logo is nearly invisible on its plate (${r.toFixed(1)}:1)`);
      } else {
        pass('logo-contrast', `logo reads clearly on its plate (${r.toFixed(1)}:1)`);
      }
    }
  }

  const verdict = findings.some((f) => f.status === 'fail') ? 'fail'
    : findings.some((f) => f.status === 'warn') ? 'warn' : 'pass';

  return { findings, verdict, weights };
}

/**
 * The weight fix, ported from image-budget.ts: never reject, make it fit.
 * Steps the explicit quality down until every size is under 150 KB, and
 * reports what was done.
 */
export async function fitBannerWeight(buildUrl, sizes) {
  const steps = [null, 75, 60, 45, 30]; // null = q_auto, the normal case
  for (const quality of steps) {
    const urls = buildUrl(quality);
    let allUnder = true;
    const weights = {};
    for (const [size, url] of Object.entries(urls)) {
      try {
        const buf = await fetchBuffer(url);
        weights[size] = buf.length;
        if (buf.length > MAX_BANNER_BYTES) { allUnder = false; break; }
      } catch {
        allUnder = false;
        break;
      }
    }
    if (allUnder) {
      return {
        sizes: urls,
        quality,
        weights,
        note: quality ? `Compressed to quality ${quality} to meet the 150 KB limit.` : null
      };
    }
  }
  // Even the hardest step failed — ship the smallest attempt and flag it.
  return { sizes: buildUrl(30), quality: 30, weights: {}, note: 'Could not compress under 150 KB — the artwork may be too busy.', overweight: true };
}
