// src/htmlHandler.ts
import { Context } from 'hono';
import { Env } from './types'; // 确保 Env 类型已定义并导入 (包含 STATIC_FILES_BUCKET)

// 导入 HTML 文件。
// 假设 wrangler.toml 中的 [[rules]] type = "Text" 会将它们作为模块导入。
// 模块可能是 { default: "html content" } 或者直接是 "html content"。
// 我们使用 (module as any).default ?? module 来处理这两种情况。

// @ts-ignore (如果 TypeScript 警告，或者在 custom.d.ts 中定义模块类型)
import loginHtmlModule from '../login.html';
// @ts-ignore
import mainHtmlModule from '../main.html';
// @ts-ignore
import mangaHtmlModule from '../manga.html';
// @ts-ignore
import videoDetailHtmlModule from '../video_detail.html';

// 从导入的模块中提取 HTML 字符串内容
const loginHtmlContent: string = (loginHtmlModule as any).default ?? loginHtmlModule;
const mainHtmlContent: string = (mainHtmlModule as any).default ?? mainHtmlModule;
const mangaHtmlContent: string = (mangaHtmlModule as any).default ?? mangaHtmlModule;
const videoDetailHtmlContent: string = (videoDetailHtmlModule as any).default ?? videoDetailHtmlModule;

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

// 函数：从 R2 Bucket 提供 HTML 文件 (用于生产环境)
async function serveHtmlFromR2(c: Context<{ Bindings: Env }>, r2Key: string) {
  try {
    // 确保 STATIC_FILES_BUCKET 在 Env 类型中定义并已在 wrangler.toml 中绑定
    if (!c.env.STATIC_FILES_BUCKET) {
        console.error("[R2] STATIC_FILES_BUCKET is not bound for HTML file serving.");
        c.header('X-Served-By', 'Error-R2BucketMissing-HTML');
        return c.text("HTML file service (R2) misconfiguration", 500);
    }

    const object = await c.env.STATIC_FILES_BUCKET.get(r2Key);
    if (object === null) {
      console.warn(`[R2] HTML file ${r2Key} not found in R2 bucket STATIC_FILES_BUCKET.`);
      c.header('X-Served-By', 'R2-HtmlFileNotFound');
      return c.text(`HTML file ${r2Key} not found in R2`, 404);
    }

    c.header('Content-Type', HTML_CONTENT_TYPE);
    c.header('X-Served-By', 'R2-HTML');
    // Hono 的 c.body() 可以直接处理 R2ObjectBody (ReadableStream)
    return c.body(object.body);
  } catch (error: any) {
    console.error(`[R2] Error fetching HTML ${r2Key} from R2: ${error.message}`);
    c.header('X-Served-By', 'Error-R2HtmlFetch');
    return c.text(`Error fetching HTML from R2: ${r2Key}`, 500);
  }
}

// 主要的 HTML 服务函数：根据环境选择内联内容或从 R2 获取
async function serveHtmlPage(
  c: Context<{ Bindings: Env }>,
  r2FileName: string,          // 在 R2 中查找时使用的文件名
  localInlinedContent: string  // 本地开发时使用的内联 HTML 字符串
) {
  if (c.env.IS_LOCAL_DEV === "true") {
    console.log(`[LocalDev] Serving INLINED HTML content for: ${r2FileName}`);
    c.header('Content-Type', HTML_CONTENT_TYPE);
    c.header('X-Served-By', 'LocalInlinedHTML');
    return c.body(localInlinedContent);
  } else {
    // 生产环境从 R2 提供
    return serveHtmlFromR2(c, r2FileName);
  }
}

// --- 导出的路由处理函数 ---

export async function serveLoginPage(c: Context<{ Bindings: Env }>) {
  return serveHtmlPage(c, 'login.html', loginHtmlContent);
}

export async function serveMainSpaPage(c: Context<{ Bindings: Env }>) {
  // 确保项目根目录有 'main.html' 文件
  return serveHtmlPage(c, 'main.html', mainHtmlContent);
}

export async function serveMangaSpaPage(c: Context<{ Bindings: Env }>) {
  // 确保项目根目录有 'manga.html' 文件
  return serveHtmlPage(c, 'manga.html', mangaHtmlContent);
}

export async function serveVideoDetailPage(c: Context<{ Bindings: Env }>) {
  // 确保项目根目录有 'video_detail.html' 文件
  return serveHtmlPage(c, 'video_detail.html', videoDetailHtmlContent);
}