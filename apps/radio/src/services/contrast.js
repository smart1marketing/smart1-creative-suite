/**
 * Colour maths for the companion banner.
 *
 * The banner is type over generated artwork, and the artwork is different
 * every time. Rather than hoping white reads on it, we ask Cloudinary for
 * the artwork's predominant colours at upload, work out what the scrim does
 * to them, and then choose the text colour — and the scrim strength — that
 * actually clears a contrast threshold.
 *
 * Ratios follow WCAG: 4.5:1 is the floor for normal text, 3:1 for large
 * text. Banners are glanced at on a phone in daylight, so the target here
 * is deliberately higher than the legal minimum.
 */

export const WHITE = '#FFFFFF';
export const NEAR_BLACK = '#0B1220';

/** '#1b2e4e' or '1b2e4e' -> { r, g, b } as 0-255. */
export function toRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

export const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Relative luminance, per WCAG 2.1. */
export function luminance(hex) {
  const c = toRgb(hex);
  if (!c) return 0;
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

/** Contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Whichever of white or near-black reads better on the given colour. */
export function pickTextColor(bgHex) {
  const onWhite = contrastRatio(bgHex, WHITE);
  const onBlack = contrastRatio(bgHex, NEAR_BLACK);
  return onWhite >= onBlack
    ? { color: WHITE, ratio: onWhite }
    : { color: NEAR_BLACK, ratio: onBlack };
}

/**
 * What a colour becomes after Cloudinary's brightness and colorize effects.
 * Mirrors the transformation we apply, so the maths matches the picture.
 *
 * @param {string} hex          starting colour
 * @param {number} brightness   Cloudinary e_brightness, -100..100
 * @param {number} colorize     e_colorize percentage, 0..100
 * @param {string} toward       colour being colorized toward
 */
export function afterScrim(hex, brightness, colorize, toward = NEAR_BLACK) {
  const c = toRgb(hex);
  const t = toRgb(toward);
  if (!c || !t) return hex;

  // Cloudinary brightness shifts each channel by a share of full range.
  const shift = (brightness / 100) * 255;
  const bright = { r: c.r + shift, g: c.g + shift, b: c.b + shift };

  // Colorize blends linearly toward the target colour.
  const k = Math.max(0, Math.min(100, colorize)) / 100;
  return toHex({
    r: bright.r * (1 - k) + t.r * k,
    g: bright.g * (1 - k) + t.g * k,
    b: bright.b * (1 - k) + t.b * k
  });
}

/**
 * Find the gentlest scrim that still clears the target contrast, so we never
 * darken the artwork more than legibility actually requires.
 *
 * @param {string[]} artColors predominant colours from the uploaded artwork
 * @returns {{brightness:number, colorize:number, textColor:string, ratio:number, passes:boolean}}
 */
export function solveScrim(artColors = [], { target = 7, textColor = WHITE } = {}) {
  const samples = (artColors || []).map(toRgb).filter(Boolean).length
    ? artColors
    : ['#7F7F7F']; // no colour data: assume mid grey, which is the hard case

  // Try increasingly strong scrims until the worst-case sample passes.
  for (const [brightness, colorize] of [
    [-18, 25], [-24, 32], [-30, 40], [-34, 48], [-40, 56], [-46, 64], [-52, 72]
  ]) {
    const ratios = samples.map((hex) =>
      contrastRatio(afterScrim(hex, brightness, colorize), textColor)
    );
    const worst = Math.min(...ratios);
    if (worst >= target) {
      return { brightness, colorize, textColor, ratio: Math.round(worst * 100) / 100, passes: true };
    }
  }

  // Even the heaviest scrim did not get there — report honestly.
  const brightness = -52, colorize = 72;
  const worst = Math.min(...samples.map((hex) =>
    contrastRatio(afterScrim(hex, brightness, colorize), textColor)));
  return { brightness, colorize, textColor, ratio: Math.round(worst * 100) / 100, passes: worst >= 4.5 };
}

/**
 * A logo needs a plate behind it or it disappears into the artwork. A dark
 * logo wants a white plate; a light or white logo wants a dark one.
 */
export function plateFor(logoColors = []) {
  const cols = (logoColors || []).map(toRgb).filter(Boolean);
  if (!cols.length) return { plate: 'white', reason: 'no colour data — defaulted to a white plate' };

  const avg = cols.reduce((a, c) => ({ r: a.r + c.r / cols.length, g: a.g + c.g / cols.length, b: a.b + c.b / cols.length }), { r: 0, g: 0, b: 0 });
  const lum = luminance(toHex(avg));

  return lum > 0.55
    ? { plate: 'rgb:0B1220', reason: 'the logo is light, so it sits on a dark plate' }
    : { plate: 'white', reason: 'the logo is dark, so it sits on a white plate' };
}

/** Just the domain — no protocol, no www, no path. */
export function rootDomain(...urls) {
  for (const raw of urls) {
    const s = String(raw || '').trim();
    if (!s) continue;
    try {
      const u = new URL(s.startsWith('http') ? s : `https://${s}`);
      return u.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      const guess = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
      if (guess) return guess;
    }
  }
  return '';
}
