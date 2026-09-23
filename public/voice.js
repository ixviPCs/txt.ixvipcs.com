const socket = io();
const name = localStorage.getItem("open-chat-display-name");
const grid = document.querySelector("#voice-grid");
const participantList = document.querySelector("#voice-list");
const participantCount = document.querySelector("#voice-count");
const status = document.querySelector("#voice-status");
const muteButton = document.querySelector("#mute");
const deafenButton = document.querySelector("#deafen");
const leaveButton = document.querySelector("#leave-voice");
const participants = new Map();
const connections = new Map();
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
let stream;
let muted = false;
let deafened = false;
let audioContext;

if (!name) window.location.replace("/");
document.querySelector("#voice-identity").textContent = `Voice as ${name}`;

function updatePeople() {
  const people = [...participants.values()];
  participantCount.textContent = `${people.length} in voice`;
  participantList.replaceChildren();
  people.forEach((person) => {
    const item = document.createElement("li");
    item.textContent = person.name + (person.id === socket.id ? " (you)" : "");
    participantList.append(item);
  });
}

function addCard(id, displayName, isSelf = false) {
  if (document.querySelector(`[data-participant="${CSS.escape(id)}"]`)) return;
  const card = document.createElement("article");
  card.className = "voice-card";
  card.dataset.participant = id;
  const initials = document.createElement("span");
  initials.className = "voice-initials";
  initials.textContent = displayName.slice(0, 2).toUpperCase();
  const label = document.createElement("strong");
  label.textContent = isSelf ? `${displayName} (you)` : displayName;
  card.append(initials, label);
  grid.append(card);
}

function removeParticipant(id) {
  connections.get(id)?.close();
  connections.delete(id);
  participants.delete(id);
  document.querySelector(`[data-participant="${CSS.escape(id)}"]`)?.remove();
  updatePeople();
}

function monitorAudio(id, audioStream) {
  audioContext ||= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(audioStream).connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
    if (!card) return;
    analyser.getByteFrequencyData(samples);
    const level = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    card.classList.toggle("talking", level > 10);
    requestAnimationFrame(tick);
  };
  tick();
}

function makeConnection(peerId, peerName) {
  if (connections.has(peerId)) return connections.get(peerId);
  participants.set(peerId, { id: peerId, name: peerName });
  addCard(peerId, peerName);
  updatePeople();
  const connection = new RTCPeerConnection(rtcConfig);
  connections.set(peerId, connection);
  stream.getTracks().forEach((track) => connection.addTrack(track, stream));
  connection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("voice signal", { target: peerId, signal: { candidate } });
  };
  connection.ontrack = ({ streams }) => {
    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = streams[0];
    audio.muted = deafened;
    connection.remoteAudio = audio;
    monitorAudio(peerId, streams[0]);
  };
  connection.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(connection.connectionState)) removeParticipant(peerId);
  };
  return connection;
}

async function callPeer(peer) {
  const connection = makeConnection(peer.id, peer.name);
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  socket.emit("voice signal", { target: peer.id, signal: { description: connection.localDescription } });
}

socket.on("voice participants", (peers) => peers.forEach(callPeer));
socket.on("voice participant joined", callPeer);
socket.on("voice participant left", removeParticipant);
socket.on("voice signal", async ({ from, name: peerName, signal }) => {
  const connection = makeConnection(from, peerName);
  try {
    if (signal.description) {
      await connection.setRemoteDescription(signal.description);
      if (signal.description.type === "offer") {
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        socket.emit("voice signal", { target: from, signal: { description: connection.localDescription } });
      }
    } else if (signal.candidate) await connection.addIceCandidate(signal.candidate);
  } catch (error) { console.error("Voice connection error:", error); }
});

muteButton.addEventListener("click", () => {
  muted = !muted;
  stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  muteButton.textContent = muted ? "Unmute" : "Mute";
  muteButton.classList.toggle("active-control", muted);
});

deafenButton.addEventListener("click", () => {
  deafened = !deafened;
  connections.forEach((connection) => { if (connection.remoteAudio) connection.remoteAudio.muted = deafened; });
  stream.getAudioTracks().forEach((track) => { track.enabled = !deafened && !muted; });
  deafenButton.textContent = deafened ? "Undeafen" : "Deafen";
  deafenButton.classList.toggle("active-control", deafened);
});

function leaveVoice() {
  socket.emit("voice leave");
  stream?.getTracks().forEach((track) => track.stop());
  connections.forEach((connection) => connection.close());
  window.close();
  setTimeout(() => window.location.assign("/"), 150);
}

leaveButton.addEventListener("click", leaveVoice);
window.addEventListener("pagehide", () => socket.emit("voice leave"));

async function joinVoice() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    participants.set(socket.id, { id: socket.id, name });
    addCard(socket.id, name, true);
    monitorAudio(socket.id, stream);
    updatePeople();
    socket.emit("voice join", { name, clientId: localStorage.getItem("open-chat-client-id") }, (result) => {
      if (!result?.ok) status.textContent = result?.error || "Could not join voice.";
      else status.textContent = "You are connected.";
    });
  } catch (error) {
    status.textContent = "Microphone access is needed to join voice chat. Allow it in your browser, then reload this page.";
  }
}

socket.on("connect", joinVoice);
