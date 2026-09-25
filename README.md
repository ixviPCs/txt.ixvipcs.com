# Open Chat

A small real-time chat room with server-owned accounts, profiles, and moderation. The first account on a browser is permanently linked to that browser's device ID; signing in to an existing account from a new browser requires its PIN. Account data, bans, and chat history are stored together in `chat-data.json` on the server.

New accounts default to `gues-###`. Users can set a nickname and bio from **Profile**; the permanent account name stays visible below a nickname in chat. A PIN must be 4–6 ASCII letters or digits. PINs `8210` and `82111` make the account an admin, with message moderation, profile editing, and account/device/IP bans.

## Moderation notes

IP bans are enforced during the Socket.IO handshake and again on every protected action. With the included Caddy setup, keep Node's port 3000 private (do not router-forward it) and leave `TRUST_PROXY=1` in `deploy/open-chat.service`; Caddy supplies the real visitor address. An admin can select **IP address** from a person's profile while that person is online. Device bans use a browser-stored random device ID, so clearing browser storage or changing browsers creates a new device ID; they are a deterrent, not hardware-level enforcement. Use an IP ban for an account that keeps returning with fresh browser data.

## Reliable voice with Cloudflare Tunnel

The Tunnel carries the app and WebSocket signaling, but browser-to-browser audio may need a TURN relay. This app supports Coturn's temporary-credential mode: set `TURN_URLS` and `TURN_SHARED_SECRET` in `/etc/open-chat/turn.env` on Ubuntu. Do not put those values in Git. Example:

```bash
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SHARED_SECRET=replace-with-the-same-long-random-secret-used-by-coturn
```

Create a DNS-only (not proxied) `turn.example.com` A record pointing at your home public IPv4. Forward TCP and UDP port `3478`, plus UDP ports `49160-49200`, to the Ubuntu server. Copy `deploy/turnserver.conf.example` to `/etc/turnserver.conf`, replace its placeholders, install `coturn`, and restart both `coturn` and `open-chat`. The shared secret lets the app issue one-hour TURN credentials to signed-in chat users without exposing the long-term secret to browsers.

## Run it locally

1. Install Node.js 20 or newer.
2. In this folder, run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

## Deploy to Ubuntu

This assumes you use a subdomain such as `chat.yourdomain.com` and your server can receive web traffic on ports 80 and 443.

1. Push this project to a private or public GitHub repository.
2. On the server, install Node.js 20+, Git, and Caddy.
3. Clone the repository and install packages:

   ```bash
   git clone https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git open-chat
   cd open-chat
   npm ci --omit=dev
   ```

4. Install a process manager and start the server persistently:

   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name open-chat
   pm2 save
   pm2 startup
   ```

5. Copy `Caddyfile.example` to `/etc/caddy/Caddyfile`, replace the example domain, then run `sudo systemctl reload caddy`.
6. In GoDaddy DNS, create an `A` record named `chat` that points to your home public IP. Forward external TCP ports 80 and 443 in your router to the Ubuntu server.

For updates, run `git pull`, `npm ci --omit=dev`, and `pm2 restart open-chat` from the app folder.

## Important

This is intentionally an open, anonymous chat. Before sharing it broadly, add rate limiting, moderation tools, and persistent storage if needed.
