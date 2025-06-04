import { Context } from 'hono';
import { Env } from './types';

// Helper to serve a file from an R2 bucket
export async function serveFileFromR2(
  c: Context<{ Bindings: Env }>,
  bucket: R2Bucket,
  key: string,
  cacheControl: string = 'public, max-age=86400' // Default 1 day cache
) {
  const object = await bucket.get(key);

  if (object === null) {
    return c.text('Object Not Found in R2: ' + key, 404);
  }

  c.header('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  c.header('Content-Length', object.size.toString());
  c.header('ETag', object.httpEtag);
  c.header('Cache-Control', cacheControl);
  // Add other headers if needed, e.g., Content-Disposition for downloads

  return c.body(object.body);
}
