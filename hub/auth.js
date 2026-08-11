/**
 * The same front door the radio studio uses: one team password, an
 * HMAC-signed session cookie, timing-safe comparison. Not a user system —
 * the right weight for a handful of staff.
 */
import crypto from 'crypto';
import { config } from './config.js';

const COOKIE = 's1hub_session';

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
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.auth.sessionDays * 86400}${secure}`
  );
  return { who, expiresAt: new Date(exp).toISOString() };
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export const currentSession = (req) => unpack(readCookie(req, COOKIE));

export function requireTeam(req, res, next) {
  if (!config.auth.password) return next(); // open — warned at boot
  const session = currentSession(req);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Sign in to use the hub.', needsLogin: true });
  }
  req.session = session;
  next();
}

export function checkPassword(supplied) {
  const expected = config.auth.password;
  if (!expected) return true;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
