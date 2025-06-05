// src/index.ts
import { Hono } from 'hono';                // Hono 主模块
import { HTTPException } from 'hono/http-exception'; // 新的导入方式 for HTTPError
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import { Env } from './types';
import { requireLogin, generateJwt, getClientIp } from './auth';
import {
  serveLoginPage,
  serveMainSpaPage,
  serveMangaSpaPage,
  serveVideoDetailPage
} from './htmlHandler';
import { serveFileFromR2 } from './r2Utils';
import { movieApiApp } from './movieApi';
import { mangaApiApp } from './mangaApi';

// Node.js built-in modules (should ideally be removed if not strictly for local dev with specific shims)
// For Cloudflare Workers, direct use of 'node:fs/promises' and 'node:path' is generally not possible.
// import * as fs from 'node:fs/promises'; // Remove if not used or handled by polyfills/bundler
// import * as path from 'node:path';     // Remove if not used
// import * as mime from 'mime-types'; // This is fine if used for Content-Type determination

const app = new Hono<{ Bindings: Env }>();

// --- Middleware ---
app。use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400,
}));

app。use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const clientIp = getClientIp(c);
  const servedBy = c.res.headers.get('X-Served-By') || '-';
  console.log(
    `${new Date().toISOString()} - ${clientIp} - ${c.req.method} ${c.req.url} - ${c.res.status} [${ms}ms] Served-By: ${servedBy}`
  );
});


// --- HTML Page Serving Routes ---
app.get('/login', serveLoginPage);

app.post('/login', async (c) => {
  const formData = await c.req.formData();
  const loginCode = formData.get('login_code');

  if (loginCode === c.env.LOGIN_CODE) {
    const token = await generateJwt(c);
    setCookie(c, 'auth_session', token, {
      path: '/',
      secure: new URL(c.req.url).protocol === 'https:',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });
    return c.redirect('/', 303);
  } else {
    const loginUrl = new URL(c.req.url);
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('error', '登录码错误,请重试.');
    return c.redirect(loginUrl.toString(), 303);
  }
});

// --- 受保护的路由 ---
app.use('*', requireLogin);

app.get('/logout', (c) => {
  deleteCookie(c, 'auth_session', { path: '/' });
  return c.redirect('/login', 303);
});

// SPA 页面服务
app.get('/', serveMainSpaPage);
app.get('/movies_home', serveMainSpaPage);
app.get('/manga_home', serveMangaSpaPage);
app.get('/manga_detail/:manga_id', serveMangaSpaPage);
app.get('/manga_read/:manga_id', serveMangaSpaPage);
app.get('/manga_author/:author_name{.+}', serveMangaSpaPage);

app.get('/series_view_page', serveMainSpaPage);
app.get('/actors_view_page', serveMainSpaPage);
app.get('/directors_view_page', serveMainSpaPage);
app.get('/studios_view_page', serveMainSpaPage);
app.get('/numbers_view_page', serveMainSpaPage);

app.get('/video_detail.html', serveVideoDetailPage);

// --- Static Files (CSS, JS in static/ folder) ---
app.get('/static/*', async (c) => {
  // For local dev, wrangler's [site] config or dev server should handle static files.
  // This route primarily targets production serving from R2.
  if (c.env.IS_LOCAL_DEV === "true") {
    console.log(`[LocalDevStatic] Request for ${c.req.url} - ideally handled by Wrangler's dev server or [site] config.`);
    // If Wrangler's [site] serves static files, this route might not even be hit in local dev.
    // If it is hit, and you want to explicitly state it's not handled by the worker:
    c.header('X-Served-By', 'Worker-Static-SkippedForLocalDev');
    return c.notFound(); // Or a message indicating it should be served by the dev server.
  } else {
    // 生产环境：从 R2 提供
    const requestedPath = new URL(c.req.url).pathname;
    const r2Key = requestedPath.substring(1); // e.g., "static/style.css"

    if (!c.env.STATIC_FILES_BUCKET) {
        console.error("[R2] STATIC_FILES_BUCKET is not bound for production static file serving.");
        c.header('X-Served-By', 'Error-StaticBucketMissing');
        return c.text("Static file service (R2) misconfiguration", 500);
    }
    c.header('X-Served-By', 'R2-Static');
    return serveFileFromR2(c, c.env.STATIC_FILES_BUCKET, r2Key, 'public, max-age=31536000');
  }
});

// --- API Routers ---
app.route('/api', mangaApiApp);
app.route('/api_movies', movieApiApp);


