# Open Chat

A simple display-name-based real-time chat room. Recent messages stay in memory while the server runs (up to 100); restarting it clears the room history.

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
