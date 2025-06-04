import { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { Env } from './types';

const COOKIE_NAME = 'auth_session';
const LOGIN_PATH = '/login'; // Make sure this route exists in Hono

interface JwtPayload {
  loggedIn: boolean;
  exp?: number; // Optional: JWT expiration
}

export async function generateJwt(c: Context<{ Bindings: Env }>) {
  const payload: JwtPayload = { loggedIn: true };
  // Optional: Add expiration (e.g., 7 days)
  // payload.exp = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
  const token = await sign(payload, c.env.SESSION_SECRET_KEY);
  return token;
}

export async function verifyJwt(c: Context<{ Bindings: Env }>, token: string): Promise<JwtPayload | null> {
  try {
    const decoded = await verify(token, c.env.SESSION_SECRET_KEY);
    return decoded as JwtPayload;
  } catch (e) {
    console.error('JWT verification failed:', e);
    return null;
  }
}

export async function requireLogin(c: Context<{ Bindings: Env }>, next: Next) {
  const allowedPaths = [LOGIN_PATH, '/login', '/static/', '/favicon.ico']; // Add paths that don't require login
  const path = new URL(c.req.url).pathname;

  if (allowedPaths.some(allowedPath => path.startsWith(allowedPath))) {
    return next();
  }

  const token = getCookie(c, COOKIE_NAME);
  if (!token) {
    if (path.startsWith('/api_movies/') || path.startsWith('/api/')) {
      return c.json({ error: 'Unauthorized', message: 'Authentication required.' }, 401);
    }
    // Store intended URL before redirecting (optional, depends on frontend handling)
    // c.cookie('next_url', path, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    return c.redirect(LOGIN_PATH, 307);
  }

  const payload = await verifyJwt(c, token);
  if (!payload || !payload.loggedIn) {
    deleteCookie(c, COOKIE_NAME, { path: '/' });
    if (path.startsWith('/api_movies/') || path.startsWith('/api/')) {
      return c.json({ error: 'Unauthorized', message: 'Invalid session.' }, 401);
    }
    return c.redirect(LOGIN_PATH, 307);
  }

  // If JWT is valid, proceed
  c.set('userPayload', payload); // Optional: make payload available to handlers
  await next();
}

export function getClientIp(c: Context) : string {
    return c.req.raw.headers.get('CF-Connecting-IP') || 
           c.req.raw.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 
           'Unknown IP';
}
