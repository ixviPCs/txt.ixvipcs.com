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
const savedNameKey = "open-chat-display-name";

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function renderMessage(message) {
  const item = document.createElement("li");
  if (message.type === "system") {
    item.className = "system-message";
    item.textContent = message.text;
  } else {
    item.className = "chat-message";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const author = document.createElement("strong");
    author.textContent = message.name;
    const time = document.createElement("time");
    time.textContent = timeLabel(message.timestamp);
    meta.append(author, time);
    const text = document.createElement("p");
    text.textContent = message.text;
    item.append(meta, text);
  }
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
}

function enterChat(name) {
  identity.textContent = `Chatting as ${name}`;
  namePanel.hidden = true;
  chatPanel.hidden = false;
  messageInput.disabled = false;
  document.querySelector("#send").disabled = false;
}

function setName(name, focusMessage = false) {
  socket.emit("set name", name, (result) => {
    if (!result?.ok) {
      nameError.textContent = result?.error || "Could not save your name.";
      return;
    }
    localStorage.setItem(savedNameKey, result.name);
    enterChat(result.name);
    if (focusMessage) messageInput.focus();
  });
}

socket.on("history", (history) => {
  messages.replaceChildren();
  history.forEach(renderMessage);
});
socket.on("message", renderMessage);
socket.on("connect", () => {
  chatError.textContent = "";
  const savedName = localStorage.getItem(savedNameKey);
  if (savedName) setName(savedName);
});
socket.on("disconnect", () => { chatError.textContent = "Connection lost. Reconnecting…"; });

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  nameError.textContent = "";
  setName(nameInput.value, true);
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
  chatPanel.hidden = true;
  namePanel.hidden = false;
  nameInput.value = localStorage.getItem(savedNameKey) || "";
  nameInput.focus();
});
