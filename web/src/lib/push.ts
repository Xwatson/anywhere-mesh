// Web Push on this device: the service worker shows notifications even with the page closed.
import { api } from './api';

export type PushState =
  | 'unsupported'
  /** iPhone / iPad: push only works in the app added to the home screen. */
  | 'needs-install'
  /** Push needs HTTPS (or localhost). */
  | 'insecure'
  | 'denied'
  | 'off'
  | 'on';

const FLAG = 'push:on';

/** Whether this device gets Web Push, so the page should not also show its own notifications. */
export const pushOnHere = () => localStorage.getItem(FLAG) === '1';
const setFlag = (on: boolean) => (on ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG));

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker', e));
  // A notification was clicked while the app was open: switch to its session.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const data = e.data as { type?: string; url?: string } | null;
    if (data?.type === 'open' && data.url) location.hash = new URL(data.url).hash;
  });
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const cur = sub.options.applicationServerKey;
  if (!cur) return false;
  const a = new Uint8Array(cur);
  return a.length === key.length && a.every((b, i) => b === key[i]);
};

/** The active service worker; fails instead of waiting forever if it never installed. */
async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('后台服务（Service Worker）没有启动，请刷新页面后重试')), 10_000),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export async function pushState(): Promise<PushState> {
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return window.isSecureContext ? 'unsupported' : 'insecure';
  }
  if (Notification.permission === 'denied') {
    setFlag(false);
    return 'denied';
  }
  const sub = await (await registration()).pushManager.getSubscription();
  const on = !!sub && Notification.permission === 'granted' && (await api.pushInfo(sub.endpoint)).subscribed;
  setFlag(on);
  return on ? 'on' : 'off';
}

/** Asks for permission (must run from a click) and registers this device with the server. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? '通知权限被拒绝' : '没有授予通知权限');
  const reg = await registration();
  const key = keyBytes((await api.pushInfo()).publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Subscribed against another server key (e.g. DATA_DIR was reset): start over.
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await subscribeWithTimeout(reg, key);
  await api.pushSubscribe(sub.toJSON());
  setFlag(true);
}

// The browser registers with its vendor's push service (Chrome: Google FCM, Firefox: Mozilla,
// Safari: Apple). If that service is unreachable, subscribe() hangs or fails with a vague error.
const UNREACHABLE =
  '浏览器连不上它的推送服务（Chrome / Edge 用 Google 的 FCM，Firefox 用 Mozilla 的服务）。' +
  '如果你的网络访问不了 Google，请让浏览器走代理后再试，或换用 Safari / Firefox。';

async function subscribeWithTimeout(reg: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`连接推送服务超时。${UNREACHABLE}`)), 30_000);
  });
  try {
    return await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), timeout]);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`订阅推送失败（${(e as Error).message}）。${UNREACHABLE}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function disablePush(): Promise<void> {
  setFlag(false);
  if (!('serviceWorker' in navigator)) return;
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/**
 * A browser's notifications follow whoever is signed in on it. Run after signing in: when this
 * device had push on (perhaps for an account whose login has since expired), it now notifies the
 * signed-in account instead, so nobody gets another account's notifications.
 */
export async function claimPush(): Promise<void> {
  if (!pushOnHere() || !('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return;
  const sub = await (await registration()).pushManager.getSubscription();
  if (sub) await api.pushSubscribe(sub.toJSON());
  else setFlag(false);
}

/** This device's push subscription endpoint, if it has one. */
export async function pushEndpoint(): Promise<string | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription())?.endpoint;
}

export async function testPush(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) throw new Error('这个设备还没有开启推送');
  await api.pushTest(sub.endpoint);
}
