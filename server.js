const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1_500_000 });
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, "chat-data.json");
const ADMIN_PINS = new Set(["8210", "82111"]);
const clean = (value, length) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, length) : "";
const validDevice = (value) => typeof value === "string" && /^[a-z0-9-]{16,80}$/i.test(value) ? value : "";
const validPin = (value) => typeof value === "string" && /^[A-Za-z0-9]{4,6}$/.test(value);
const validAvatar = (value) => typeof value === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value) && value.length <= 1_400_000 ? value : "";
function load() { try { const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); if (data.version === 2) return data; } catch {} return { version: 2, accounts: {}, devices: {}, bans: { account: {}, device: {}, ip: {} }, messages: [] }; }
const data = load();
function save() { try { fs.writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(data)); fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE); } catch (error) { console.error("Could not save chat data:", error.message); } }
function hashPin(pin) { const salt = crypto.randomBytes(16).toString("hex"); return `${salt}:${crypto.scryptSync(pin, salt, 32).toString("hex")}`; }
function pinMatches(pin, saved) { if (!validPin(pin) || !saved) return false; const [salt, expected] = saved.split(":"); const actual = crypto.scryptSync(pin, salt, 32).toString("hex"); return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); }
function profile(account) { return { id: account.id, name: account.name, nickname: account.nickname || "", bio: account.bio || "", avatar: account.avatar || "", admin: !!account.admin }; }
const shownName = (account) => account.nickname || account.name;
const findName = (name) => Object.values(data.accounts).find((item) => item.name.toLowerCase() === name.toLowerCase());
function guestName() { let name; do name = `gues-${crypto.randomInt(100, 1000)}`; while (findName(name)); return name; }
const ipOf = (socket) => {
  // Only trust forwarded headers when the Node port is reachable exclusively through a trusted proxy.
  const forwarded = process.env.TRUST_PROXY === "1" ? socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() : "";
  return String(forwarded || socket.handshake.address || "").replace(/^::ffff:/, "");
};
function pruneBans() { let dirty = false; for (const set of Object.values(data.bans)) for (const [key, ban] of Object.entries(set)) if (ban.until && ban.until <= Date.now()) { delete set[key]; dirty = true; } if (dirty) save(); }
function getBan(kind, target) { const ban = data.bans[kind][target]; return ban && (!ban.until || ban.until > Date.now()) ? ban : null; }
function currentBan(socket, device, account) { pruneBans(); return getBan("ip", ipOf(socket)) || (device && getBan("device", device)) || (account && getBan("account", account)); }
function banError(ban) { return `You are banned${ban.until ? ` until ${new Date(ban.until).toLocaleString()}` : " permanently"}.`; }
function socketsFor(accountId) { return [...io.sockets.sockets.values()].filter((socket) => socket.data.accountId === accountId); }
function voiceAccounts() { return new Set([...(io.sockets.adapter.rooms.get("voice") || [])].map((id) => io.sockets.sockets.get(id)?.data.accountId).filter(Boolean)); }
function presence() { const voice = voiceAccounts(); return Object.values(data.accounts).map((account) => { const sockets = socketsFor(account.id); return { ...profile(account), displayName: shownName(account), status: !sockets.length ? "offline" : sockets.some((socket) => socket.data.visibility === "online") ? "online" : "away", voice: voice.has(account.id) }; }).sort((a, b) => a.displayName.localeCompare(b.displayName)); }
const broadcastPresence = () => io.emit("presence users", presence());
function view(message) { if (message.type !== "chat") return message; const account = data.accounts[message.authorId]; return { ...message, name: account?.name || message.name, nickname: account?.nickname || "", avatar: account?.avatar || message.avatar || "" }; }
function mustUser(socket, acknowledge) { const account = data.accounts[socket.data.accountId]; if (!account) { acknowledge?.({ ok: false, error: "Join the chat first." }); return null; } const ban = currentBan(socket, socket.data.deviceId, account.id); if (ban) { acknowledge?.({ ok: false, error: banError(ban) }); socket.disconnect(); return null; } return account; }
function mustAdmin(socket, acknowledge) { const account = mustUser(socket, acknowledge); if (!account || !account.admin) { if (account) acknowledge?.({ ok: false, error: "Only admins can do that." }); return null; } return account; }
function voiceParticipants() { return [...(io.sockets.adapter.rooms.get("voice") || [])].map((id) => { const socket = io.sockets.sockets.get(id); const account = socket && data.accounts[socket.data.accountId]; return account ? { id, name: shownName(account), avatar: account.avatar || "" } : null; }).filter(Boolean); }

