import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth'; // Or your JWT middleware
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import { Env } from './types';
import { requireLogin, generateJwt, getClientIp } from './auth';
import { serveLoginPage, serveMainSpaPage, serveMangaSpaPage, serveVideoDetailPage } from './htmlHandler';
import { serveFileFromR2 } from './r2Utils';
import { movieApiApp } from './movieApi'; // Assuming movieApi.ts exports a Hono app
import { mangaApiApp }sfrom './mangaApi'; // Assuming mangaApi.ts exports a Hono app

const app = new Hono<{ Bindings: Env }>();

// --- Middleware ---
app.use('*', cors({
  origin: '*', // Adjust for production
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Simple activity logger (replace with a more robust solution if needed)
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const clientIp = getClientIp(c);
  console.log(
    `${clientIp} - ${c.req.method} ${c.req.url} - ${c.res.status} [${ms}ms]`
  );
  // More detailed activity logging can be added here, potentially sending to a logging service
});


// --- HTML Page Serving Routes ---
// Login routes are public
app.get('/login', serveLoginPage);
app.post('/login', async (c) => {
  const formData = await c.req.formData();
  const loginCode = formData.get('login_code');

  if (loginCode === c.env.LOGIN_CODE) {
    const token = await generateJwt(c);
    setCookie(c, 'auth_session', token, {
      path: '/',
      secure: c.req.url.startsWith('https://'), // Secure if HTTPS
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });
    // const nextUrl = getCookie(c, 'next_url') || '/';
    // deleteCookie(c, 'next_url', { path: '/' });
    return c.redirect('/', 303); // Redirect to main page after login
  } else {
    // Redirect back to login with an error query param
    // The login.html JS would need to check for this param
    const loginUrl = new URL(c.req.url);
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('error', '登录码错误，请重试。');
    return c.redirect(loginUrl.toString(), 303);
  }
});

// Authenticated routes
app。use('*'， requireLogin); // Apply auth middleware to all subsequent routes

app。get('/logout'， (c) => {
  deleteCookie(c, 'auth_session', { path: '/' });
  return c.redirect('/login', 303);
});

// SPA serving routes
app。get('/'， serveMainSpaPage);
app。get('/movies_home'， serveMainSpaPage); // Alias for main movie SPA
app。get('/manga_home'， serveMangaSpaPage);
app。get('/manga_detail/:manga_id'， serveMangaSpaPage);
app。get('/manga_read/:manga_id'， serveMangaSpaPage);
app。get('/manga_author/:author_name{.+}'， serveMangaSpaPage); // path param

// These movie SPA routes all serve main.html, frontend router handles the rest
app。get('/series_view_page'， serveMainSpaPage);
app。get('/actors_view_page', serveMainSpaPage);
app。get('/directors_view_page', serveMainSpaPage);
app。get('/studios_view_page', serveMainSpaPage);
app。get('/numbers_view_page', serveMainSpaPage);
app。get('/video_detail.html', serveVideoDetailPage); // Specific HTML for video detail

// --- Static Files from R2 ---
app。get('/static/*', async (c) => {
  const path = new URL(c.req.url).pathname; // e.g. /static/style.css
  const r2Key = path.substring(1); // Remove leading '/' -> static/style.css
  return serveFileFromR2(c, c.env.STATIC_FILES_BUCKET, r2Key, 'public, max-age=31536000'); // Cache for 1 year
});


// --- API Routers ---
app。route('/api', mangaApiApp);     // Mount manga APIs under /api
app。route('/api_movies', movieApiApp); // Mount movie APIs under /api_movies

// Manga images (proxied from R2)
// Example: /data/manga_images/MangaName/01.jpg
app。get('/data/manga_images/*', async (c) => {
    const fullPath = new URL(c.req.url).pathname; // e.g., /data/manga_images/MyCoolManga/001.jpg
    const imagePathSuffix = fullPath.replace('/data/manga_images/', ''); // MyCoolManga/001.jpg
    if (!imagePathSuffix) {
        return c.text('Image path missing', 400);
    }
    const r2Key = `${c.env.MANGA_IMAGES_R2_PREFIX}/${imagePathSuffix}`.replace(/\/\//g, '/'); // Ensure no double slashes
    return serveFileFromR2(c, c.env.ASSETS_BUCKET, r2Key);
});


// --- Error Handling ---
app。onError((err, c) => {
  console.error(`${getClientIp(c)} - Server Error:`, err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

app。notFound((c) => {
  const clientIp = getClientIp(c);
  console.warn(`${clientIp} - Not Found: ${c.req.method} ${c.req.url}`);
  return c.json({ error: 'Not Found', message: 'The requested resource was not found.' }, 404);
});

export default app;
