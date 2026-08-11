import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, missingKeys, APP_VERSION } from './config.js';
import { api } from './routes/api.js';
import { store, log } from './services/store.js';
import { ffmpegAvailable } from './services/audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const publicDir = path.join(__dirname, '..', 'public');

app.use(cors({ origin: true, credentials: true }));
// Headroom for base64 logo and music-bed uploads.
app.use(express.json({ limit: '30mb' }));
// Allow the studio to be framed by the marketing site when EMBED_ORIGIN is set.
// Left unset, the default deny keeps it from being framed by anyone.
app.use((req, res, next) => {
  const origin = config.embedOrigin;
  res.setHeader('Content-Security-Policy',
    origin ? `frame-ancestors 'self' ${origin}` : "frame-ancestors 'self'");
  next();
});

app.use(express.static(publicDir, { extensions: ['html'] }));

app.use('/api', api);

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ ok: false, error: 'No such endpoint.' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  log.error('express', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

/** Boot checks, shared by standalone and suite mode. */
export async function boot() {

  // In-memory jobs die with the process. Flag anything they left mid-flight
  // so the studio offers a retry instead of spinning forever.
  const stale = store.sweepStale();
  if (stale) console.log(`Marked ${stale} interrupted job${stale === 1 ? '' : 's'} for retry.`);

  if (!config.auth.password) {
    console.warn('WARNING: STUDIO_PASSWORD is not set. Anyone with this URL can spend your API credits.');
  }
  if (config.audio.enabled && !(await ffmpegAvailable())) {
    console.warn('ffmpeg is not runnable — spots will ship as dry voice with no bed or loudness matching.');
  }
  const missing = missingKeys();
  if (missing.length) {
    console.warn(`Missing environment variables: ${missing.join(', ')}`);
    console.warn('Open /diagnostics.html to see what still needs connecting.');
  }
}

/** Standalone mode listens; inside the Smart 1 Suite the host mounts `app`
 *  under /radio and calls boot() itself. */
if (!process.env.SUITE_MODE) {
  app.listen(config.port, async () => {
    console.log(`Smart 1 Radio Studio v${APP_VERSION} listening on :${config.port}`);
    await boot();
  });
}

export { app };