// --- Manga Images from R2 ---
app.get('/data/manga_images/*', async (c) => {
    const fullPath = new URL(c.req.url).pathname;
    // Example: /data/manga_images/MangaSubPath/image.jpg -> MangaSubPath/image.jpg
    const imagePathSuffix = fullPath.substring('/data/manga_images/'.length);

    if (!imagePathSuffix) {
        c.header('X-Served-By', 'Error-MangaImagePath');
        return c.text('Manga image path suffix missing', 400);
    }

    // MANGA_R2_BASE_PREFIX from env is "manga/manga"
    // manga.path from DB is like "2022/(C100) [OrangeMaru (YD)] 紫の夢[中国翻訳]"
    // imagePathSuffix from URL is like "2022/(C100) [OrangeMaru (YD)] 紫の夢[中国翻訳]/01.webp"
    // The imagePathSuffix already includes the manga.path part.
    // So, the R2 key is MANGA_R2_BASE_PREFIX + "/" + imagePathSuffix
    const r2Key = `${c.env.MANGA_R2_BASE_PREFIX}/${imagePathSuffix}`.replace(/\/\//g, '/');
    c.header('X-Served-By', 'R2-MangaImage');

    // MANGA_BUCKET is the R2 bucket for manga images
    if (!c.env.MANGA_BUCKET) {
        console.error("[R2] MANGA_BUCKET for manga images is not bound.");
        c.header('X-Served-By', 'Error-MangaBucketBindingMissing');
        return c.text("Manga image service misconfiguration (bucket binding)", 500);
    }
    return serveFileFromR2(c, c.env.MANGA_BUCKET, r2Key, 'public, max-age=604800');
});


// --- Error Handling ---
app.onError((err: any, c) => { // err as any for broader capture, then type check
  const clientIp = getClientIp(c);

  let rawErrorDetails = 'Unknown error structure';
  if (err) {
    try {
      rawErrorDetails = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
      if (err instanceof Error) {
          rawErrorDetails += `\nMessage: ${err.message}\nStack: ${err.stack}`;
      }
    } catch (stringifyError) {
      rawErrorDetails = "Error object could not be stringified.";
    }
  }
  console.error(`${new Date().toISOString()} - ${clientIp} - RAW Server Error at ${c.req.path}: ${rawErrorDetails}`);

  let errorMessage = 'An unexpected error occurred.';
  let errorStatus = 500;

  if (err instanceof HTTPException) { // <--- 这里是关键的修改！
    errorMessage = err.message;
    errorStatus = err.status;
  } else if (err instanceof Error) { // 通用 Error 检查
    errorMessage = err.message;
    // 对于通用 Error，除非它有 status 属性，否则保持 500
    if (err && typeof (err as any).status === 'number') {
        errorStatus = (err as any).status;
    }
  } else if (typeof err === 'string') {
    errorMessage = err;
  } else if (err && typeof err.message === 'string') { // 处理普通对象错误，如果它们有 message 和 status
    errorMessage = err.message;
    if (typeof err.status === 'number') {
      errorStatus = err.status;
    }
  }
  
  if (c.env.IS_LOCAL_DEV === "true") {
    if (err instanceof Error && err.message) {
      errorMessage = `${err.constructor ? err.constructor.name : 'Error'}: ${err.message}`;
      if (err.stack) {
        errorMessage += `\nStack: ${err.stack}`;
      }
    } else if (rawErrorDetails !== 'Unknown error structure' && rawErrorDetails.length < 1024) {
        errorMessage = `Raw error: ${rawErrorDetails}`;
    }
  }
  
  console.error(`${new Date().toISOString()} - ${clientIp} - Processed Server Error at ${c.req.path} (Status: ${errorStatus}): ${errorMessage.split('\n')[0]}`);

  c.header('X-Served-By', 'ErrorHandler');
  return c.json({ error: 'Internal Server Error', message: errorMessage }, errorStatus);
});

app.notFound((c) => {
  const clientIp = getClientIp(c);
  console.warn(`${new Date().toISOString()} - ${clientIp} - Not Found: ${c.req.method} ${c.req.url}`);
  if (c.req.path.startsWith('/api')) {
    c.header('X-Served-By', 'NotFoundHandler-API');
    return c.json({ error: 'Not Found', message: 'API endpoint not found.' }, 404);
  }
  c.header('X-Served-By', 'NotFoundHandler-Page');
  return c.text('Resource Not Found', 404);
});

export default app;
