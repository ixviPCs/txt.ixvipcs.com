const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10_000
});

const PORT = Number(process.env.PORT) || 3000;
const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 1_000;
const HISTORY_FILE = path.join(__dirname, "chat-history.json");
const USERS_FILE = path.join(__dirname, "known-users.json");
const messages = loadHistory();
const knownUsers = loadJson(USERS_FILE, {});

app.use(express.static(path.join(__dirname, "public")));

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function loadHistory() {
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(history) ? history : [];
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read chat history:", error.message);
    return [];
  }
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") console.error(`Could not read ${file}:`, error.message);
    return fallback;
  }
}

function saveHistory() {
  try {
    const temporaryFile = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(messages), "utf8");
    fs.renameSync(temporaryFile, HISTORY_FILE);
  } catch (error) {
    console.error("Could not save chat history:", error.message);
  }
}

function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(knownUsers), "utf8"); }
  catch (error) { console.error("Could not save known users:", error.message); }
}

function cleanClientId(value) {
  return typeof value === "string" && /^[a-z0-9-]{16,80}$/i.test(value) ? value : "";
}

function cleanAvatar(value) {
  return typeof value === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value) && value.length <= 1_400_000 ? value : "";
}

function socketsFor(clientId) {
  return [...io.sockets.sockets.values()].filter((connectedSocket) => connectedSocket.data.clientId === clientId);
}

function voiceClientIds() {
  return new Set([...(io.sockets.adapter.rooms.get("voice") || [])]
    .map((socketId) => io.sockets.sockets.get(socketId)?.data.clientId)
    .filter(Boolean));
}

function presenceUsers() {
  const inVoice = voiceClientIds();
  return Object.entries(knownUsers).map(([id, user]) => {
    const sockets = socketsFor(id);
    const status = sockets.length === 0 ? "offline" : sockets.some((item) => item.data.visibility === "online") ? "online" : "away";
    return { id, name: user.name, status, voice: inVoice.has(id) };
  }).sort((first, second) => first.name.localeCompare(second.name));
}

function broadcastPresence() {
  io.emit("presence users", presenceUsers());
}

function bindIdentity(socket, requestedName, requestedClientId, requestedAvatar) {
  const clientId = cleanClientId(requestedClientId);
  const name = cleanText(requestedName, MAX_NAME_LENGTH);
  if (!clientId || !name) return { error: "Choose a display name first." };
  const duplicate = Object.entries(knownUsers).find(([id, user]) => id !== clientId && user.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicate) return { error: "That display name is already in use." };

  const oldName = knownUsers[clientId]?.name;
  socket.data.clientId = clientId;
  socket.data.name = name;
  socket.data.visibility ||= "online";
  socket.join(`identity:${clientId}`);
  const avatar = cleanAvatar(requestedAvatar) || knownUsers[clientId]?.avatar || "";
  knownUsers[clientId] = { name, avatar, lastSeen: Date.now() };
  saveUsers();
  io.to(`identity:${clientId}`).emit("identity name", name);
  io.emit("user profile updated", { id: clientId, name, avatar });
  return { clientId, name, oldName, avatar };
}

function addSystemMessage(text) {
  const message = { type: "system", text, timestamp: Date.now() };
  messages.push(message);
  saveHistory();
  io.emit("message", message);
}

function voiceParticipants() {
  return [...(io.sockets.adapter.rooms.get("voice") || [])]
    .map((socketId) => {
      const participant = io.sockets.sockets.get(socketId);
      return participant && { id: socketId, name: participant.data.name, clientId: participant.data.clientId };
    })
    .filter(Boolean);
}

