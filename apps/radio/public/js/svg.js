/* Animated SVG loaders. One shows any time we're waiting on the AI, so the
   wait always looks like something happening in a studio. */

const S = '#29abe2';   /* primary accent */
const V = '#1cd3a2';   /* success */
const D = '#cbd5e0';   /* hairline */
const T = '#5f6f85';   /* structure */
const BG = '#f7f9fc';  /* card fill */

const tower = () => `
<svg viewBox="0 0 120 120" role="img" aria-label="Broadcasting">
  <g fill="none" stroke="${S}" stroke-width="2" stroke-linecap="round">
    ${[0, 1, 2].map((i) => `
    <path d="M74 42a26 26 0 0 1 0 36" opacity="0">
      <animate attributeName="opacity" values="0;1;0" dur="1.8s" begin="${i * 0.45}s" repeatCount="indefinite"/>
      <animateTransform attributeName="transform" type="scale" values="0.75;1.15" additive="sum" dur="1.8s" begin="${i * 0.45}s" repeatCount="indefinite"/>
    </path>
    <path d="M46 42a26 26 0 0 0 0 36" opacity="0">
      <animate attributeName="opacity" values="0;1;0" dur="1.8s" begin="${i * 0.45}s" repeatCount="indefinite"/>
    </path>`).join('')}
  </g>
  <path d="M60 22 L46 96 M60 22 L74 96 M51 62h18 M48 78h24" stroke="${T}" stroke-width="3" fill="none" stroke-linecap="round"/>
  <circle cx="60" cy="20" r="5" fill="${S}">
    <animate attributeName="r" values="4;6;4" dur="1.2s" repeatCount="indefinite"/>
  </circle>
  <rect x="34" y="96" width="52" height="5" rx="2.5" fill="${D}"/>
</svg>`;

const vinyl = () => `
<svg viewBox="0 0 120 120" role="img" aria-label="Cueing the record">
  <g>
    <circle cx="56" cy="62" r="38" fill="${BG}" stroke="${D}" stroke-width="2"/>
    <g stroke="${D}" fill="none" stroke-width="1">
      <circle cx="56" cy="62" r="30"/><circle cx="56" cy="62" r="24"/><circle cx="56" cy="62" r="18"/>
    </g>
    <circle cx="56" cy="62" r="10" fill="${S}"/>
    <circle cx="56" cy="62" r="2.5" fill="#fff"/>
    <path d="M56 24a38 38 0 0 1 33 19" stroke="${V}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <animateTransform attributeName="transform" type="rotate" from="0 56 62" to="360 56 62" dur="2.4s" repeatCount="indefinite"/>
  </g>
  <g>
    <circle cx="98" cy="26" r="4" fill="${T}"/>
    <path d="M98 26 L74 54" stroke="${T}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="74" cy="54" r="3" fill="${S}"/>
    <animateTransform attributeName="transform" type="rotate" values="6 98 26;-2 98 26;6 98 26" dur="3.2s" repeatCount="indefinite"/>
  </g>
</svg>`;

const vu = () => `
<svg viewBox="0 0 120 120" role="img" aria-label="Checking levels">
  <rect x="10" y="26" width="100" height="68" rx="8" fill="${BG}" stroke="${D}" stroke-width="2"/>
  <path d="M22 78 A40 40 0 0 1 98 78" fill="none" stroke="${D}" stroke-width="2"/>
  <path d="M74 48 A40 40 0 0 1 98 78" fill="none" stroke="${S}" stroke-width="3"/>
  ${[0, 1, 2, 3, 4, 5, 6].map((i) => {
    const a = Math.PI - (i / 6) * Math.PI;
    const x1 = 60 + Math.cos(a) * 34, y1 = 78 - Math.sin(a) * 34;
    const x2 = 60 + Math.cos(a) * 29, y2 = 78 - Math.sin(a) * 29;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${i > 4 ? S : T}" stroke-width="2"/>`;
  }).join('')}
  <g>
    <line x1="60" y1="78" x2="60" y2="44" stroke="${V}" stroke-width="2.5" stroke-linecap="round"/>
    <animateTransform attributeName="transform" type="rotate" values="-52 60 78;38 60 78;-14 60 78;46 60 78;-52 60 78" dur="2.6s" repeatCount="indefinite"/>
  </g>
  <circle cx="60" cy="78" r="5" fill="${T}"/>
