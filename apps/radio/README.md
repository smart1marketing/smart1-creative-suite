# Smart 1 Radio Studio

An AI radio-commercial builder for Smart 1 Marketing. A client walks through seven stations — intake, brief, scripts, casting, listening room, playlist, approval — and comes out the other side with recorded :15 and :30 streaming-radio spots, matching companion banners, everything archived in Cloudinary, and an opportunity created in GoHighLevel.

## The seven stations

| Dial | Station | What happens |
|---|---|---|
| 88.1 | **Setup** | Client, email, Smart 1 team member, project, home page, landing page, promotion. Brandfetch fills in the business name, logo and colors from the web address. Optionally start from a previous playlist's settings. |
| 91.3 | **Brief** | OpenAI reads the home page, the landing page and the promotion notes *while* the client picks a tone from fifteen radio buttons. Three tones come back marked as recommendations. |
| 94.7 | **Copy** | A matched :15 and :30 pair, written to the clock. Approve, reject, or say what to change — a change rewrites both lengths together. Companion-banner artwork and a casting suggestion start generating in the background the moment a tone is chosen. |
| 98.5 | **Cast** | Voice characteristics as radio buttons (voice, age, accent, energy, delivery), pre-selected from the AI's casting suggestion. ElevenLabs returns three matching voices with previews. Assign one per spot, or paste a specific ElevenLabs voice ID. |
| 101.9 | **Booth** | The listening room. One spot at a time: play the audio, look at the companion banner, approve it or try a different voice. Approved spots go to the playlist. |
| 105.3 | **Package** | Everything filed in Cloudinary under `client / project-date`, including the logo. The full project posts to GoHighLevel as an opportunity. |
| 108.1 | **Send** | Choose a reviewer, add comments, and the playlist goes out through the GHL approval webhook with every audio and banner link. |

Two more pages sit outside the wizard:

- **`/library.html`** — every saved playlist, searchable by client, business, project or team member. Expand any project to hear the spots.
- **`/diagnostics.html`** — live checks against all five services, a list of anything missing from the environment, webhook test buttons, and a rolling error log.

## The hardening pass

Fourteen things were added after the first build, in three groups.

**So it doesn't break**

- **Session recovery.** The project id lives in the URL (`#p=prj_…&s=3&t=upbeat`). Refresh, drop signal, close the tab — reopening the link puts you back on the same station with the same project. A link to a project that no longer exists falls back to a fresh start rather than an error.
- **A front door.** `STUDIO_PASSWORD` gates every `/api` route behind an HMAC-signed session cookie. Reviewers never need it: their link carries a per-project token instead, and that token only opens the read-only review page.
- **Runtime checking.** A `:15` that lands at 16.8s gets rejected by the ad server. Every render is measured; anything over the slot is flagged with how many words to cut, and one button rewrites it that much shorter and re-records. A read that runs long is **never** trimmed — that would clip a word — it comes back flagged instead.

**So it sounds like a commercial**

- **A pronunciation pass.** Phone numbers, web addresses, emails, prices, percentages, dates and everyday abbreviations are rewritten into spoken words before ElevenLabs sees them. `614-536-0768` becomes "six one four, five three six, zero seven six eight." Every substitution is shown to the client under "How it will be read," and any word can be overridden per project — useful for a business name TTS keeps mangling.
- **Music beds, three ways.** Pick from the library, compose one with Eleven Music, or upload a track you licensed. Composed beds are constrained to instrumental with an open midrange so they never fight the read. **Mastering:** ffmpeg lays the bed underneath, ducks it out of the way of the read with a sidechain compressor, masters to −16 LUFS with a −1.5 dBTP ceiling, and pads to the exact slot length. Beds come from your own Cloudinary folder, so nothing unlicensed ships. If ffmpeg or the bed fails, the dry take still goes through — mastering never loses a render.
- **Direct editing.** Type into the script with a live words-to-clock meter that turns red as you cross the slot. A one-word change no longer needs a full regenerate.

**So the loop closes**

