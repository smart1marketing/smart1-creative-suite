# Smart 1 Creative Suite

The three creative apps and the hub dashboard as **one service at one URL**:

| Path | What lives there |
|---|---|
| `/` | The Creative Hub — clients, past creative, launch new work |
| `/embed`, `/build`, `/projects`, `/diagnostics`, `/api/*`, `/files/*` | The **Ad Builder**, at the exact routes it has always owned |
| `/radio/…` | The **Radio Studio** (its API at `/radio/api/…`) |
| `/lookup` (+ `/static`, `/data`) | The **Knack client lookup**, prebuilt |

One process serves all of it. The hub reads the ad builder's project store
and the radio library **in-process** — no internal HTTP, no tokens between
apps, nothing to fall out of sync.

## How the merge works (for future maintenance)

- `server.js` is an Express host. It mounts the hub and lookup, mounts the
  radio studio's exported Express app under `/radio`, and passes every
  other request to the ad builder's exported raw handler — so the ad
  builder's auth, rate limiting, and CSP behave byte-for-byte as before.
- `SUITE_MODE=1` is set by `server.js` before the apps load; it stops each
  app binding its own port. Run either app's folder standalone and it
  behaves exactly as it used to.
- Sign-in is shared: the hub cookie and the studio cookie are the same
  HMAC scheme signed with the same `SESSION_SECRET`, and the studio also
  accepts the hub's cookie — sign in once at `/`, and `/radio` is open.
  The ad builder's staff screens keep their own `ADMIN_TOKEN`, unchanged.
- The radio studio's client code calls `/radio/api/…`; its review links are
  built from `PUBLIC_URL` + `/radio` automatically in suite mode.
- The lookup app's prebuilt bundle expects `/static/*` and `/data/*.json`
  at the root, so the suite reserves those two prefixes for it.

`apps/ads` and `apps/radio` are full copies of the standalone apps with
those minimal hooks added. The original folders next to this one are
untouched and still deployable on their own.

## Deploying to Render

New → Blueprint, point at this folder's repo. `render.yaml` defines one
web service with one 2 GB disk:

- `OUTPUT_DIR=/var/data/ads` — ad-builder renders and project records
- `DATA_DIR=/var/data/radio` — radio projects and playlists

Fill in the `sync: false` env vars — they are the union of what the three
standalone services used, with the same names, so copy the values straight
across from the old services. Set `PUBLIC_URL` to the suite's own URL.

**Migrating existing data:** copy the old ad-builder disk's contents into
`/var/data/ads` and the old radio disk's into `/var/data/radio` (Render
shell: `scp`/`rsync`, or re-render what matters — Cloudinary holds the
permanent copies of all delivered creative). The Knack JSON needs nothing:
it is committed in `lookup/build/data/`.

**Update any embedded intake forms** on marketing sites to point at the
suite's URL (`<suite>/embed`), and give reviewers new radio links (old
review links point at the old radio service until it is retired).

## Running locally

```bash
npm install
npm run build          # compiles the ad builder (tsc + asset copy)
npm start              # http://localhost:3000
```

`npm test` runs the ad builder's 29-test suite against the real renderer.

## Refreshing the Knack data

Same flow as the standalone lookup, run from this folder:

```bash
REACT_APP_KNACK_API_KEY=xxx REACT_APP_KNACK_APP_ID=yyy npm run lookup:refresh
git add lookup/build/data/*.json && git commit -m "refresh" && git push
```

## Banner QA

Radio companion banners pass through a port of the ad builder's QA
(150 KB make-it-fit ceiling, measured pixel contrast, logo-ink check,
hierarchy, legibility floor, word budgets) — see `apps/radio/README.md`.
