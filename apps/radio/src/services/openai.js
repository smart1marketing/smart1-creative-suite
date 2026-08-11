import { config } from '../config.js';
import { log } from './store.js';
import { TONES, toneById, languageLabel } from '../catalog.js';

async function chatJSON(system, user, { maxTokens = 1800 } = {}) {
  if (!config.openai.key) throw new Error('OpenAI key is not set. Add OPENAI_API_KEY.');
  const res = await fetch(`${config.openai.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.key}`
    },
    body: JSON.stringify({
      model: config.openai.textModel,
      temperature: 0.8,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The model returned something that was not valid JSON.');
  }
}

/** Pull readable text off a page so the model can actually read the site. */
export async function readPage(url, label) {
  if (!url) return { url: '', label, ok: false, text: '', note: 'No URL provided.' };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url.startsWith('http') ? url : `https://${url}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Smart1RadioStudio/1.0 (+marketing script research)' }
    });
    clearTimeout(timeout);
    if (!res.ok) return { url, label, ok: false, text: '', note: `Page returned ${res.status}.` };
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 7000);
    return { url, label, ok: true, title: title.trim(), description: desc.trim(), text };
  } catch (err) {
    log.warn('readPage', `${url}: ${err.message}`);
    return { url, label, ok: false, text: '', note: `Couldn't reach the page (${err.message}).` };
  }
}

/**
 * Read home page + landing page + promotion notes, and come back with a
 * creative brief plus three recommended tones out of the fifteen.
 */
export async function analyzeProject({ brand, customer, historyHint = [] }) {
  const [home, landing] = await Promise.all([
    readPage(customer.homeUrl, 'Home page'),
    readPage(customer.landingUrl, 'Landing page')
  ]);

  const toneMenu = TONES.map((t) => `- ${t.id}: ${t.label} — ${t.direction}`).join('\n');
  const history = historyHint.length
    ? `\nTONES THAT HAVE WORKED FOR THIS AGENCY'S CLIENTS BEFORE (weigh these up, but only where they genuinely fit): ${historyHint.join(', ')}`
    : '';

  const result = await chatJSON(
    `You are a senior radio copy strategist at Smart 1 Marketing, a digital agency that buys streaming radio on Pandora, Spotify and iHeart. You read a client's site and their promotion, then brief the creative team. You are specific and you never invent facts, offers, prices or claims that are not in the source material. Reply as JSON only.`,
    `CLIENT
Company: ${brand?.name || customer.company || customer.customerName}
Industry: ${brand?.industry || 'unknown'}
Location: ${brand?.location || 'unknown'}
Brand description: ${brand?.description || 'n/a'}

HOME PAGE (${home.url || 'none'})
${home.ok ? `${home.title}\n${home.description}\n${home.text}` : home.note}

LANDING PAGE (${landing.url || 'none'})
${landing.ok ? `${landing.title}\n${landing.description}\n${landing.text}` : landing.note}

PROMOTION DETAILS FROM THE CLIENT
${customer.promotion || 'None supplied.'}

REQUIRED DISCLAIMER (must be read verbatim inside the spot)
${customer.disclaimer || 'None.'}

TONE MENU
${toneMenu}${history}

Return JSON shaped exactly like:
{
  "summary": "3-4 sentences on what this business actually does and who buys from them",
  "audience": "one sentence on the listener we are targeting",
  "offer": "the promotion in one plain sentence, or 'No specific offer supplied' ",
  "differentiators": ["3-5 short proof points pulled from the pages"],
  "callToAction": "the single action the listener should take",
  "mustSay": ["names, phone numbers, URLs or legal wording that must appear verbatim"],
  "avoid": ["2-4 things the script should not claim or say"],
  "recommendedTones": [{"toneId":"one of the menu ids","why":"one sentence tied to this client"}]
}
Give exactly 3 recommendedTones, best first.`,
    { maxTokens: 1600 }
  );

  return { ...result, sources: { home: { url: home.url, ok: home.ok, note: home.note || null }, landing: { url: landing.url, ok: landing.ok, note: landing.note || null } } };
}

