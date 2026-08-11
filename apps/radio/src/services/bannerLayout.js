/**
 * Companion-banner geometry, in one place.
 *
 * The banner template lives in two worlds: cloudinary.js builds the overlay
 * transformation from these numbers, and bannerQa.js checks the finished
 * image against the same numbers. They used to be implicit in the URL
 * builder; splitting them out means the QA can never drift from the layout
 * it is checking.
 *
 * All values are authored in 300px space and scaled by width/300, exactly
 * as the URL builder has always done.
 *
 * The design rules here are the ones the display-ad builder enforces
 * (smart1-ad-builder/src/qa.ts), applied to this template:
 *
 *   - hierarchy: the headline must render at >= 1.4x the supporting line,
 *     so the eye has one clear entry point. The support size is DERIVED
 *     from the headline size to make that true by construction.
 *   - legibility: nothing may deliver below 11px.
 *   - safe area: every element keeps a margin from the canvas edge.
 *   - word budgets: a glance-format headline carries 3-5 words, the
 *     support line at most 8.
 */

export const MIN_FONT_PX = 11;       // same floor as the ad builder's platform rules
export const HIERARCHY_MIN = 1.4;    // headline vs support, ad-builder QA threshold
export const CONTRAST_MIN = 4.5;     // WCAG floor the ad builder enforces per role
export const MAX_BANNER_BYTES = 150 * 1024; // the ad builder's one-choke-point image ceiling
export const HEADLINE_MAX_WORDS = 5;
export const SUPPORT_MAX_WORDS = 8;

/** Headline size from copy length — unchanged from the original builder. */
export function titleSizeFor(title = '') {
  const len = String(title).length;
  return len <= 14 ? 28 : len <= 20 ? 24 : len <= 28 ? 20 : 17;
}

/**
 * Support size derived from the headline so the hierarchy rule holds by
 * construction: floor(title / 1.45), clamped to [11, 13]. At the smallest
 * headline (17px) that is 11px — still on the legibility floor, and 1.54x.
 */
export function supportSizeFor(titleSize) {
  return Math.max(MIN_FONT_PX, Math.min(13, Math.floor(titleSize / 1.45)));
}

/**
 * The full geometry for one banner size.
 *
 * @param {number} width   delivered width in px
 * @param {number} height  delivered height in px
 * @param {object} content { title, sub, domain, hasLogo }
 * @returns boxes in DELIVERED pixel space plus font sizes and the px() scale
 */
export function bannerLayout(width, height, { title = '', sub = '', domain = '', hasLogo = false } = {}) {
  const scale = width / 300;
  const px = (n) => Math.max(6, Math.round(n * scale));

  const titleSize = titleSizeFor(title);
  const supportSize = supportSizeFor(titleSize);
  const domainSize = 15;

  const boxes = {};

  if (hasLogo) {
    const w = px(162), h = px(56);
    boxes.logo = { x: Math.round((width - w) / 2), y: px(16), w, h };
  }

  if (title) {
    const w = px(244);
    // Cloudinary wraps at the box width; allow two lines when sampling.
    const h = Math.round(px(titleSize) * 2.6);
    const centerY = height / 2 + px(sub ? -8 : 2);
    boxes.headline = { x: Math.round((width - w) / 2), y: Math.round(centerY - h / 2), w, h };
  }

  if (sub) {
    const w = px(244);
    const h = Math.round(px(supportSize) * 1.6);
    const centerY = height / 2 + px(26);
    boxes.support = { x: Math.round((width - w) / 2), y: Math.round(centerY - h / 2), w, h };
  }

  if (domain) {
    // No fixed box width in the transformation — estimate from the glyphs.
    const w = Math.min(width - px(12), Math.round(String(domain).length * px(domainSize) * 0.62) + px(16));
    const h = Math.round(px(domainSize) * 1.6);
    boxes.domain = { x: Math.round((width - w) / 2), y: height - px(14) - h, w, h };
  }

  return {
    scale,
    px,
    fonts: {
      headline: titleSize,       // authored (300px-space) size
      support: supportSize,
      domain: domainSize,
    },
    /** Sizes as actually delivered, for the legibility check. */
    deliveredFonts: {
      headline: px(titleSize),
      support: px(supportSize),
      domain: px(domainSize),
    },
    boxes,
    /** Everything must stay inside this margin — mirror of the ad builder's safe area. */
    safeMargin: px(8),
  };
}

/** True when the box sits inside the canvas minus the safe margin. */
export function withinSafe(box, width, height, margin) {
  return (
    box.x >= margin - 0.5 &&
    box.y >= margin - 0.5 &&
    box.x + box.w <= width - margin + 0.5 &&
    box.y + box.h <= height - margin + 0.5
  );
}

export const wordCount = (s = '') => String(s).split(/\s+/).filter(Boolean).length;