</svg>`;

const reels = () => `
<svg viewBox="0 0 120 120" role="img" aria-label="Rolling tape">
  <rect x="8" y="24" width="104" height="72" rx="8" fill="${BG}" stroke="${D}" stroke-width="2"/>
  <path d="M36 58 C 48 74, 72 74, 84 58" stroke="${T}" stroke-width="2.5" fill="none"/>
  ${[[36, 58], [84, 58]].map(([cx, cy], i) => `
  <g>
    <circle cx="${cx}" cy="${cy}" r="19" fill="#fff" stroke="${i ? V : S}" stroke-width="2.5"/>
    <circle cx="${cx}" cy="${cy}" r="5" fill="${i ? V : S}"/>
    ${[0, 120, 240].map((r) => `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 16}" stroke="${D}" stroke-width="3" transform="rotate(${r} ${cx} ${cy})"/>`).join('')}
    <animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="${i ? 360 : -360} ${cx} ${cy}" dur="${i ? 2.2 : 1.7}s" repeatCount="indefinite"/>
  </g>`).join('')}
  <rect x="46" y="84" width="28" height="4" rx="2" fill="${S}">
    <animate attributeName="width" values="8;28;8" dur="2s" repeatCount="indefinite"/>
  </rect>
</svg>`;

const waveform = () => `
<svg viewBox="0 0 120 120" role="img" aria-label="Rendering audio">
  <rect x="6" y="30" width="108" height="60" rx="8" fill="${BG}" stroke="${D}" stroke-width="2"/>
  ${Array.from({ length: 13 }, (_, i) => {
    const x = 16 + i * 7.5;
    const dur = (1 + (i % 5) * 0.18).toFixed(2);
    const color = i % 4 === 0 ? S : i % 3 === 0 ? V : T;
    return `<rect x="${x}" y="52" width="4" height="16" rx="2" fill="${color}">
      <animate attributeName="height" values="8;38;14;30;8" dur="${dur}s" repeatCount="indefinite"/>
      <animate attributeName="y" values="56;41;53;45;56" dur="${dur}s" repeatCount="indefinite"/>
    </rect>`;
  }).join('')}
</svg>`;

const mic = () => `
<svg viewBox="0 0 120 120" role="img" aria-label="Warming up the booth">
  ${[0, 1].map((i) => `<circle cx="60" cy="52" r="26" fill="none" stroke="${S}" stroke-width="2" opacity="0">
    <animate attributeName="r" values="20;44" dur="2.2s" begin="${i * 1.1}s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.6;0" dur="2.2s" begin="${i * 1.1}s" repeatCount="indefinite"/>
  </circle>`).join('')}
  <rect x="48" y="22" width="24" height="42" rx="12" fill="${S}"/>
  <rect x="53" y="28" width="14" height="3" rx="1.5" fill="#fff" opacity="0.5"/>
  <rect x="53" y="36" width="14" height="3" rx="1.5" fill="#fff" opacity="0.5"/>
  <rect x="53" y="44" width="14" height="3" rx="1.5" fill="#fff" opacity="0.5"/>
  <path d="M38 56a22 22 0 0 0 44 0" fill="none" stroke="${T}" stroke-width="3" stroke-linecap="round"/>
  <line x1="60" y1="78" x2="60" y2="92" stroke="${T}" stroke-width="3"/>
  <rect x="42" y="92" width="36" height="5" rx="2.5" fill="${D}"/>
</svg>`;

const ART = { tower, vinyl, vu, reels, waveform, mic };

const CAPTIONS = {
  analyze: ['Reading the site…', 'Pulling the offer apart…', 'Finding the proof points…', 'Listening for the hook…'],
  scripts: ['Writing to the clock…', 'Counting words per second…', 'Trimming to :15…', 'Landing the call to action…'],
  revise: ['Taking your note…', 'Rewriting both lengths…', 'Keeping what worked…'],
  banner: ['Painting the companion banner…', 'Setting your logo…', 'Mixing brand color…'],
  'voice-profile': ['Casting the read…', 'Matching voice to listener…'],
  'render-audio': ['Rolling tape…', 'Rendering the read…', 'Bouncing to MP3…', 'Filing it in the studio…'],
  voices: ['Auditioning voices…', 'Pulling three takes…'],
  'compose-bed': ['Writing the bed…', 'Finding the tempo…', 'Keeping the midrange clear…', 'Laying down the loop…'],
  'bed-prompt': ['Picking a genre…', 'Matching music to listener…'],
  tighten: ['Cutting for time…', 'Losing the adjectives…', 'Keeping the offer…'],
  extend: ['Filling the slot…', 'Adding the website…', 'Working in the phone number…'],
  default: ['Working…', 'One moment…']
};

let captionTimer = null;

/**
 * Drop a themed animated loader into an element.
 * @param {HTMLElement} el target
 * @param {string} kind job kind, used to pick the caption set
 */
export function showLoader(el, kind = 'default') {
  const keys = Object.keys(ART);
  const pick = ART[keys[Math.floor(Math.random() * keys.length)]];
  const lines = CAPTIONS[kind] || CAPTIONS.default;
  let i = 0;

  el.innerHTML = `<div class="loader">${pick()}<div class="caption" data-caption>${lines[0]}</div></div>`;
  const caption = el.querySelector('[data-caption]');

  clearInterval(captionTimer);
  captionTimer = setInterval(() => {
    i = (i + 1) % lines.length;
    if (!caption.isConnected) return clearInterval(captionTimer);
    caption.textContent = lines[i];
  }, 2600);
}

export function stopLoader() {
  clearInterval(captionTimer);
}