- **A real review page.** `/review.html` gives the client a branded page with every spot, script and banner, plus Approve and Request changes. Their decision comes back into the project, into the library, and out to a GHL webhook. Previously the approval went out and nothing ever came back.
- **Banner click-through.** The landing page URL now rides along on the banner and in the GHL payload.

**Smaller**

- One voice across the campaign by default, with an opt-out for a deliberately different character.
- Logo upload when Brandfetch has no record, so banners still get the client's mark.
- A disclaimer field that is read verbatim and counted against the word budget, so the rest is written shorter to make room.
- Full version history — every draft, rewrite, tighten and hand edit is kept and restorable.
- Interrupted jobs are marked on boot, so a restart mid-render shows a retry button instead of spinning forever.
- Approved tones and shipped voices are tallied; proven ones get marked in the picker and folded into the recommendations.

## Running it locally

```bash
npm install
cp .env.example .env     # then fill in the keys
npm run dev              # http://localhost:3000
```

Open `/diagnostics.html` first. Anything red there will fail mid-build.

## Environment

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com. Needs access to the chat model and `gpt-image-1` for banners. |
| `BRANDFETCH_API_KEY` | developers.brandfetch.com, Brand API. |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profile → API key. |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | Cloudinary console dashboard. |
| `GHL_OPPORTUNITY_WEBHOOK_URL` | GoHighLevel → Automation → Workflow → Inbound Webhook trigger. |
| `GHL_APPROVAL_WEBHOOK_URL` | A second inbound webhook, wired to an email/notification action. |
| `GHL_APPROVAL_RESPONSE_WEBHOOK_URL` | Optional third webhook, fired when the client approves or asks for changes. Falls back to the approval webhook. |
| `STUDIO_PASSWORD` | Pick one. Without it anyone with the URL can spend your API credits. |
| `SESSION_SECRET` | Any long random string. Render generates one for you via the blueprint. |
| `PUBLIC_URL` | Your Render URL. Review links are built from it. |

Optional: `OPENAI_MODEL`, `OPENAI_IMAGE_MODEL`, `ELEVENLABS_MODEL`, `CLOUDINARY_ROOT_FOLDER`, `CLOUDINARY_BED_FOLDER`, `AUDIO_POST_ENABLED`, `AUDIO_TARGET_LUFS`, `AUDIO_TRUE_PEAK`, `AUDIO_BED_DB`, `SESSION_DAYS`, `DATA_DIR`, `PORT`.

### Music beds

The recording studio offers three sources, as tabs:

**Library** — everything already in the Cloudinary folder named by `CLOUDINARY_BED_FOLDER`, including anything composed or uploaded previously. Beds are reusable across clients.

**Compose one** — Eleven Music writes an instrumental bed to order (`POST /v1/music`). The model first suggests a prompt based on the tone and the listener, with two alternates to click. Every generated prompt is wrapped with hard constraints before it is sent: fully instrumental, no vocals or vocal samples, steady energy for looping, and an uncluttered midrange so the read sits on top rather than under. Default length is 35 seconds, which covers a :30 with padding.

**Upload a track** — MP3, WAV, M4A or OGG up to 20 MB, for music the agency already licensed or the client supplied.

All three land in the same Cloudinary folder and are tagged by origin, so the library shows whether a bed was composed, uploaded or pre-existing.

On licensing: Eleven Music is trained on licensed material and generations are cleared for broad commercial use on paid plans, with film, TV and large studio game rights requiring Enterprise. Streaming radio spots fall inside the standard commercial grant, but check the current Eleven Music terms for your own use. Nothing ships with the app, so you never distribute music you do not have rights to.

## Deploying to Render from GitHub

1. Push this folder to a GitHub repo.
2. In Render, **New → Blueprint**, point it at the repo. `render.yaml` defines the service, the health check and a 1 GB disk mounted at `/var/data`.
3. Fill in the secret environment variables in the Render dashboard (the ones marked `sync: false`).
4. Deploy. Render runs `npm install` then `npm start`.

