import { Context } from 'hono';
import { Env } from './types';

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

async function serveHtmlFromR2(c: Context<{ Bindings: Env }>, key: string) {
  const object = await c.env.STATIC_FILES_BUCKET.get(key);
  if (object === null) {
    return c.text(`HTML file ${key} not found in R2`, 404);
  }
  c.header('Content-Type', HTML_CONTENT_TYPE);
  return c.body(object.body);
}

export async function serveLoginPage(c: Context<{ Bindings: Env }>) {
  // You might want to pass error messages to the login page if login failed.
  // This is harder with static HTML from R2. One way is via query params.
  // const error = c.req.query('error');
  return serveHtmlFromR2(c, 'login.html');
}

export async function serveMainSpaPage(c: Context<{ Bindings: Env }>) {
  return serveHtmlFromR2(c, 'main.html');
}

export async function serveMangaSpaPage(c: Context<{ Bindings: Env }>) {
  return serveHtmlFromR2(c, 'manga.html');
}

export async function serveVideoDetailPage(c: Context<{ Bindings: Env }>) {
  // This page expects an itemId query param. The JS in video_detail.html will fetch data.
  return serveHtmlFromR2(c, 'video_detail.html');
}