io.on("connection", (socket) => {
  socket.emit("history", messages);
  socket.emit("presence users", presenceUsers());

  socket.on("set name", (value, acknowledge) => {
    const requestedName = typeof value === "object" && value ? value.name : value;
    const requestedClientId = typeof value === "object" && value ? value.clientId : "";
    const announceJoin = Boolean(typeof value === "object" && value?.announceJoin);
    const previousConnections = cleanClientId(requestedClientId) ? socketsFor(requestedClientId).filter((item) => item.id !== socket.id).length : 0;
    const identity = bindIdentity(socket, requestedName, requestedClientId, value?.avatar);
    if (identity.error) {
      acknowledge?.({ ok: false, error: identity.error });
      return;
    }
    acknowledge?.({ ok: true, name: identity.name });
    broadcastPresence();
    if (identity.oldName && identity.oldName !== identity.name) addSystemMessage(`${identity.oldName} is now ${identity.name}.`);
    else if (announceJoin && previousConnections === 0) addSystemMessage(`${identity.name} joined the chat.`);
  });

  socket.on("chat message", (value, acknowledge) => {
    if (!socket.data.name) {
      acknowledge?.({ ok: false, error: "Choose a display name first." });
      return;
    }

    const text = cleanText(value, MAX_MESSAGE_LENGTH);
    if (!text) return;

    const message = {
      type: "chat",
      id: randomUUID(),
      authorId: socket.data.clientId,
      name: socket.data.name,
      avatar: knownUsers[socket.data.clientId]?.avatar || "",
      text,
      timestamp: Date.now()
    };
    messages.push(message);
    saveHistory();
    io.emit("message", message);
    acknowledge?.({ ok: true });
  });

  socket.on("edit message", ({ id, text }, acknowledge) => {
    const message = messages.find((item) => item.id === id && item.authorId === socket.data.clientId);
    const updatedText = cleanText(text, MAX_MESSAGE_LENGTH);
    if (!message || !updatedText) return acknowledge?.({ ok: false, error: "Message could not be edited." });
    message.text = updatedText;
    message.editedAt = Date.now();
    saveHistory();
    io.emit("message updated", { id, text: updatedText, editedAt: message.editedAt });
    acknowledge?.({ ok: true });
  });

  socket.on("delete message", ({ id }, acknowledge) => {
    const index = messages.findIndex((item) => item.id === id && item.authorId === socket.data.clientId);
    if (index === -1) return acknowledge?.({ ok: false, error: "Message could not be deleted." });
    messages.splice(index, 1);
    saveHistory();
    io.emit("message deleted", id);
    acknowledge?.({ ok: true });
  });

  socket.on("leave chat", () => {
    if (socket.data.name && socketsFor(socket.data.clientId).filter((item) => item.id !== socket.id).length === 0) addSystemMessage(`${socket.data.name} left the chat.`);
    socket.disconnect(true);
  });

  socket.on("presence state", (state) => {
    if (!socket.data.clientId) return;
    socket.data.visibility = state === "away" ? "away" : "online";
    broadcastPresence();
  });

  socket.on("voice join", (value, acknowledge) => {
    const identity = bindIdentity(socket, value?.name, value?.clientId);
    if (identity.error) {
      acknowledge?.({ ok: false, error: identity.error });
      return;
    }
    if (voiceParticipants().some((participant) => participant.clientId === identity.clientId)) return acknowledge?.({ ok: false, error: "You are already in voice chat in another tab." });

    const peers = voiceParticipants();
    socket.join("voice");
    socket.emit("voice participants", peers);
    broadcastPresence();
    acknowledge?.({ ok: true, name: identity.name });
  });

  socket.on("voice signal", ({ target, signal }) => {
    if (!socket.rooms.has("voice") || typeof target !== "string" || !signal) return;
    io.to(target).emit("voice signal", { from: socket.id, name: socket.data.name, signal });
  });

  socket.on("voice leave", () => {
    if (!socket.rooms.has("voice")) return;
    socket.to("voice").emit("voice participant left", socket.id);
    socket.leave("voice");
    broadcastPresence();
  });

  socket.on("disconnect", () => {
    if (socket.rooms.has("voice")) socket.to("voice").emit("voice participant left", socket.id);
    broadcastPresence();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chat is running at http://localhost:${PORT}`);
});
