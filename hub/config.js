import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Hub-side configuration. In the suite the hub reads everything in-process —
 * there are no upstream URLs or tokens, only file locations shared with the
 * two build apps.
 */
export const config = {
  root: ROOT,

  auth: {
    /** One shared team password for the whole suite front door. Falls back to
     *  the studio password so one env var can guard both. Unset = open. */
    password: process.env.DASH_PASSWORD || process.env.STUDIO_PASSWORD || '',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    sessionDays: Number(process.env.SESSION_DAYS || 14),
  },

  /** Where the ad builder writes projects — the same OUTPUT_DIR it uses. */
  adsOutDir: process.env.OUTPUT_DIR || path.join(ROOT, 'apps', 'ads', 'out'),

  /** The Knack exports the lookup app reads, committed into the repo. */
  lookupDataDir: path.join(ROOT, 'lookup', 'build', 'data'),
};
