# Open Chat

A small real-time chat room with server-owned accounts, profiles, moderation, and an admin-managed access-code whitelist. A person enters their assigned access code once; their profile is then remembered on that browser. Account data, codes, bans, and chat history are stored together in `chat-data.json` on the server.

A private `.pin-index-secret` file is created automatically beside the data file. Keep it on the Ubuntu server and out of Git; it protects the lookup index for hashed legacy credentials and access codes.

New profiles default to `gues-###`. Users can set their own nickname, bio, and profile image from **Profile**; the permanent account name stays visible below a nickname in chat. Set private admin PINs through `ADMIN_PINS` on the server, then use `/admin.html` to create regular or admin access codes. No admin PIN is embedded in the source.

## Moderation notes

IP bans are enforced during the Socket.IO handshake and again on every protected action. With the included Caddy setup, keep Node's port 3000 private (do not router-forward it) and leave `TRUST_PROXY=1` in `deploy/open-chat.service`; Caddy supplies the real visitor address. An admin can select **IP address** from a person's profile while that person is online. To prevent collateral bans, the server refuses local/proxy addresses and an IP already associated with another known account. Device bans use a browser-stored random device ID, so clearing browser storage or changing browsers creates a new device ID; they are a deterrent, not hardware-level enforcement.

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
# Open Chat

## Access-code setup

Set `ADMIN_PINS` on the server before using `admin.html`; it is a comma-separated list of private admin PINs and must never be put in browser code or committed to Git. For example on Ubuntu:

```bash
export ADMIN_PINS='your-private-admin-pin'
npm start
```

Visit `/admin.html`, enter that private admin PIN, and create one access code per person. The home page accepts only those server-stored codes. A generated code is displayed only once; send it privately to its owner. Existing accounts retain their old PIN as a legacy access code so they can still enter after this update.
