const socket = io();
const namePanel = document.querySelector("#name-panel");
const chatPanel = document.querySelector("#chat-panel");
const nameForm = document.querySelector("#name-form");
const messageForm = document.querySelector("#message-form");
const nameInput = document.querySelector("#name");
const messageInput = document.querySelector("#message");
const messages = document.querySelector("#messages");
const identity = document.querySelector("#identity");
const nameError = document.querySelector("#name-error");
const chatError = document.querySelector("#chat-error");
const changeName = document.querySelector("#change-name");
const leaveChat = document.querySelector("#leave-chat");
const onlineCount = document.querySelector("#online-count");
const onlineList = document.querySelector("#online-list");
const leaveDialog = document.querySelector("#leave-dialog");
const voiceButton = document.querySelector(".voice-button");
const savedNameKey = "open-chat-display-name";
const clientIdKey = "open-chat-client-id";
const leftChatKey = "open-chat-left";
let intentionallyLeft = localStorage.getItem(leftChatKey) === "true";
let chatHistory = [];
let clientId = localStorage.getItem(clientIdKey);
if (!clientId) {
  clientId = crypto.randomUUID();
  localStorage.setItem(clientIdKey, clientId);
}

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function renderHistory() {
  messages.replaceChildren();
  let previousChatMessage;
  chatHistory.forEach((message) => {
    const grouped = message.type === "chat" && Boolean(message.authorId) && previousChatMessage?.authorId === message.authorId && message.timestamp - previousChatMessage.timestamp <= 180_000;
    renderMessage(message, grouped);
    if (message.type === "chat") previousChatMessage = message;
  });
  messages.scrollTop = messages.scrollHeight;
}

function renderMessage(message, grouped = false) {
  const item = document.createElement("li");
  if (message.id) item.dataset.messageId = message.id;
  if (message.type === "system") {
    item.className = "system-message";
    item.textContent = message.text;
  } else {
    item.className = `chat-message${grouped ? " grouped-message" : ""}`;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const author = document.createElement("strong");
    author.textContent = message.name;
    const time = document.createElement("time");
    time.textContent = timeLabel(message.timestamp) + (message.editedAt ? " · edited" : "");
    if (!grouped) meta.append(author, time);
    const text = document.createElement("p");
    text.textContent = message.text;
    if (grouped) {
      const hoverTime = document.createElement("time");
      hoverTime.className = "grouped-time";
      hoverTime.textContent = timeLabel(message.timestamp) + (message.editedAt ? " · edited" : "");
      item.append(hoverTime);
    }
    item.append(meta, text);
    if (message.authorId === clientId && message.id) {
      const actions = document.createElement("div");
      actions.className = "message-actions";
      const edit = document.createElement("button");
      edit.className = "message-action";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => editMessage(message));
      const remove = document.createElement("button");
      remove.className = "message-action delete-action";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteMessage(message.id));
      actions.append(edit, remove);
      item.append(actions);
    }
  }
  messages.append(item);
}

function editMessage(message) {
  const text = window.prompt("Edit your message:", message.text);
  if (text === null || text.trim() === message.text) return;
  socket.emit("edit message", { id: message.id, text }, (result) => {
    if (!result?.ok) chatError.textContent = result?.error || "Message could not be edited.";
  });
}

function deleteMessage(id) {
  if (!window.confirm("Delete this message?")) return;
  socket.emit("delete message", { id }, (result) => {
    if (!result?.ok) chatError.textContent = result?.error || "Message could not be deleted.";
  });
}

function enterChat(name) {
  identity.textContent = `Chatting as ${name}`;
  namePanel.hidden = true;
  chatPanel.hidden = false;
  messageInput.disabled = false;
  document.querySelector("#send").disabled = false;
  changeName.disabled = false;
}

function showNamePanel() {
  chatPanel.hidden = true;
  namePanel.hidden = false;
  nameInput.value = localStorage.getItem(savedNameKey) || "";
  nameInput.focus();
}

function setName(name, focusMessage = false) {
  socket.emit("set name", { name, clientId, announceJoin: intentionallyLeft }, (result) => {
    if (!result?.ok) {
      nameError.textContent = result?.error || "Could not save your name.";
      return;
    }
    localStorage.setItem(savedNameKey, result.name);
    intentionallyLeft = false;
    localStorage.removeItem(leftChatKey);
    enterChat(result.name);
    if (focusMessage) messageInput.focus();
  });
}

function submitName(name, focusMessage = false) {
  if (!socket.connected) {
    socket.once("connect", () => setName(name, focusMessage));
    socket.connect();
    return;
  }
  setName(name, focusMessage);
}

socket.on("history", (receivedHistory) => {
  chatHistory = receivedHistory;
  renderHistory();
});
socket.on("message", (message) => {
  chatHistory.push(message);
  renderHistory();
});
socket.on("message updated", ({ id, text, editedAt }) => {
  const message = chatHistory.find((item) => item.id === id);
  if (!message) return;
  message.text = text;
  message.editedAt = editedAt;
  renderHistory();
});
socket.on("message deleted", (id) => {
  chatHistory = chatHistory.filter((item) => item.id !== id);
  renderHistory();
});
socket.on("presence users", (users) => {
  const online = users.filter((user) => user.status === "online").length;
  onlineCount.textContent = `${online} online`;
  const voiceNames = users.filter((user) => user.voice).map((user) => user.name);
  voiceButton.title = voiceNames.length ? `In voice: ${voiceNames.join(", ")}` : "Nobody is in voice chat.";
  onlineList.replaceChildren();
  users.forEach((user) => {
    const person = document.createElement("li");
    person.className = `status-${user.status}`;
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const label = document.createElement("span");
    label.textContent = `${user.name} · ${user.status}${user.voice ? " · in voice" : ""}`;
    person.append(dot, label);
    onlineList.append(person);
  });
});
socket.on("identity name", (name) => {
  localStorage.setItem(savedNameKey, name);
  identity.textContent = `Chatting as ${name}`;
});
socket.on("connect", () => {
  chatError.textContent = "";
  const savedName = localStorage.getItem(savedNameKey);
  if (savedName && !intentionallyLeft) setName(savedName);
});
socket.on("disconnect", () => {
  if (intentionallyLeft) return;
  chatError.textContent = "Connection lost. Reconnecting…";
});

function updatePresence() {
  if (socket.connected) socket.emit("presence state", document.visibilityState === "visible" ? "online" : "away");
}
document.addEventListener("visibilitychange", updatePresence);
window.addEventListener("focus", updatePresence);
window.addEventListener("blur", updatePresence);

if (localStorage.getItem(savedNameKey) && !intentionallyLeft) {
  chatPanel.hidden = false;
} else {
  showNamePanel();
}

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  nameError.textContent = "";
  submitName(nameInput.value, true);
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  chatError.textContent = "";
  socket.emit("chat message", messageInput.value, (result) => {
    if (!result?.ok) chatError.textContent = result?.error || "Message could not be sent.";
  });
  messageInput.value = "";
  messageInput.focus();
});

changeName.addEventListener("click", () => {
  showNamePanel();
});

leaveChat.addEventListener("click", () => {
  leaveDialog.showModal();
});

leaveDialog.addEventListener("close", () => {
  if (leaveDialog.returnValue !== "confirm") return;
  intentionallyLeft = false;
  localStorage.setItem(leftChatKey, "true");
  intentionallyLeft = true;
  socket.emit("leave chat");
  chatError.textContent = "";
  showNamePanel();
});
