# Publish Open Chat

GitHub stores this code. Your Ubuntu server runs the Node app, so it is the part that actually handles live messages.

## 1. Push this folder to GitHub

Create an empty GitHub repository (do not add a README or `.gitignore` there), then run these commands from this project folder. Replace `YOUR-USERNAME` and `YOUR-REPOSITORY`.

```bash
git init
git add .
git commit -m "Initial Open Chat site"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

## 2. Install the application on Ubuntu

SSH into your server, then install Git and Node.js 20 or newer. The exact Node install command depends on your Ubuntu version; use the NodeSource or Node.js official instructions if `node --version` is below 20.

```bash
sudo apt update
sudo apt install -y git
git clone https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git open-chat
cd open-chat
npm install --omit=dev
npm start
```

At this point, test from another device on your home network at `http://SERVER-LAN-IP:3000`. Press `Ctrl+C` after confirming it loads.

## 3. Keep it running after logout/reboots

Copy `deploy/open-chat.service` to `/etc/systemd/system/open-chat.service`. Before copying, edit both instances of `YOUR_LINUX_USERNAME` to your Ubuntu login name.

```bash
sudo cp deploy/open-chat.service /etc/systemd/system/open-chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now open-chat
sudo systemctl status open-chat
```

Logs: `sudo journalctl -u open-chat -f`

## 4. Give it a public HTTPS address

Choose a subdomain, such as `chat.yourdomain.com`. Install Caddy, replace `chat.example.com` in `deploy/Caddyfile`, copy it to `/etc/caddy/Caddyfile`, and reload Caddy:

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

In GoDaddy DNS, create an `A` record for host `chat` that points to your home public IPv4 address. In your router, forward external ports 80 and 443 to the Ubuntu server's local IP address. Caddy will then enable HTTPS automatically.

If your home internet uses CGNAT or you do not want to open router ports, use a free Cloudflare Tunnel instead. Add your domain to Cloudflare, move its DNS nameservers from GoDaddy to the values Cloudflare gives you, then configure a tunnel to `http://localhost:3000`. Cloudflare documents this flow; it also keeps your home IP private.

## Updating later

On your own computer: commit and push your changes. On Ubuntu:

```bash
cd ~/open-chat
git pull
npm install --omit=dev
sudo systemctl restart open-chat
```

## Before public sharing

This project allows anonymous access and has no moderation or rate limiting. Only share it with people you trust until you add those protections.
