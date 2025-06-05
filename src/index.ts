// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import { Env } from './types'; // 假设你有一个 types.ts 定义 Env
import { requireLogin, generateJwt, getClientIp } from './auth'; // 假设你有 auth.ts
import {
  serveLoginPage,
  serveMainSpaPage,
  serveMangaSpaPage,
  serveVideoDetailPage
} from './htmlHandler';
import { serveFileFromR2 } from './r2Utils'; // 假设你有 r2Utils.ts
import { movieApiApp } from './movieApi'; // 假设你有 movieApi.ts
import { mangaApiApp } from './mangaApi'; // 假设你有 mangaApi.ts

// Node.js 内置模块仅用于本地开发
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as mime from 'mime-types'; // 你需要安装这个: npm install mime-types @types/mime-types --save-dev

// const PROJECT_ROOT_FOR_LOCAL_FILES = process.cwd(); // 这个没有被直接使用，但 PROJECT_LOCAL_PATH 环境变量替代了它

const app = new Hono<{ Bindings: Env }>();

// --- Middleware ---
app.use('*', cors({
  origin: '*', // 生产环境中应配置为你的前端域名
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400,
}));

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const clientIp = getClientIp(c); // 确保 getClientIp 函数已定义并能正确工作
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
    const token = await generateJwt(c); // 确保 generateJwt 函数已定义
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
    loginUrl.searchParams.set('error', '登录码错误，请重试。');
    return c.redirect(loginUrl.toString(), 303);
  }
});

// --- 受保护的路由 ---
app.use('*', requireLogin); // 确保 requireLogin 函数已定义和正确配置

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
  if (c.env.IS_LOCAL_DEV === "true") {
    // 本地开发：让 wrangler 的 [site] 配置处理
    // 你可以返回一个特殊的响应，或者期望 wrangler 自动处理
    // 如果 [site] 配置正确，这个路由可能根本不会被命中，
    // 因为 wrangler 会先尝试 [site]
    console.log(`[LocalDevStatic] Request for ${c.req.url} - should be handled by [site] config if path doesn't match worker routes.`);
    // 返回一个 404，让 wrangler 的 [site] 机制接管 (如果它在 Worker 之后运行)
    // 或者，更好的做法是，如果没有特定的 Worker 逻辑要在此处应用，
    // 并且 [site] 配置了，则完全不定义此 /static/* 路由，
    // 让请求直接由 [site] 处理。
    c.header('X-Served-By', 'Worker-Static-FallbackToSite');
    return c.notFound(); // 或者 c.text('Handled by [site]', 200) 来测试是否命中
  } else {
    // 生产环境：从 R2 提供
    const requestedPath = new URL(c.req.url).pathname;
    const r2Key = requestedPath.substring(1); // "static/style.css"

    if (!c.env.STATIC_FILES_BUCKET) {
        console.error("[R2] STATIC_FILES_BUCKET is not bound for production static file serving.");
        c.header('X-Served-By', 'Error-StaticBucketMissing');
        return c.text("Static file service (R2) misconfiguration", 500);
    }
    c.header('X-Served-By', 'R2-Static');
    // 确保 serveFileFromR2 函数存在并能正确工作
    return serveFileFromR2(c, c.env.STATIC_FILES_BUCKET, r2Key, 'public, max-age=31536000');
  }
});

// --- API Routers ---
app.route('/api', mangaApiApp);
app.route('/api_movies', movieApiApp);


// --- Manga Images from R2 (served via ASSETS_BUCKET) ---
app.get('/data/manga_images/*', async (c) => {
    const fullPath = new URL(c.req.url).pathname;
    const imagePathSuffix = fullPath.replace('/data/manga_images/', '');

    if (!imagePathSuffix || imagePathSuffix === fullPath) {
        c.header('X-Served-By', 'Error-MangaImagePath');
        return c.text('Manga image path suffix missing or invalid', 400);
    }

    const r2Key = `${c.env.MANGA_R2_BASE_PREFIX}/${imagePathSuffix}`.replace(/\/\//g, '/');
    c.header('X-Served-By', 'R2-MangaImage');

    if (!c.env.ASSETS_BUCKET) {
        console.error("[R2] ASSETS_BUCKET for manga images is not bound.");
        c.header('X-Served-By', 'Error-MangaBucketMissing');
        return c.text("Manga image service misconfiguration", 500);
    }
    return serveFileFromR2(c, c.env.ASSETS_BUCKET, r2Key, 'public, max-age=604800');
});


// --- Error Handling ---
app.onError((err, c) => {
  const clientIp = getClientIp(c);
  console.error(`${clientIp} - Server Error at ${c.req.path}:`, err);
  const errorMessage = (c.env.IS_LOCAL_DEV === "true" || err instanceof Hono.HTTPError) ? err.message : 'An unexpected error occurred.';
  const errorStatus = (err instanceof Hono.HTTPError) ? err.status : 500;
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