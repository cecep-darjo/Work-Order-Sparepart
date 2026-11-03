# Push notification setup

This project uses two notification paths:

- The app's existing browser notification can report changes while the app is open.
- The Cloudflare Push Worker checks bell items once per minute and sends Web Push while the app is closed.

## One-time setup

1. Apply `supabase/migrations/20261028110000_085_web_push_notifications.sql` to the Supabase project. The migration creates per-user push subscriptions, a bell snapshot, and a server-only delivery queue. It is intentionally not applied by this change.
2. Generate a VAPID key pair from the push worker folder after installing its dependency:

   ```powershell
   npm install --prefix push-worker
   npm exec --prefix push-worker -- web-push generate-vapid-keys
   ```

3. Set `VITE_WEB_PUSH_VAPID_PUBLIC_KEY` to the generated public key in the app's local `.env` and Cloudflare Pages/Workers build variables, then build and deploy the app.
4. Add these Worker secrets using the generated values:

   ```powershell
   npx wrangler secret put SUPABASE_URL --config wrangler.push.jsonc
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.push.jsonc
   npx wrangler secret put VAPID_PUBLIC_KEY --config wrangler.push.jsonc
   npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.push.jsonc
   npx wrangler secret put VAPID_SUBJECT --config wrangler.push.jsonc
   ```

   `VAPID_SUBJECT` should be a contact URI such as `mailto:admin@example.com`. Keep the private VAPID key and Supabase service role key in Worker secrets only; never add them to the frontend `.env` or source control.
5. Install the Worker dependency and deploy the separate scheduled Worker:

   ```powershell
   npm install --prefix push-worker
   npx wrangler deploy --config wrangler.push.jsonc
   ```

The Worker runs the snapshot every minute. The first run initializes existing bell items without sending a backlog. Later runs queue newly appearing bell items and send them to that user's registered devices. Users must open the app over HTTPS, sign in, and choose **Aktifkan push notification** in the bell menu on each device/browser.

## Local development

Local browser push requires a secure origin and the same VAPID public key in `.env`. The scheduled Worker can be run with `npx wrangler dev --config wrangler.push.jsonc --test-scheduled`; its local run also needs the five Worker secrets in a local `.dev.vars` file next to the config. Do not commit `.dev.vars`.