The disk matters: project and playlist records live in a JSON file at `DATA_DIR`. Without a mounted disk, a redeploy wipes the library. For heavier use, swap `src/services/store.js` for Postgres — every other file talks to it through the same four methods (`create`, `get`, `update`, `library`).

## What GoHighLevel receives

Both webhooks get the same flattened payload, so one set of custom fields covers both:

```jsonc
{
  "source": "Smart 1 Radio Studio",
  "name": "Dana Whitfield",
  "email": "dana@example.com",
  "company": "Greenwald Realty",
  "opportunityName": "Greenwald Realty — Fall Push",
  "projectName": "Fall Push",
  "teamMember": "Sara Cordle",
  "homeUrl": "...", "landingUrl": "...", "promotionDetails": "...",
  "tones": "upbeat, warm",
  "spotCount": 4,
  "cloudinaryFolder": "smart1-radio-studio/greenwald-realty/fall-push-2026-08-02",
  "audioUrls": ["https://res.cloudinary.com/..."],
  "bannerUrls": ["https://res.cloudinary.com/..."],
  "commercials": [{ "tone": "...", "length": "30s", "script": "...", "voice": "...", "audioUrl": "...", "bannerUrl": "..." }]
}
```

The approval webhook adds `approverName`, `approverEmail`, `approvalComments` and a `reviewLinks` array.

## How the background work is wired

Anything slow returns a job id immediately and the browser polls `/api/jobs/:id` while a themed animated SVG plays — a broadcast tower, a turning record, a VU needle, tape reels, a waveform, a live mic. The captions change with the kind of work being done.

Three things deliberately run while the client is doing something else:

- The **site review** runs while they choose a tone.
- The **companion banner and casting suggestion** start the instant a tone is picked, so they're ready by the studio.
- The **audio renders** start when voices are assigned; the client walks into the listening room while the first spot is still bouncing.

## Notes and limits

- ffmpeg ships as a static binary via the `ffmpeg-static` package, so Render's plain Node runtime works with no Docker image.
- The pronunciation pass reads `St.` as Street rather than Saint, and `Dr.` as Doctor only when a capitalized name follows. Both are overridable per project.
- Reviewer tokens do not expire. Rotating one means deleting `reviewToken` from the project record.

- Cloudinary stores audio under the `video` resource type — that's normal, not a bug.
- ElevenLabs voice matching scores the library's own labels. A small account with few voices will return weaker matches; adding voices to the account improves it immediately.
- Banner artwork is generated once per tone, not once per spot, so a :15 and :30 in the same tone share a banner.
- The image model is told not to render text; the headline, subline, CTA and the client's logo are composited by Cloudinary afterward, which keeps the type crisp and the logo exact.

## Banner QA — the ad builder's rules, applied here

Companion banners now pass through the same QA gate as the display-ad
builder (`src/services/bannerQa.js`, a port of smart1-ad-builder's
`qa.ts` + `image-budget.ts`):

- **150 KB ceiling, "make it fit" not "reject":** every delivered size is
  fetched and weighed; an overweight banner is rebuilt at stepped-down
  quality until it fits.
- **Contrast, measured:** the artwork+scrim render is fetched and its real
  pixels sampled under each text band — not just the predicted colour
  maths. A brand accent that can't read on the dark panel is lightened
  (and the change reported); an accent bar that can't letter itself hands
  the web address to the dark panel.
- **Logo ink vs plate**, ignoring transparent padding — a white logo on a
  white plate gets flagged.
- **Hierarchy** (headline ≥ 1.4x the support line — enforced by
  construction and verified), **legibility** (11px delivery floor),
  **safe area**, and **word budgets** (5-word headline, 8-word support;
  over-budget copy goes back to the copywriter with a hard cap before it
  is ever clamped).

The verdict and findings ship on the banner (`banner.qa`) and are shown in
the listening room under each banner: one verdict chip, then only the
findings that need eyes.

The studio also accepts `#prefill=<base64url JSON>` (`company`, `homeUrl`,
`customerName`, `email`, `projectName`) so the Creative Hub can open
Station 88.1 with the client already filled in.
