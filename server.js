const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
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
const messages = loadHistory();

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

function saveHistory() {
  try {
    const temporaryFile = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(messages), "utf8");
    fs.renameSync(temporaryFile, HISTORY_FILE);
  } catch (error) {
    console.error("Could not save chat history:", error.message);
  }
}

function onlineUsers() {
  return [...io.sockets.sockets.values()]
    .map((connectedSocket) => connectedSocket.data.name)
    .filter(Boolean)
    .sort((first, second) => first.localeCompare(second));
}

function broadcastOnlineUsers() {
  io.emit("online users", onlineUsers());
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
      return participant && { id: socketId, name: participant.data.voiceName };
    })
    .filter(Boolean);
}

io.on("connection", (socket) => {
  socket.emit("history", messages);
  socket.emit("online users", onlineUsers());

  socket.on("set name", (value, acknowledge) => {
    const requestedName = typeof value === "object" && value ? value.name : value;
    const announceJoin = Boolean(typeof value === "object" && value?.announceJoin);
    const name = cleanText(requestedName, MAX_NAME_LENGTH);
    if (!name) {
      acknowledge?.({ ok: false, error: "Choose a display name first." });
      return;
    }

    const previousName = socket.data.name;
    socket.data.name = name;
    acknowledge?.({ ok: true, name });
    broadcastOnlineUsers();
    if (previousName && previousName !== name) {
      addSystemMessage(`${previousName} is now ${name}.`);
    } else if (!previousName && announceJoin) addSystemMessage(`${name} joined the chat.`);
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
      name: socket.data.name,
      text,
      timestamp: Date.now()
    };
    messages.push(message);
    saveHistory();
    io.emit("message", message);
    acknowledge?.({ ok: true });
  });

  socket.on("leave chat", () => {
    if (socket.data.name) addSystemMessage(`${socket.data.name} left the chat.`);
    socket.disconnect(true);
  });

  socket.on("voice join", (value, acknowledge) => {
    const name = cleanText(value, MAX_NAME_LENGTH);
    if (!name) {
      acknowledge?.({ ok: false, error: "Choose a display name first." });
      return;
    }

    const peers = voiceParticipants();
    socket.data.voiceName = name;
    socket.join("voice");
    socket.emit("voice participants", peers);
    acknowledge?.({ ok: true, name });
  });

  socket.on("voice signal", ({ target, signal }) => {
    if (!socket.rooms.has("voice") || typeof target !== "string" || !signal) return;
    io.to(target).emit("voice signal", { from: socket.id, name: socket.data.voiceName, signal });
  });

  socket.on("voice leave", () => {
    if (!socket.rooms.has("voice")) return;
    socket.to("voice").emit("voice participant left", socket.id);
    socket.leave("voice");
  });

  socket.on("disconnect", () => {
    if (socket.data.voiceName) socket.to("voice").emit("voice participant left", socket.id);
    broadcastOnlineUsers();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chat is running at http://localhost:${PORT}`);
});