/** Write a matched 15-second and 30-second pair in one call so they share a hook. */
export async function writeScripts({ analysis, brand, customer, toneId, revisionNote, previous }) {
  const disclaimer = String(customer.disclaimer || '').trim();
  const lang = languageLabel(customer.language || 'en');
  const nonEnglish = (customer.language || 'en') !== 'en';
  const tone = toneById(toneId);
  if (!tone) throw new Error('Unknown tone.');

  const revisionBlock = revisionNote
    ? `\nThe client reviewed the previous draft and asked for this change:\n"${revisionNote}"\n\nPREVIOUS DRAFT\n15s: ${previous?.fifteen?.script || ''}\n30s: ${previous?.thirty?.script || ''}\n\nRewrite both lengths honoring the request. Keep everything the client did not object to.`
    : '';

  return chatJSON(
    `You write streaming-radio commercials for Smart 1 Marketing. Radio is heard, not read: write for the ear.${nonEnglish ? ` WRITE THE SCRIPTS ENTIRELY IN ${lang.toUpperCase()}. Write as a native ${lang} copywriter would — idiomatic, not translated. Keep the brand name, any web address and any required disclaimer exactly as supplied, even if they are English. Word-count targets are counted in ${lang} words.` : ''} Rules you never break — the brand name is said at least twice in a :30 and at least once in a :15; the call to action is the last thing heard; you never invent an offer, price, discount, guarantee or statistic that was not supplied; you never write sound effects the client did not ask for; a :15 runs 40-46 words and a :30 runs 85-95 words — synthetic voices read fast, and copy under those counts leaves dead air at the end of the slot, so write to the TOP of the range rather than the bottom. Always say the website. If the copy still feels short, add the phone number, then a further proof point — never leave the spot under length. Reply as JSON only.`,
    `TONE: ${tone.label} — ${tone.direction}

BRIEF
Business: ${brand?.name || customer.company || customer.customerName}
What they do: ${analysis?.summary || ''}
Listener: ${analysis?.audience || ''}
Offer: ${analysis?.offer || ''}
Proof points: ${(analysis?.differentiators || []).join(' | ')}
Call to action: ${analysis?.callToAction || ''}
Must say verbatim: ${(analysis?.mustSay || []).join(' | ') || 'nothing specific'}
Do not say: ${(analysis?.avoid || []).join(' | ') || 'nothing specific'}
Client's own promotion notes: ${customer.promotion || 'none'}
Website — say this out loud in every spot: ${customer.landingUrl || customer.homeUrl || 'none supplied'}
Phone number — use it to fill time if the copy runs short: ${customer.phone || 'none supplied'}
${disclaimer ? `\nREQUIRED DISCLAIMER — reproduce word for word as the last thing before the call to action, in BOTH lengths. It counts toward the word budget, so write the rest shorter to make room:\n"${disclaimer}"\n` : ''}${revisionBlock}

Return JSON:
{
  "hook": "the shared opening idea in a few words",
  "fifteen": {"script":"the :15 read, plain spoken text only","wordCount":0,"estimatedSeconds":15,"notes":"one line of direction for the voice talent"},
  "thirty": {"script":"the :30 read, plain spoken text only","wordCount":0,"estimatedSeconds":30,"notes":"one line of direction for the voice talent"}
}
The script fields contain only words to be spoken. No labels, no "VO:", no timestamps, no stage directions.`,
    { maxTokens: 1400 }
  );
}

/** Suggested voice profile, generated in the background while the client picks. */
export async function suggestVoiceProfile({ analysis, customer, toneIds }) {
  const tones = toneIds.map((t) => toneById(t)?.label).filter(Boolean).join(', ');
  const lang = languageLabel(customer?.language || 'en');
  return chatJSON(
    `You are a casting director for radio voiceover. You recommend a voice, not a person. Reply as JSON only.`,
    `The spot will be recorded in ${lang}; recommend an accent a native ${lang} listener would trust.
Tones selected: ${tones}
Business: ${analysis?.summary || customer.company || customer.customerName}
Listener: ${analysis?.audience || ''}
Offer: ${analysis?.offer || ''}

Return JSON:
{
  "recommendation": {"gender":"female|male|neutral|any","age":"young|middle_aged|old|any","accent":"american|british|australian|transatlantic|any","energy":"laid_back|conversational|energetic|explosive","delivery":"announcer|narrator|best_friend|spokesperson|character"},
  "why": "two sentences on why this voice suits this listener",
  "searchTerms": ["3-6 words a voice library would tag this voice with"]
}`,
    { maxTokens: 600 }
  );
}

