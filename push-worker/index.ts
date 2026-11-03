import webpush from 'web-push';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

interface PushEvent {
  id: string;
  profile_id: string;
  group_key: string;
  title: string;
  body: string;
  attempts: number;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function supabaseHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function supabaseRequest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: { ...supabaseHeaders(env), ...(init.headers ?? {}) },
  });
}

async function markEvent(env: Env, eventId: string, attempts: number, sent: boolean): Promise<void> {
  const now = new Date().toISOString();
  await supabaseRequest(env, `web_push_outbox?id=eq.${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(sent ? { sent_at: now, attempts } : { attempts }),
  });
}

async function removeSubscription(env: Env, id: string): Promise<void> {
  await supabaseRequest(env, `web_push_subscriptions?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

async function sendPendingPushes(env: Env): Promise<void> {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const eventsResponse = await supabaseRequest(
    env,
    'web_push_outbox?sent_at=is.null&select=id,profile_id,group_key,title,body,attempts&order=created_at.asc&limit=100',
  );
  if (!eventsResponse.ok) throw new Error(`Outbox query failed (${eventsResponse.status})`);
  const events = await eventsResponse.json() as PushEvent[];

  for (const event of events) {
    const subscriptionsResponse = await supabaseRequest(
      env,
      `web_push_subscriptions?profile_id=eq.${encodeURIComponent(event.profile_id)}&select=id,endpoint,p256dh,auth`,
    );
    if (!subscriptionsResponse.ok) {
      await markEvent(env, event.id, event.attempts + 1, false);
      continue;
    }
    const subscriptions = await subscriptionsResponse.json() as PushSubscriptionRow[];
    let allDelivered = true;

    for (const row of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify({
            title: event.title,
            body: event.body,
            icon: '/notification-icon.svg',
            tag: `action-${event.group_key}`,
            data: { url: '/' },
          }),
          { TTL: 60 * 60 * 24 },
        );
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 0;
        if (statusCode === 404 || statusCode === 410) {
          await removeSubscription(env, row.id);
        } else {
          allDelivered = false;
        }
      }
    }

    // An empty list means the user removed the subscription after the item was queued.
    await markEvent(env, event.id, event.attempts + 1, allDelivered);
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabaseRequest(env, `web_push_outbox?sent_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const response = await supabaseRequest(env, 'rpc/queue_bell_push_notifications', {
        method: 'POST',
        body: '{}',
      });
      if (!response.ok) throw new Error(`Bell snapshot failed (${response.status})`);
      await sendPendingPushes(env);
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Push notification poll failed: ${message}`);
    }));
  },

  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};
