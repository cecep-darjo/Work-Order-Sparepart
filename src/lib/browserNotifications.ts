import { supabase } from '@/lib/supabase';

const SERVICE_WORKER_PATH = '/sw.js';
const VAPID_PUBLIC_KEY = (import.meta.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY as string | undefined)?.trim() ?? '';

export function canUseBrowserNotifications(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator;
}

export function canUseWebPush(): boolean {
  return canUseBrowserNotifications()
    && 'PushManager' in window
    && VAPID_PUBLIC_KEY.length > 0;
}

export async function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!canUseBrowserNotifications()) return null;
  return navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: '/' });
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission> {
  if (!canUseBrowserNotifications()) return 'denied';
  const registration = await registerNotificationServiceWorker();
  if (!registration) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.requestPermission();
}

function decodeApplicationServerKey(value: string): Uint8Array {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export async function enableWebPush(profileId: string): Promise<void> {
  if (!canUseWebPush()) throw new Error('Konfigurasi push browser belum tersedia atau browser membutuhkan HTTPS.');
  const registration = await registerNotificationServiceWorker();
  if (!registration) throw new Error('Service worker tidak tersedia di browser ini.');

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(VAPID_PUBLIC_KEY),
    });
  }

  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
    throw new Error('Data subscription push dari browser tidak lengkap.');
  }
  const { error } = await supabase.from('web_push_subscriptions').upsert({
    profile_id: profileId,
    endpoint: serialized.endpoint,
    p256dh: serialized.keys.p256dh,
    auth: serialized.keys.auth,
    expiration_time: subscription.expirationTime,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (error) throw error;
}

export async function disableWebPush(profileId: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const { error } = await supabase
    .from('web_push_subscriptions')
    .delete()
    .eq('profile_id', profileId)
    .eq('endpoint', subscription.endpoint);
  if (error) throw error;
  await subscription.unsubscribe();
}

export async function syncExistingWebPush(profileId: string): Promise<boolean> {
  if (!canUseWebPush() || Notification.permission !== 'granted') return false;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  await enableWebPush(profileId);
  return true;
}

export async function showActionItemNotification(title: string, body: string, tag: string): Promise<void> {
  if (!canUseBrowserNotifications() || Notification.permission !== 'granted') return;
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification(title, {
    body,
    icon: '/notification-icon.svg',
    badge: '/notification-icon.svg',
    tag,
    data: { url: '/' },
  });
}
