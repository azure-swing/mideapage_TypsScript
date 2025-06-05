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
  console.log('SESSION_SECRET_KEY type:', typeof c.env.SESSION_SECRET_KEY);
  console.log('SESSION_SECRET_KEY value (first few chars, if string):', typeof c.env.SESSION_SECRET_KEY === 'string' ? c.env.SESSION_SECRET_KEY.substring(0, 5) + '...' : c.env.SESSION_SECRET_KEY);

  if (typeof c.env.SESSION_SECRET_KEY !== 'string' || c.env.SESSION_SECRET_KEY.length === 0) {
    console.error("FATAL: SESSION_SECRET_KEY is not set or is not a non-empty string!");
    // 在这种情况下，应该抛出一个更明确的错误，而不是让 sign 函数失败
    throw new Error("Server configuration error: Session secret is missing.");
  }

  const payload: JwtPayload = { loggedIn: true };
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
