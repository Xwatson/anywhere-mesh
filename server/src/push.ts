// Web Push: notifies subscribed browsers (also with the page closed) when a session
// needs a decision or finishes a task.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { config } from './config.js';
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  );
`);

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** The server's VAPID key pair, created once and kept in DATA_DIR. */
function vapidKeys(): VapidKeys {
  const file = resolve(config.dataDir, 'vapid.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

const keys = vapidKeys();
// Push services only use the subject to contact the sender about problems.
webpush.setVapidDetails(process.env.PUSH_SUBJECT || 'mailto:anywhere-coding@example.com', keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;

/** What the service worker turns into a notification. */
export interface PushPayload {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other (one per session). */
  tag: string;
  /** Opened when the notification is clicked. */
  url: string;
  /** Shown even while the page is in the foreground. */
  test?: boolean;
}

interface Row {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const isEndpoint = (s: unknown): s is string => {
  if (typeof s !== 'string' || s.length > 1000) return false;
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Registers this browser for the account. A browser belongs to whoever is signed in on it:
 * subscribing again from another account moves it there.
 */
export function subscribe(userId: number, sub: unknown, userAgent?: string): boolean {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const p256dh = s?.keys?.p256dh;
  const auth = s?.keys?.auth;
  if (!isEndpoint(s?.endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string') return false;
  if (p256dh.length > 200 || auth.length > 100) return false;
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent`,
  ).run(s!.endpoint as string, userId, p256dh, auth, userAgent?.slice(0, 300) ?? null, Date.now());
  return true;
}

export function unsubscribe(endpoint: string) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/** Whether the browser gets this account's notifications. */
export function isSubscribed(endpoint: string, userId: number): boolean {
  return !!db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpoint, userId);
}

/** Stops notifying the account's devices (it was signed out everywhere), except `keepEndpoint`. */
export function dropDevices(userId: number, keepEndpoint?: string) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint != ?').run(userId, keepEndpoint ?? '');
}

// The service runs where the terminal may need a proxy to reach the outside world;
// push services (FCM, Mozilla, Apple) are reached the same way.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || undefined;

async function deliver(row: Row, payload: PushPayload, urgency: 'high' | 'normal'): Promise<string | null> {
  const sub: PushSubscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 60 * 60,
      urgency,
      // A newer message for the same session replaces one that is still undelivered.
      topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
      proxy,
      timeout: 15_000,
    });
    return null;
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    // Gone or invalid: the browser dropped the subscription.
    if (status === 404 || status === 410) unsubscribe(row.endpoint);
    return `${status ?? ''} ${(e as Error).message}`.trim();
  }
}

/** Sends to every device of the account; failures are logged, never thrown. */
export function pushUser(userId: number, payload: PushPayload, urgency: 'high' | 'normal' = 'normal') {
  const rows = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as unknown as Row[];
  for (const row of rows) {
    void deliver(row, payload, urgency).then((err) => {
      if (err) console.warn(`[push] ${new URL(row.endpoint).host}: ${err}`);
    });
  }
}

/** Sends a test notification to one device and reports the push service's answer. */
export async function pushTest(endpoint: string, userId: number): Promise<string | null> {
  const row = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpoint, userId) as
    | Row
    | undefined;
  if (!row) return '这个设备还没有开启推送';
  return deliver(
    row,
    { title: 'Anywhere Coding', body: '推送通知已开启：任务完成或需要你确认时会通知你', tag: 'test', url: '/', test: true },
    'high',
  );
}
