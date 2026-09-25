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
const PIN_INDEX_SECRET_FILE = path.join(__dirname, ".pin-index-secret");
const ADMIN_PINS = new Set((process.env.ADMIN_PINS || "8210,82111").split(",").map((pin) => pin.trim()).filter((pin) => /^[A-Za-z0-9]{4,6}$/.test(pin)));
const HISTORY_LIMIT = 200;
const MAX_STORED_MESSAGES = 2_000;
const clean = (value, length) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, length) : "";
const validDevice = (value) => typeof value === "string" && /^[a-z0-9-]{16,80}$/i.test(value) ? value : "";
const validPin = (value) => typeof value === "string" && /^[A-Za-z0-9]{4,6}$/.test(value);
const validAvatar = (value) => typeof value === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value) && value.length <= 1_400_000 ? value : "";
const turnUrls = (process.env.TURN_URLS || "").split(",").map((url) => url.trim()).filter(Boolean);
const turnSecret = process.env.TURN_SHARED_SECRET || "";
// Caddy must be the only public entry point when this is enabled. It strips any
// client-supplied forwarding headers and supplies the real remote address.
const trustProxy = process.env.TRUST_PROXY === "1";
app.set("trust proxy", trustProxy);
function load() { try { const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); if (data.version === 2) return data; } catch {} return { version: 2, accounts: {}, devices: {}, bans: { account: {}, device: {}, ip: {} }, messages: [] }; }
const data = load();
if (!data.pinIndex) data.pinIndex = {};
function pinIndexSecret() { if (process.env.PIN_INDEX_SECRET) return process.env.PIN_INDEX_SECRET; try { return fs.readFileSync(PIN_INDEX_SECRET_FILE, "utf8").trim(); } catch {} const secret = crypto.randomBytes(32).toString("hex"); try { fs.writeFileSync(PIN_INDEX_SECRET_FILE, secret, { mode: 0o600 }); } catch (error) { console.error("Could not persist PIN index secret:", error.message); } return secret; }
const PIN_INDEX_SECRET = pinIndexSecret();
let saveDirty = false, saveInProgress = false, saveTimer = null;
function save() { saveDirty = true; if (!saveInProgress && !saveTimer) saveTimer = setTimeout(flushSave, 75); }
function flushSave() { saveTimer = null; if (!saveDirty || saveInProgress) return; saveDirty = false; saveInProgress = true; const contents = JSON.stringify(data); fs.writeFile(`${DATA_FILE}.tmp`, contents, (writeError) => { if (writeError) { console.error("Could not save chat data:", writeError.message); saveInProgress = false; if (saveDirty) save(); return; } fs.rename(`${DATA_FILE}.tmp`, DATA_FILE, (renameError) => { if (renameError) console.error("Could not save chat data:", renameError.message); saveInProgress = false; if (saveDirty) save(); }); }); }
if (data.messages.some((message) => Object.hasOwn(message, "avatar"))) { for (const message of data.messages) delete message.avatar; save(); }
function hashPin(pin) { const salt = crypto.randomBytes(16).toString("hex"); return `${salt}:${crypto.scryptSync(pin, salt, 32).toString("hex")}`; }
function pinMatches(pin, saved) { if (!validPin(pin) || !saved) return false; const [salt, expected] = saved.split(":"); const actual = crypto.scryptSync(pin, salt, 32).toString("hex"); return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); }
function pinKey(pin) { return crypto.createHmac("sha256", PIN_INDEX_SECRET).update(pin).digest("hex"); }
function setPin(account, pin) { if (account.pinKey) delete data.pinIndex[account.pinKey]; account.pinHash = hashPin(pin); account.pinKey = pinKey(pin); data.pinIndex[account.pinKey] = account.id; }
function profile(account) { return { id: account.id, name: account.name, nickname: account.nickname || "", bio: account.bio || "", avatar: account.avatar || "", admin: !!account.admin }; }
const shownName = (account) => account.nickname || account.name;
const findName = (name) => Object.values(data.accounts).find((item) => item.name.toLowerCase() === name.toLowerCase());
function findPin(pin) { if (!validPin(pin)) return null; const key = pinKey(pin); const indexed = data.accounts[data.pinIndex[key]]; if (indexed && pinMatches(pin, indexed.pinHash)) return indexed; const account = Object.values(data.accounts).find((item) => pinMatches(pin, item.pinHash)); if (account) { account.pinKey = key; data.pinIndex[key] = account.id; save(); } return account; }
function guestName() { let name; do name = `gues-${crypto.randomInt(100, 1000)}`; while (findName(name)); return name; }
function normalizedIp(value) { const ip = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, ""); return ip && ip.length <= 64 ? ip : ""; }
function isBanableIp(ip) { if (!ip || ip === "::1" || ip === "0.0.0.0" || ip === "::") return false; if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return false; if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false; return !/^(fc|fd|fe80:)/.test(ip); }
const ipOf = (socket) => {
  // Only trust forwarded headers when the Node port is reachable exclusively through a trusted proxy.
  const forwarded = trustProxy ? socket.handshake.headers["cf-connecting-ip"] || socket.handshake.headers["x-forwarded-for"]?.split(",")[0] : "";
  return normalizedIp(forwarded || socket.handshake.address);
};
function pruneBans() { let dirty = false; for (const set of Object.values(data.bans)) for (const [key, ban] of Object.entries(set)) if (ban.until && ban.until <= Date.now()) { delete set[key]; dirty = true; } if (dirty) save(); }
function getBan(kind, target) { const ban = data.bans[kind][target]; return ban && (!ban.until || ban.until > Date.now()) ? ban : null; }
function currentBan(socket, device, account) { pruneBans(); return getBan("ip", ipOf(socket)) || (device && getBan("device", device)) || (account && getBan("account", account)); }
function banError(ban) { return `You are banned${ban.until ? ` until ${new Date(ban.until).toLocaleString()}` : " permanently"}.`; }
function recentHistory() { const messages = data.messages.slice(-HISTORY_LIMIT).map((message) => { const result = view(message); if (result.type === "chat") delete result.avatar; return result; }); const authorIds = new Set(messages.filter((message) => message.authorId).map((message) => message.authorId)); return { messages, profiles: [...authorIds].map((id) => data.accounts[id]).filter(Boolean).map(profile) }; }
function socketsFor(accountId) { return [...io.sockets.sockets.values()].filter((socket) => socket.data.accountId === accountId); }
function voiceAccounts() { return new Set([...(io.sockets.adapter.rooms.get("voice") || [])].map((id) => io.sockets.sockets.get(id)?.data.accountId).filter(Boolean)); }
function presence() { const voice = voiceAccounts(); return Object.values(data.accounts).map((account) => { const sockets = socketsFor(account.id); return { ...profile(account), displayName: shownName(account), status: !sockets.length ? "offline" : sockets.some((socket) => socket.data.visibility === "online") ? "online" : "away", voice: voice.has(account.id) }; }).sort((a, b) => a.displayName.localeCompare(b.displayName)); }
const broadcastPresence = () => io.to("chat").emit("presence users", presence());
function view(message) { if (message.type !== "chat") return message; const account = data.accounts[message.authorId]; return { ...message, name: account?.name || message.name, nickname: account?.nickname || "", avatar: account?.avatar || message.avatar || "" }; }
function mustUser(socket, acknowledge) { const account = data.accounts[socket.data.accountId]; if (!account) { acknowledge?.({ ok: false, error: "Join the chat first." }); return null; } const ban = currentBan(socket, socket.data.deviceId, account.id); if (ban) { acknowledge?.({ ok: false, error: banError(ban) }); socket.disconnect(); return null; } return account; }
function mustAdmin(socket, acknowledge) { const account = mustUser(socket, acknowledge); if (!account || !account.admin) { if (account) acknowledge?.({ ok: false, error: "Only admins can do that." }); return null; } return account; }
function voiceParticipants() { return [...(io.sockets.adapter.rooms.get("voice") || [])].map((id) => { const socket = io.sockets.sockets.get(id); const account = socket && data.accounts[socket.data.accountId]; return account ? { id, name: shownName(account), avatar: account.avatar || "" } : null; }).filter(Boolean); }
function voiceIceServers(account) {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (!turnUrls.length || !turnSecret) return iceServers;
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiry}:${account.id}`;
  const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
  iceServers.push({ urls: turnUrls, username, credential });
  return iceServers;
}

app.use(express.static(path.join(__dirname, "public")));
io.use((socket, next) => {
  const ban = getBan("ip", ipOf(socket));
  if (ban) return next(new Error(banError(ban)));
  next();
});
io.on("connection", (socket) => {
  socket.on("join", (request, acknowledge) => {
    const deviceId = validDevice(request?.deviceId); if (!deviceId) return acknowledge?.({ ok: false, error: "This browser could not create a device ID." });
    const initialBan = currentBan(socket, deviceId); if (initialBan) return acknowledge?.({ ok: false, error: banError(initialBan) });
    let account = data.accounts[data.devices[deviceId]]; let created = false;
    if (!account && request?.mode === "sign-in") { account = findPin(request.pin); if (!account) return acknowledge?.({ ok: false, error: "That PIN does not match an account." }); data.devices[deviceId] = account.id; }
    // New accounts never accept a client-supplied permanent name. Only an admin may rename it later.
    if (!account && request?.mode !== "sign-in") { const name = guestName(); const pin = request.pin; const avatar = validAvatar(request.avatar); if (!validPin(pin)) return acknowledge?.({ ok: false, error: "Choose a PIN with 4–6 letters or numbers." }); if (findPin(pin)) return acknowledge?.({ ok: false, error: "That PIN is already in use. Choose another one." }); account = { id: randomUUID(), name, nickname: clean(request.nickname, 24), bio: "", avatar, admin: ADMIN_PINS.has(pin), createdAt: Date.now() }; setPin(account, pin); data.accounts[account.id] = account; data.devices[deviceId] = account.id; created = true; }
    if (!account) return acknowledge?.({ ok: false, error: "This device has no available account." }); const ban = currentBan(socket, deviceId, account.id); if (ban) return acknowledge?.({ ok: false, error: banError(ban) });
    socket.data.accountId = account.id; socket.data.deviceId = deviceId; socket.data.visibility = "online"; account.lastIp = ipOf(socket); socket.join(`account:${account.id}`); socket.join("chat"); save(); acknowledge?.({ ok: true, account: profile(account), displayName: shownName(account), created, history: recentHistory() }); socket.emit("presence users", presence()); broadcastPresence();
  });
  socket.on("get profile", (id, acknowledge) => { const account = data.accounts[id]; const viewer = data.accounts[socket.data.accountId]; if (!account) return acknowledge?.({ ok: false, error: "Profile not found." }); const result = { ok: true, profile: profile(account) }; if (viewer?.admin) { const ip = socketsFor(id).map(ipOf)[0] || ""; const shared = Object.values(data.accounts).some((item) => item.id !== id && item.lastIp === ip); result.moderationTargets = { device: Object.entries(data.devices).filter(([, accountId]) => accountId === id).map(([deviceId]) => deviceId)[0] || "", ip: isBanableIp(ip) && !shared ? ip : "" }; } acknowledge?.(result); });
  socket.on("update profile", (request, acknowledge) => { const actor = mustUser(socket, acknowledge); if (!actor) return; const target = request?.accountId && actor.admin ? data.accounts[request.accountId] : actor; if (!target) return acknowledge?.({ ok: false, error: "Account not found." });
    // A permanent account name can only ever be changed by an admin; nicknames remain self-editable below.
    if (Object.hasOwn(request || {}, "name")) { if (!actor.admin) return acknowledge?.({ ok: false, error: "Only an admin can change an account name." }); const name = clean(request.name, 24); const other = findName(name); if (!name || (other && other.id !== target.id)) return acknowledge?.({ ok: false, error: "That account name is not available." }); target.name = name; }
    if (Object.hasOwn(request || {}, "nickname")) target.nickname = clean(request.nickname, 24); if (Object.hasOwn(request || {}, "bio")) target.bio = clean(request.bio, 280); if (Object.hasOwn(request || {}, "avatar")) target.avatar = validAvatar(request.avatar); if (request.pin) { if (!validPin(request.pin)) return acknowledge?.({ ok: false, error: "A PIN must be 4–6 letters or numbers." }); const pinOwner = findPin(request.pin); if (pinOwner && pinOwner.id !== target.id) return acknowledge?.({ ok: false, error: "That PIN is already in use. Choose another one." }); setPin(target, request.pin); target.admin = ADMIN_PINS.has(request.pin); } save(); io.to("chat").emit("user profile updated", profile(target)); broadcastPresence(); acknowledge?.({ ok: true, profile: profile(target) }); });
  socket.on("chat message", (text, acknowledge) => { const account = mustUser(socket, acknowledge); text = clean(text, 1000); if (!account || !text) return; const message = { type: "chat", id: randomUUID(), authorId: account.id, name: account.name, text, timestamp: Date.now() }; data.messages.push(message); if (data.messages.length > MAX_STORED_MESSAGES) data.messages.splice(0, data.messages.length - MAX_STORED_MESSAGES); save(); io.to("chat").emit("message", view(message)); acknowledge?.({ ok: true }); });
  socket.on("edit message", ({ id, text }, acknowledge) => { const actor = mustUser(socket, acknowledge); const message = actor && data.messages.find((item) => item.id === id && (item.authorId === actor.id || actor.admin)); text = clean(text, 1000); if (!message || !text) return acknowledge?.({ ok: false, error: "Message could not be edited." }); message.text = text; message.editedAt = Date.now(); save(); io.to("chat").emit("message updated", { id, text, editedAt: message.editedAt }); acknowledge?.({ ok: true }); });
  socket.on("delete message", ({ id }, acknowledge) => { const actor = mustUser(socket, acknowledge); const index = actor && data.messages.findIndex((item) => item.id === id && (item.authorId === actor.id || actor.admin)); if (index < 0) return acknowledge?.({ ok: false, error: "Message could not be deleted." }); data.messages.splice(index, 1); save(); io.to("chat").emit("message deleted", id); acknowledge?.({ ok: true }); });
  socket.on("ban", (request, acknowledge) => { const admin = mustAdmin(socket, acknowledge); const kind = request?.kind; const target = request?.target; const minutes = Number(request?.durationMinutes); if (!admin) return; if (!["account", "device", "ip"].includes(kind) || typeof target !== "string" || !target || !Number.isInteger(minutes) || minutes < 0 || minutes > 525600) return acknowledge?.({ ok: false, error: "Choose a valid ban target and duration." }); if (kind === "ip") { if (!isBanableIp(target)) return acknowledge?.({ ok: false, error: "This is a proxy, local-network, or otherwise unsafe IP address. It cannot be IP-banned." }); const shared = Object.values(data.accounts).some((item) => item.id !== request.accountId && item.lastIp === target); if (shared) return acknowledge?.({ ok: false, error: "That IP address is shared by another account, so it cannot be IP-banned." }); } data.bans[kind][target] = { until: minutes ? Date.now() + minutes * 60000 : null, by: admin.id, createdAt: Date.now() }; save(); acknowledge?.({ ok: true }); for (const other of io.sockets.sockets.values()) if ((kind === "account" && other.data.accountId === target) || (kind === "device" && other.data.deviceId === target) || (kind === "ip" && ipOf(other) === target)) other.disconnect(true); });
  socket.on("delete account", (accountId, acknowledge) => { const admin = mustAdmin(socket, acknowledge); const target = typeof accountId === "string" ? data.accounts[accountId] : null; if (!admin) return; if (!target) return acknowledge?.({ ok: false, error: "Account not found." }); if (target.id === admin.id) return acknowledge?.({ ok: false, error: "You cannot delete your own account." }); if (target.admin && Object.values(data.accounts).filter((account) => account.admin).length < 2) return acknowledge?.({ ok: false, error: "You cannot delete the last admin account." }); for (const [deviceId, ownerId] of Object.entries(data.devices)) if (ownerId === target.id) delete data.devices[deviceId]; if (target.pinKey) delete data.pinIndex[target.pinKey]; delete data.bans.account[target.id]; data.messages = data.messages.filter((message) => message.authorId !== target.id); delete data.accounts[target.id]; save(); for (const other of socketsFor(target.id)) other.disconnect(true); io.to("chat").emit("account deleted", target.id); broadcastPresence(); acknowledge?.({ ok: true }); });
  socket.on("presence state", (state) => { if (socket.data.accountId) { socket.data.visibility = state === "away" ? "away" : "online"; broadcastPresence(); } }); socket.on("leave chat", () => socket.disconnect(true));
  socket.on("voice config", (acknowledge) => { const account = mustUser(socket, acknowledge); if (account) acknowledge?.({ ok: true, iceServers: voiceIceServers(account) }); });
  socket.on("voice join", (_, acknowledge) => { const account = mustUser(socket, acknowledge); if (!account) return; if (voiceAccounts().has(account.id)) return acknowledge?.({ ok: false, error: "You are already in voice chat in another tab." }); const peers = voiceParticipants(); socket.join("voice"); socket.emit("voice participants", peers); socket.to("voice").emit("voice participant joined", { id: socket.id, name: shownName(account), avatar: account.avatar || "" }); broadcastPresence(); acknowledge?.({ ok: true, name: shownName(account) }); });
  socket.on("voice signal", ({ target, signal }) => { const account = data.accounts[socket.data.accountId]; if (socket.rooms.has("voice") && target && signal && account) io.to(target).emit("voice signal", { from: socket.id, name: shownName(account), avatar: account.avatar || "", signal }); }); socket.on("voice leave", () => { if (socket.rooms.has("voice")) { socket.to("voice").emit("voice participant left", socket.id); socket.leave("voice"); broadcastPresence(); } }); socket.on("disconnect", () => broadcastPresence());
});
server.listen(PORT, "0.0.0.0", () => console.log(`Chat is running at http://localhost:${PORT}`));
