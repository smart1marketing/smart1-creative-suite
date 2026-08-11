import crypto from 'crypto';
import { config } from '../config.js';

const COOKIE = 's1_session';

const sign = (value) =>
  crypto.createHmac('sha256', config.auth.secret).update(value).digest('base64url');

function pack(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function unpack(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function issueSession(res, who) {
  const exp = Date.now() + config.auth.sessionDays * 86400000;
  const token = pack({ who, exp });
  const sameSite = config.auth.sameSite;
  // SameSite=None is meaningless without Secure, and browsers drop it.
  const secure = (sameSite.toLowerCase() === 'none' || process.env.NODE_ENV === 'production') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${config.auth.sessionDays * 86400}${secure}`
  );
  return { who, expiresAt: new Date(exp).toISOString() };
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=${config.auth.sameSite}; Path=/; Max-Age=0`);
}

/**
 * The studio's own cookie, or — inside the Smart 1 Suite — the hub's.
 * Both are the same HMAC scheme signed with the same SESSION_SECRET, so a
 * team member who signed in at the hub is already signed in here.
 */
export const currentSession = (req) =>
  unpack(readCookie(req, COOKIE)) ?? unpack(readCookie(req, 's1hub_session'));

/**
 * Everything under /api needs a team session, except the login endpoints and
 * the reviewer routes, which authenticate with a per-project token instead.
 */
export function requireTeam(req, res, next) {
  // No password configured means the studio is open — loud warning at boot.
  if (!config.auth.password) return next();
  const session = currentSession(req);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Sign in to use the studio.', needsLogin: true });
  }
  req.session = session;
  next();
}

/* ---------- reviewer tokens ---------- */

export const newReviewToken = () => crypto.randomBytes(18).toString('base64url');

export const reviewLink = (project) => {
  const base = config.publicUrl || '';
  return `${base}/review.html#${project.projectId}.${project.reviewToken}`;
};

/** Constant-time compare of a reviewer's token against the project's. */
export function checkReviewToken(project, token) {
  if (!project?.reviewToken || !token) return false;
  const a = Buffer.from(String(project.reviewToken));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