/** Banner words: a 3-4 word campaign headline and one supporting line.
 *  `shorten` is the QA's machine-readable fix ({ headline: n, support: n })
 *  — the same instruction loop the display-ad builder uses, where an
 *  over-budget line goes back to the copywriter rather than being clipped. */
export async function bannerCopy({ analysis, brand, customer, toneId, shorten = null }) {
  const tone = toneById(toneId);
  const lang = languageLabel(customer?.language || 'en');
  const shortenNote = shorten
    ? `\nIMPORTANT: A previous attempt was over budget. The headline must be AT MOST ${shorten.headline || 4} words and the support line AT MOST ${shorten.support || 6} words. Count them before answering.`
    : '';
  return chatJSON(
    `You write companion banner copy for streaming audio ads, in ${lang}. A listener glances at this on a phone for two or three seconds while the ad plays, so it carries almost no words. The headline is a THREE OR FOUR WORD summary of what the campaign is — not a slogan, not a sentence, no punctuation at the end. Beneath it goes one short line carrying the offer, the price or the deadline. Reply as JSON only.${shortenNote}`,
    `Tone: ${tone.label} — ${tone.direction}
Business: ${brand?.name || customer.company || customer.customerName}
Campaign: ${customer.projectName || ''}
Offer: ${analysis?.offer || customer.promotion || ''}
Spoken call to action: ${analysis?.callToAction || ''}

Return JSON:
{
  "headline": "3-4 words summarising the campaign, title case, no trailing punctuation",
  "support": "3-6 words — the offer, price or deadline",
  "cta": "same as headline, for compatibility"
}

The headline must be 4 words or fewer. Count them before answering. Good examples:
"Fall Furnace Tune-Up", "Free Roof Inspection", "Spring Drain Special", "Winter Tire Event".
Bad examples: "Get your furnace checked today before winter" (a sentence), "Comfort You Can Trust" (a slogan, says nothing about the campaign).`,
    { maxTokens: 300 }
  );
}

