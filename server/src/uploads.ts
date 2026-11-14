import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { basename, extname, join } from 'node:path';
import { config } from './config.js';
import type { Attachment } from './shared/protocol.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.zip': 'application/zip',
};

export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** Images the models can look at directly (Claude image blocks, Codex localImage). */
export const isViewableImage = (mime: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);

/** Uploads live outside the project so agents never commit them by accident. */
export function uploadDir(sessionId: string): string {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('bad session id');
  return join(config.dataDir, 'uploads', sessionId);
}

function cleanName(name: string): string {
  const base = basename(name).replace(/[\u0000-\u001f/\\:*?"<>|]/g, '_').trim();
  return (base || 'file').slice(-120);
}

export function saveUpload(sessionId: string, name: string, data: Buffer): Attachment {
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
  const dir = uploadDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const display = cleanName(name);
  // A short random prefix keeps same-named uploads apart; the id is the file name on disk.
  const id = `${randomBytes(4).toString('hex')}-${display}`;
  writeFileSync(join(dir, id), data, { mode: 0o600 });
  return { id, name: display, mime: mimeOf(display), size: data.length };
}

/** Resolves an attachment id to its file, refusing anything outside the session's folder. */
export function uploadPath(sessionId: string, id: string): string | null {
  if (!id || id !== basename(id) || id.startsWith('.')) return null;
  const path = join(uploadDir(sessionId), id);
  return existsSync(path) ? path : null;
}

/** Sends an attachment. Only images render inline; everything else downloads, so an uploaded HTML/SVG file never runs as a page. */
export function sendUpload(reply: FastifyReply, path: string, id: string) {
  const mime = mimeOf(id);
  const inline = isViewableImage(mime);
  reply
    .header('Content-Type', inline ? mime : 'application/octet-stream')
    .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(id.replace(/^[0-9a-f]{8}-/, ''))}`)
    .header('Cache-Control', 'private, max-age=86400');
  return reply.send(createReadStream(path));
}

export function loadAttachments(sessionId: string, ids: string[]): (Attachment & { path: string })[] {
  return ids.flatMap((id) => {
    const path = uploadPath(sessionId, id);
    if (!path) return [];
    const name = id.replace(/^[0-9a-f]{8}-/, '');
    return [{ id, name, mime: mimeOf(name), size: statSync(path).size, path }];
  });
}

export function deleteUploads(sessionId: string) {
  rmSync(uploadDir(sessionId), { recursive: true, force: true });
}
