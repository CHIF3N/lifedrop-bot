# lifedrop-bot
lifedrop demo

## Admin dashboard (`/admin`)

One web page to watch and run LifeDrop: stats, donors, requests, matches, hospitals/labs,
donor review, WhatsApp template status and broadcasts. Phone numbers are hidden unless you tick
"Show phone numbers".

### Setup on Render

1. Render → your service → **Environment** → add:
   - `ADMIN_KEY`: a long random password (the dashboard login). Without it the dashboard stays locked.
   - `WABA_ID` = `1095708656227443` (for the template status tab).
   - Optional: `BROADCAST_DELAY_MS` (pause between broadcast messages, default `300`).
2. Save. Render redeploys.
3. Open `https://<your-render-url>/admin` and log in with `ADMIN_KEY`.

Logging in sets an HttpOnly cookie for 12 hours. Changing `ADMIN_KEY` logs everyone out.

### Broadcasts

- Write the message (max 700 characters), pick the audience (all donors, one blood type, one city), then **Preview**.
- The preview shows how many donors get it, and the exact text.
- Donors who messaged the bot in the last 24 hours get a normal message.
  Everyone else gets the **`donor_broadcast`** Marketing template, so it must be **Approved** first
  (see the Templates tab). Until then, tick "Only donors who messaged the bot in the last 24 hours".
- Tick the confirm box, then **Send**. Every recipient's result (sent / failed + error) is saved in the
  `broadcasts` and `broadcast_recipients` tables and shown under "Past broadcasts".
- Donors who reply **STOP** (or tap "Stop updates") are never sent broadcasts again. **START** turns them back on.
  Urgent blood requests still reach them.

### Try it locally (no real database, no real WhatsApp)

```bash
npm install
npm run dev:admin
```

Open http://localhost:3100/admin and log in with `dev-admin-key`. It uses an in-memory database with
fictional donors, and prints WhatsApp messages instead of sending them.