app.use(express.static(path.join(__dirname, "public")));
io.on("connection", (socket) => {
  socket.emit("history", data.messages.map(view)); socket.emit("presence users", presence());
  socket.on("join", (request, acknowledge) => {
    const deviceId = validDevice(request?.deviceId); if (!deviceId) return acknowledge?.({ ok: false, error: "This browser could not create a device ID." });
    const initialBan = currentBan(socket, deviceId); if (initialBan) return acknowledge?.({ ok: false, error: banError(initialBan) });
    let account = data.accounts[data.devices[deviceId]];
    if (!account && request?.mode === "sign-in") { account = findName(clean(request.name, 24)); if (!account || !pinMatches(request.pin, account.pinHash)) return acknowledge?.({ ok: false, error: "That name and PIN do not match." }); data.devices[deviceId] = account.id; }
    if (!account && request?.mode !== "sign-in") { const name = clean(request.name, 24) || guestName(); if (findName(name)) return acknowledge?.({ ok: false, error: "That account name is taken. Join it using its PIN." }); if (request.pin && !validPin(request.pin)) return acknowledge?.({ ok: false, error: "A PIN must be 4–6 letters or numbers." }); account = { id: randomUUID(), name, nickname: "", bio: "", avatar: validAvatar(request.avatar), pinHash: request.pin ? hashPin(request.pin) : "", admin: ADMIN_PINS.has(request.pin), createdAt: Date.now() }; data.accounts[account.id] = account; data.devices[deviceId] = account.id; }
    if (!account) return acknowledge?.({ ok: false, error: "This device has no available account." }); const ban = currentBan(socket, deviceId, account.id); if (ban) return acknowledge?.({ ok: false, error: banError(ban) });
    socket.data.accountId = account.id; socket.data.deviceId = deviceId; socket.data.visibility = "online"; socket.join(`account:${account.id}`); save(); acknowledge?.({ ok: true, account: profile(account), displayName: shownName(account) }); socket.emit("history", data.messages.map(view)); broadcastPresence();
  });
  socket.on("get profile", (id, acknowledge) => { const account = data.accounts[id]; const viewer = data.accounts[socket.data.accountId]; if (!account) return acknowledge?.({ ok: false, error: "Profile not found." }); const result = { ok: true, profile: profile(account) }; if (viewer?.admin) result.moderationTargets = { device: Object.entries(data.devices).filter(([, accountId]) => accountId === id).map(([deviceId]) => deviceId)[0] || "", ip: socketsFor(id).map(ipOf)[0] || "" }; acknowledge?.(result); });
  socket.on("update profile", (request, acknowledge) => { const actor = mustUser(socket, acknowledge); if (!actor) return; const target = request?.accountId && actor.admin ? data.accounts[request.accountId] : actor; if (!target) return acknowledge?.({ ok: false, error: "Account not found." }); const own = actor.id === target.id;
    if (Object.hasOwn(request || {}, "name")) { if (own && !actor.admin) return acknowledge?.({ ok: false, error: "Only an admin can change an account name." }); const name = clean(request.name, 24); const other = findName(name); if (!name || (other && other.id !== target.id)) return acknowledge?.({ ok: false, error: "That account name is not available." }); target.name = name; }
    if (Object.hasOwn(request || {}, "nickname")) target.nickname = clean(request.nickname, 24); if (Object.hasOwn(request || {}, "bio")) target.bio = clean(request.bio, 280); if (Object.hasOwn(request || {}, "avatar")) target.avatar = validAvatar(request.avatar); if (request.pin) { if (!validPin(request.pin)) return acknowledge?.({ ok: false, error: "A PIN must be 4–6 letters or numbers." }); target.pinHash = hashPin(request.pin); target.admin = ADMIN_PINS.has(request.pin); } save(); io.emit("user profile updated", profile(target)); broadcastPresence(); acknowledge?.({ ok: true, profile: profile(target) }); });
  socket.on("chat message", (text, acknowledge) => { const account = mustUser(socket, acknowledge); text = clean(text, 1000); if (!account || !text) return; const message = { type: "chat", id: randomUUID(), authorId: account.id, name: account.name, avatar: account.avatar || "", text, timestamp: Date.now() }; data.messages.push(message); save(); io.emit("message", view(message)); acknowledge?.({ ok: true }); });
  socket.on("edit message", ({ id, text }, acknowledge) => { const actor = mustUser(socket, acknowledge); const message = actor && data.messages.find((item) => item.id === id && (item.authorId === actor.id || actor.admin)); text = clean(text, 1000); if (!message || !text) return acknowledge?.({ ok: false, error: "Message could not be edited." }); message.text = text; message.editedAt = Date.now(); save(); io.emit("message updated", { id, text, editedAt: message.editedAt }); acknowledge?.({ ok: true }); });
  socket.on("delete message", ({ id }, acknowledge) => { const actor = mustUser(socket, acknowledge); const index = actor && data.messages.findIndex((item) => item.id === id && (item.authorId === actor.id || actor.admin)); if (index < 0) return acknowledge?.({ ok: false, error: "Message could not be deleted." }); data.messages.splice(index, 1); save(); io.emit("message deleted", id); acknowledge?.({ ok: true }); });
  socket.on("ban", (request, acknowledge) => { const admin = mustAdmin(socket, acknowledge); const kind = request?.kind; const target = request?.target; const minutes = Number(request?.durationMinutes); if (!admin) return; if (!["account", "device", "ip"].includes(kind) || typeof target !== "string" || !target || !Number.isInteger(minutes) || minutes < 0 || minutes > 525600) return acknowledge?.({ ok: false, error: "Choose a valid ban target and duration." }); data.bans[kind][target] = { until: minutes ? Date.now() + minutes * 60000 : null, by: admin.id, createdAt: Date.now() }; save(); acknowledge?.({ ok: true }); for (const other of io.sockets.sockets.values()) if ((kind === "account" && other.data.accountId === target) || (kind === "device" && other.data.deviceId === target) || (kind === "ip" && ipOf(other) === target)) other.disconnect(true); });
  socket.on("presence state", (state) => { if (socket.data.accountId) { socket.data.visibility = state === "away" ? "away" : "online"; broadcastPresence(); } }); socket.on("leave chat", () => socket.disconnect(true));
  socket.on("voice join", (_, acknowledge) => { const account = mustUser(socket, acknowledge); if (!account) return; if (voiceAccounts().has(account.id)) return acknowledge?.({ ok: false, error: "You are already in voice chat in another tab." }); const peers = voiceParticipants(); socket.join("voice"); socket.emit("voice participants", peers); socket.to("voice").emit("voice participant joined", { id: socket.id, name: shownName(account), avatar: account.avatar || "" }); broadcastPresence(); acknowledge?.({ ok: true, name: shownName(account) }); });
  socket.on("voice signal", ({ target, signal }) => { const account = data.accounts[socket.data.accountId]; if (socket.rooms.has("voice") && target && signal && account) io.to(target).emit("voice signal", { from: socket.id, name: shownName(account), avatar: account.avatar || "", signal }); }); socket.on("voice leave", () => { if (socket.rooms.has("voice")) { socket.to("voice").emit("voice participant left", socket.id); socket.leave("voice"); broadcastPresence(); } }); socket.on("disconnect", () => broadcastPresence());
});
server.listen(PORT, "0.0.0.0", () => console.log(`Chat is running at http://localhost:${PORT}`));
