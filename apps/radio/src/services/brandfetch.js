import { config } from '../config.js';
import { log } from './store.js';

export function domainFromUrl(input = '') {
  const raw = String(input).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^www\./, '').split('/')[0];
  }
}

function pickLogo(logos = []) {
  const order = ['icon', 'logo', 'symbol', 'other'];
  const scored = logos
    .flatMap((l) => (l.formats || []).map((f) => ({ ...f, type: l.type, theme: l.theme })))
    .filter((f) => f.src);
  if (!scored.length) return null;
  // Prefer a light-background-safe full logo in png/svg.
  scored.sort((a, b) => {
    const t = order.indexOf(a.type) - order.indexOf(b.type);
    if (t !== 0) return t;
    const fmt = (x) => (x.format === 'svg' ? 0 : x.format === 'png' ? 1 : 2);
    return fmt(a) - fmt(b);
  });
  const preferred = scored.find((f) => f.type === 'logo') || scored[0];
  return preferred.src;
}

/**
 * Look up a brand by website. Returns null-ish fields rather than throwing so
 * the form can still be filled in by hand when a brand isn't indexed.
 */
export async function fetchBrand(url) {
  const domain = domainFromUrl(url);
  if (!domain) throw new Error('Enter a website address first.');
  if (!config.brandfetch.key) throw new Error('Brandfetch key is not set. Add BRANDFETCH_API_KEY.');

  const res = await fetch(`${config.brandfetch.base}/brands/${encodeURIComponent(domain)}`, {
    headers: { Authorization: `Bearer ${config.brandfetch.key}` }
  });

  if (res.status === 404) {
    log.warn('brandfetch', `No brand record for ${domain}`);
    return { domain, found: false, name: '', description: '', logo: null, colors: [], fonts: [], links: [] };
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brandfetch ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    domain,
    found: true,
    name: data.name || '',
    description: data.description || data.longDescription || '',
    logo: pickLogo(data.logos),
    colors: (data.colors || []).map((c) => ({ hex: c.hex, type: c.type })),
    fonts: (data.fonts || []).map((f) => f.name).filter(Boolean),
    links: (data.links || []).map((l) => ({ name: l.name, url: l.url })),
    industry: data.company?.industries?.[0]?.name || '',
    location: [data.company?.location?.city, data.company?.location?.state].filter(Boolean).join(', ')
  };
}
