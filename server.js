/**
 * Smart 1 Creative Suite — one service, one URL, four faces:
 *
 *   /            the Creative Hub dashboard (clients, past creative, launch)
 *   /embed,      the Ad Builder, exactly as it has always been — its routes
 *   /build, ...  stay at the root so nothing inside it had to change
 *   /radio/...   the Radio Studio, mounted under a prefix
 *   /lookup      the Knack client-lookup app (its /static and /data stay at
 *                the root because its prebuilt bundle expects them there)
 *
 * Everything runs in ONE process. The hub reads the ad builder's project
 * store and the radio library directly — no internal HTTP, no tokens.
 *
 * SUITE_MODE must be set before the apps are imported (it stops each one
 * binding its own port), which is why both imports are dynamic.
 */
process.env.SUITE_MODE = '1';

import express from 'express';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 3000);

const app = express();

/* ------------------------------------------------ hub: / and /api/hub */
const { hubRouter } = await import('./hub/router.js');
const { app: radioApp, boot: radioBoot } = await import('./apps/radio/src/server.js');
const { store: radioStore } = await import('./apps/radio/src/services/store.js');

app.use('/api/hub', express.json({ limit: '1mb' }), hubRouter({ radioStore }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------ lookup: prebuilt CRA */
// The bundle references /static/* and fetches /data/*.json absolutely, so
// those two prefixes belong to the lookup app suite-wide. Nothing else here
// uses them.
const lookupBuild = path.join(__dirname, 'lookup', 'build');
app.get(['/lookup', '/lookup/'], (_req, res) => res.sendFile(path.join(lookupBuild, 'index.html')));
app.use('/static', express.static(path.join(lookupBuild, 'static'), { immutable: true, maxAge: '30d' }));
app.use('/data', express.static(path.join(lookupBuild, 'data')));

/* ------------------------------------------------ radio: /radio/* */
app.use('/radio', radioApp);

/* ------------------------------------------------ ads: everything else */
// The ad builder keeps the root namespace it was written for (/embed, /build,
// /projects, /api/*, /files/*, /healthz ...). Its raw handler is the fallback,
// so its behaviour — auth, rate limits, CSP — is byte-for-byte what it was.
const { handleRequest } = require('./apps/ads/dist/src/server.js');
app.use((req, res) => handleRequest(req, res));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Smart 1 Creative Suite on :${PORT}`);
  console.log('  /        hub dashboard');
  console.log('  /embed   ad builder intake   /build  operator screen');
  console.log('  /radio/  radio studio        /lookup client lookup');
  await radioBoot();
  if (!(process.env.DASH_PASSWORD || process.env.STUDIO_PASSWORD)) {
    console.warn('WARNING: no DASH_PASSWORD/STUDIO_PASSWORD set — the hub and studio are open.');
  }
});
