/**
 * Radio scripts are full of things a text-to-speech model reads wrong:
 * phone numbers as one enormous integer, URLs as gibberish, "$19.99" as
 * "dollar nineteen point nine nine". This rewrites the copy into words
 * before it reaches ElevenLabs, and reports every change so the client can
 * see exactly how their spot will be read.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberToWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  if (n < 1e6) return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
  return `${numberToWords(Math.floor(n / 1e6))} million${n % 1e6 ? ` ${numberToWords(n % 1e6)}` : ''}`;
}

const ORDINALS = {
  1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth', 9: 'ninth', 12: 'twelfth',
  20: 'twentieth', 30: 'thirtieth'
};
function ordinal(n) {
  n = Number(n);
  if (ORDINALS[n]) return ORDINALS[n];
  if (n < 20) return `${numberToWords(n)}th`;
  if (n % 10 === 0) return `${TENS[n / 10].slice(0, -1)}ieth`;
  return `${TENS[Math.floor(n / 10)]}-${ORDINALS[n % 10] || `${ONES[n % 10]}th`}`;
}

const digitsToWords = (s) => String(s).split('').map((d) => ONES[Number(d)] || d).join(' ');

/** Read a domain segment: digits become words, hyphens are spoken. */
function speakSegment(seg) {
  return seg
    .replace(/(\d+)/g, (m) => ` ${digitsToWords(m)} `)
    .replace(/-/g, ' dash ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
  jul: 'July', aug: 'August', sep: 'September', sept: 'September', oct: 'October',
  nov: 'November', dec: 'December'
};

/** Everyday abbreviations, safest first. Editable per project in the studio. */
export const DEFAULT_ABBREVIATIONS = [
  [/\bAve\./gi, 'Avenue'], [/\bBlvd\.?/gi, 'Boulevard'], [/\bRd\./gi, 'Road'],
  [/\bDr\.(?=\s+[A-Z][a-z])/g, 'Doctor'], [/\bDr\./g, 'Drive'],
  [/\bSte\.?\s*(\d+)/gi, (_, n) => `Suite ${digitsToWords(n)}`], [/\bHwy\.?/gi, 'Highway'], [/\bMt\./gi, 'Mount'],
  [/\bApt\.?/gi, 'Apartment'], [/\bJct\.?/gi, 'Junction'],
  [/\bM-F\b/gi, 'Monday through Friday'], [/\bMon-Fri\b/gi, 'Monday through Friday'],
  [/\bSat-Sun\b/gi, 'Saturday and Sunday'],
  [/\b24\/7\b/g, 'twenty four seven'], [/\bw\//gi, 'with'], [/\s&\s/g, ' and '],
  [/\b#(\d+)/g, (_, n) => `number ${numberToWords(n)}`],
  [/\bNo\.\s*(\d+)/gi, (_, n) => `number ${numberToWords(n)}`],
  [/\bvs\.?\b/gi, 'versus'], [/\betc\.?\b/gi, 'and so on'],
  [/\bASAP\b/g, 'A S A P'], [/\bDIY\b/g, 'D I Y'], [/\bHVAC\b/g, 'H VAC']
];

const TLD = '(?:com|net|org|co|io|us|biz|info|shop|agency|studio)';

/**
 * @param {string} text raw script
 * @param {Array<{from:string,to:string}>} pronunciations project overrides
 * @returns {{spoken:string, changes:Array<{from:string,to:string,why:string}>}}
 */
export function normalizeForSpeech(text, pronunciations = [], language = 'en') {
  let out = String(text || '');
  // Everything below rewrites numbers, money and dates into ENGLISH words.
  // Running it on a Spanish or German script would read "$89" as
  // "eighty-nine dollars" in the middle of Spanish copy. For any other
  // language we apply only the language-neutral steps and let the voice
  // model handle the rest.
  const english = String(language || 'en').toLowerCase().startsWith('en');
  const changes = [];
  const note = (from, to, why) => {
    if (from !== to) changes.push({ from, to, why });
  };

  const swap = (re, replacer, why) => {
    out = out.replace(re, (...args) => {
      const match = args[0];
      const to = typeof replacer === 'function' ? replacer(...args) : replacer;
      note(match, to, why);
      return to;
    });
  };

  // Defensive: the model is told not to write stage directions, but strip any.
  swap(/\s*[\[(](?:SFX|VO|MUSIC|ANNCR)[^\])]*[\])]\s*/gi, ' ', 'stage direction removed');

  // 1. Project-specific overrides win, so they run before anything generic.
  for (const p of pronunciations) {
    if (!p?.from) continue;
    const safe = p.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    swap(new RegExp(`\\b${safe}\\b`, 'gi'), p.to, 'your pronunciation');
  }

  // 2. Email before URL, or the domain rule eats the address.
  swap(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g,
    (_, user, host) => `${speakSegment(user.replace(/\./g, ' dot '))} at ${host.split('.').map(speakSegment).join(' dot ')}`,
    'email address');

  // 3. Web addresses.
  swap(new RegExp(`\\b(?:https?:\\/\\/)?(?:www\\.)?([a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${TLD})(\\/[^\\s,.]*)?`, 'gi'),
    (m, host, path) => {
      const spokenHost = host.split('.').map(speakSegment).join(' dot ');
      const spokenPath = path ? ` slash ${path.replace(/^\//, '').split('/').map(speakSegment).join(' slash ')}` : '';
      return `${/^www\./i.test(m) ? 'w w w dot ' : ''}${spokenHost}${spokenPath}`;
    },
    'web address');

  if (!english) {
    // Language-neutral only: spacing digits still helps every language.
    swap(/(?:\+?1[\s.-])?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g,
      (_, a, b, c) => `${a.split('').join(' ')}, ${b.split('').join(' ')}, ${c.split('').join(' ')}`,
      'phone number');
    out = out.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
    return { spoken: out, changes, language };
  }

  // 4. Phone numbers, spoken digit by digit with pauses between groups.
  swap(/(?:\+?1[\s.-])?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g,
    (_, a, b, c) => `${digitsToWords(a)}, ${digitsToWords(b)}, ${digitsToWords(c)}`,
    'phone number');

  // 5. Money.
  swap(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g, (_, whole, cents) => {
    const n = Number(String(whole).replace(/,/g, ''));
    const dollars = `${numberToWords(n)} dollar${n === 1 ? '' : 's'}`;
    if (!cents || cents === '00') return dollars;
    return `${dollars} and ${numberToWords(cents)} cents`;
  }, 'price');

  // 6. Percentages.
  swap(/(\d+(?:\.\d+)?)\s?%/g, (_, n) =>
    n.includes('.')
      ? `${numberToWords(n.split('.')[0])} point ${digitsToWords(n.split('.')[1])} percent`
      : `${numberToWords(n)} percent`,
    'percentage');

  // 7. Dates: "Aug 14" and "August 14th" both become spoken ordinals.
  swap(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi,
    (_, mon, day) => `${MONTHS[mon.toLowerCase().replace('.', '')] || mon} ${ordinal(day)}`,
    'date');

  // 8. Everyday abbreviations.
  for (const [re, to] of DEFAULT_ABBREVIATIONS) {
    swap(re, to, 'abbreviation');
  }

  // 9. Bare standalone numbers left over (not years).
  swap(/\b(\d{1,3}(?:,\d{3})+|\d{1,3})\b(?!\s?(?:st|nd|rd|th))/g, (m) => {
    const n = Number(m.replace(/,/g, ''));
    return numberToWords(n);
  }, 'number');

  out = out.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  return { spoken: out, changes, language };
}

/* ---------- timing ---------- */

/**
 * Synthetic voices read considerably faster than a human scratch estimate.
 * 2.6 words/sec was far too slow and left long tails of silence, so the
 * default is now 3.1 and every finished render feeds a measured rate back
 * in, which is what later estimates actually use.
 */
export const WORDS_PER_SECOND = Number(process.env.WORDS_PER_SECOND || 3.1);

export const countWords = (s = '') => String(s).split(/\s+/).filter(Boolean).length;

export const estimateSeconds = (s = '', rate = WORDS_PER_SECOND) =>
  Math.round((countWords(s) / (rate || WORDS_PER_SECOND)) * 10) / 10;

/** Words that will fit a slot at the given pace, leaving a beat at each end. */
export const wordsForSeconds = (seconds, rate = WORDS_PER_SECOND) =>
  Math.round((seconds - 0.8) * (rate || WORDS_PER_SECOND));

/** Actual pace of a finished take, used to sharpen the next estimate. */
export function measuredRate(script, seconds) {
  if (!seconds || seconds < 3) return null;
  const rate = countWords(script) / seconds;
  return rate > 1.5 && rate < 6 ? Math.round(rate * 100) / 100 : null;
}

/**
 * How far off the clock a finished render is. A spot that runs short is now
 * treated as a real fault rather than something to pad with silence: more
 * than 1.2s of tail and the copy needs lengthening.
 */
export function gradeDuration(seconds, target, rate = WORDS_PER_SECOND) {
  if (!seconds) return { status: 'unknown', label: 'Length not measured' };
  const pace = rate || WORDS_PER_SECOND;
  const over = seconds - target;

  if (over > 0.4) {
    const words = Math.max(1, Math.round(over * pace));
    return {
      status: 'long', over: Math.round(over * 10) / 10, trimWords: words,
      label: `${seconds.toFixed(1)}s — ${over.toFixed(1)}s over. Roughly ${words} word${words === 1 ? '' : 's'} too many.`
    };
  }
  if (seconds < target - 1.2) {
    const gap = target - seconds;
    const words = Math.max(2, Math.round(gap * pace));
    return {
      status: 'short', under: Math.round(gap * 10) / 10, addWords: words,
      label: `${seconds.toFixed(1)}s — ${gap.toFixed(1)}s short. Roughly ${words} more word${words === 1 ? '' : 's'} would fill it.`
    };
  }
  return { status: 'good', label: `${seconds.toFixed(1)}s — lands on the clock.` };
}
