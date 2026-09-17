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

function addSystemMessage(text) {
  const message = { type: "system", text, timestamp: Date.now() };
  messages.push(message);
  saveHistory();
  io.emit("message", message);
}

io.on("connection", (socket) => {
  socket.emit("history", messages);

  socket.on("set name", (value, acknowledge) => {
    const name = cleanText(value, MAX_NAME_LENGTH);
    if (!name) {
      acknowledge?.({ ok: false, error: "Choose a display name first." });
      return;
    }

    const previousName = socket.data.name;
    socket.data.name = name;
    acknowledge?.({ ok: true, name });
    if (previousName && previousName !== name) addSystemMessage(`${previousName} is now ${name}.`);
    else if (!previousName) addSystemMessage(`${name} joined the chat.`);
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

  socket.on("disconnect", () => {
    if (socket.data.name) addSystemMessage(`${socket.data.name} left the chat.`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chat is running at http://localhost:${PORT}`);
});