/** Generate the banner background art with the image model. */
export async function bannerArt({ brand, toneId, headline, analysis }) {
  if (!config.openai.key) throw new Error('OpenAI key is not set.');
  const tone = toneById(toneId);
  const palette = (brand?.colors || []).slice(0, 3).map((c) => c.hex).join(', ') || 'deep navy, warm orange';

  const subject = [
    analysis?.summary ? `The business: ${analysis.summary}` : '',
    analysis?.audience ? `The listener: ${analysis.audience}` : '',
    brand?.industry ? `Industry: ${brand.industry}` : ''
  ].filter(Boolean).join(' ');

  const prompt = `A background graphic for a streaming-audio companion banner, 
evoking the subject of the radio commercial it accompanies. ${subject}
Mood, matching the tone of the script: ${tone.bannerMood}.
Colour palette: ${palette}.

COMPOSITION IS CRITICAL — type and a logo are placed on top afterwards:
- Keep the top fifth calm and uncluttered; a logo sits there.
- Keep the central band calm and uncluttered; large type sits there.
- Keep the bottom strip calm and uncluttered; a URL bar sits there.
- Put any visual interest, texture or subject matter in the corners and along the left and right edges.
- Mid-to-dark overall so white text reads clearly on it. Avoid bright or busy areas in the centre.

Absolutely no text, letters, words, numbers, logos, watermarks, signage or 
readable symbols anywhere in the image. No human faces. Flat modern 
advertising art direction, clean edges, no borders or frames.`;

  const res = await fetch(`${config.openai.base}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.key}` },
    body: JSON.stringify({
      model: config.openai.imageModel,
      prompt,
      size: '1024x1024',
      n: 1
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI images ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const item = data.data?.[0];
  if (item?.b64_json) return { b64: item.b64_json, prompt, headline };
  if (item?.url) {
    const img = await fetch(item.url);
    const buf = Buffer.from(await img.arrayBuffer());
    return { b64: buf.toString('base64'), prompt, headline };
  }
  throw new Error('The image model returned no image.');
}

/**
 * The read came back over the slot. Cut words without losing the offer, the
 * brand name, the call to action or any required disclaimer.
 */
export async function tightenScript({ script, seconds, trimWords, toneId, analysis, customer }) {
  const tone = toneById(toneId);
  const lang = languageLabel(customer?.language || 'en');
  const disclaimer = String(customer?.disclaimer || '').trim();
  const target = Math.max(8, (script || '').split(/\s+/).filter(Boolean).length - trimWords);

  return chatJSON(
    `You are a radio copy editor working in ${lang}. Your rewrite must stay in ${lang}. You cut for time. You never drop the brand name, the offer, the call to action or a required disclaimer — you cut adjectives, subordinate clauses and setup instead. Reply as JSON only.`,
    `This :${seconds} read came in ${trimWords} word${trimWords === 1 ? '' : 's'} too long for the slot.

TONE: ${tone?.label || ''} — keep it.
Brand name and call to action are mandatory: ${analysis?.callToAction || ''}
${disclaimer ? `This disclaimer must survive word for word: "${disclaimer}"` : ''}

CURRENT SCRIPT (${(script || '').split(/\s+/).filter(Boolean).length} words)
${script}

Rewrite it at roughly ${target} words. Same meaning, same tone, fewer words.

Return JSON: {"script":"the tightened read, spoken words only","wordCount":0,"whatWentAndWhy":"one sentence"}`,
    { maxTokens: 700 }
  );
}

/** Turn the tone and the brief into a music-generation prompt for a bed. */
export async function bedPrompt({ analysis, customer, brand, toneId }) {
  const tone = toneById(toneId);
  return chatJSON(
    `You write prompts for an AI music generator. The output is a background bed for a radio commercial, so it must never compete with a speaking voice: no vocals, moderate dynamics, uncluttered midrange. You describe genre, instrumentation, tempo and mood in plain concrete terms. Reply as JSON only.`,
    `Tone of the spot: ${tone?.label || ''} — ${tone?.direction || ''}
Business: ${brand?.name || customer?.company || customer?.customerName || ''}
Industry: ${brand?.industry || 'unknown'}
Listener: ${analysis?.audience || ''}
Offer: ${analysis?.offer || ''}

Return JSON:
{
  "prompt": "one or two sentences describing the bed — genre, instruments, tempo in BPM, mood",
  "why": "one short sentence on why it fits this spot and this listener",
  "alternates": ["two other one-line directions worth trying"]
}`,
    { maxTokens: 450 }
  );
}

/**
 * The read came back under the slot. Lengthen it without padding: the
 * website, the phone number and real proof points first, waffle never.
 */
export async function extendScript({ script, seconds, addWords, toneId, analysis, customer }) {
  const tone = toneById(toneId);
  const lang = languageLabel(customer?.language || 'en');
  const disclaimer = String(customer?.disclaimer || '').trim();
  const current = (script || '').split(/\s+/).filter(Boolean).length;
  const target = current + addWords;

  return chatJSON(
    `You are a radio copy editor working in ${lang}. You lengthen copy that came in under its slot. You add substance, never filler: the website said aloud, the phone number, a concrete proof point, a second reason to act. You never repeat a sentence, never add empty adjectives, and never invent an offer, price or claim that was not supplied. Reply as JSON only.`,
    `This :${seconds} read came back ${Math.round(addWords / 3.1 * 10) / 10} seconds short, leaving dead air.

TONE: ${tone?.label || ''} — keep it.
Website, say it aloud: ${customer?.landingUrl || customer?.homeUrl || 'none supplied'}
Phone number, use it if needed: ${customer?.phone || 'none supplied'}
Proof points available: ${(analysis?.differentiators || []).join(' | ') || 'none'}
Call to action, must stay last: ${analysis?.callToAction || ''}
${disclaimer ? `This disclaimer must stay word for word: "${disclaimer}"` : ''}

CURRENT SCRIPT (${current} words)
${script}

Rewrite it at roughly ${target} words. Same meaning and tone, more substance. Priority for the extra words: 1) the website spoken clearly, 2) the phone number, 3) one more concrete proof point.

Return JSON: {"script":"the lengthened read, spoken words only","wordCount":0,"whatWasAdded":"one sentence"}`,
    { maxTokens: 800 }
  );
}
