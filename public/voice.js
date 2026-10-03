const socket = io();
const name = localStorage.getItem("open-chat-display-name");
const deviceId = localStorage.getItem("open-chat-device-id");
const grid = document.querySelector("#voice-grid");
const participantList = document.querySelector("#voice-list");
const participantCount = document.querySelector("#voice-count");
const status = document.querySelector("#voice-status");
const muteButton = document.querySelector("#mute");
const deafenButton = document.querySelector("#deafen");
const cameraButton = document.querySelector("#camera");
const flipCameraButton = document.querySelector("#flip-camera");
const shareScreenButton = document.querySelector("#share-screen");
const leaveButton = document.querySelector("#leave-voice");
const participants = new Map();
const connections = new Map();
let rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
let stream;
let cameraStream;
let screenStream;
let muted = false;
let deafened = false;
let audioContext;

if (!name || !deviceId) window.location.replace("/");
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

function addCard(id, displayName, avatar = "", isSelf = false) {
  let card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
  if (card) return card;
  card = document.createElement("article");
  card.className = "voice-card";
  card.dataset.participant = id;
  const initials = avatar ? document.createElement("img") : document.createElement("span");
  initials.className = "voice-initials";
  if (avatar) { initials.src = avatar; initials.alt = ""; } else initials.textContent = displayName.slice(0, 2).toUpperCase();
  const label = document.createElement("strong");
  label.textContent = isSelf ? `${displayName} (you)` : displayName;
  card.append(initials, label);
  grid.append(card);
  return card;
}

function addVideo(id, track, isSelf, label) {
  const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
  if (!card) return;
  const kind = label.toLowerCase();
  if (isSelf) clearVideoKind(id, kind);
  if (card.querySelector(`[data-video-track="${CSS.escape(track.id)}"]`)) return;
  let stage = card.querySelector(".voice-video-stage");
  if (!stage) { stage = document.createElement("div"); stage.className = "voice-video-stage"; card.prepend(stage); }
  const video = document.createElement("video");
  video.className = "voice-video" + (isSelf && label === "Camera" ? " self-camera" : "");
  video.dataset.videoTrack = track.id;
  video.dataset.videoKind = kind;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isSelf;
  video.srcObject = new MediaStream([track]);
  const badge = document.createElement("span");
  badge.className = "voice-video-label";
  badge.textContent = label;
  badge.dataset.videoTrack = track.id;
  badge.dataset.videoKind = kind;
  stage.append(video, badge);
  track.addEventListener("ended", () => removeVideo(id, track.id), { once: true });
}

function clearVideoKind(id, kind) {
  const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
  if (!card) return;
  card.querySelectorAll(`.voice-video[data-video-kind="${CSS.escape(kind)}"], .voice-video-label[data-video-kind="${CSS.escape(kind)}"]`).forEach((element) => element.remove());
  if (!card.querySelector(".voice-video")) card.querySelector(".voice-video-stage")?.remove();
}

function removeVideo(id, trackId) {
  const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
  if (!card) return;
  card.querySelector(`[data-video-track="${CSS.escape(trackId)}"]`)?.remove();
  card.querySelectorAll(`.voice-video-label[data-video-track="${CSS.escape(trackId)}"]`).forEach((badge) => badge.remove());
  if (!card.querySelector(".voice-video")) card.querySelector(".voice-video-stage")?.remove();
}

function removeParticipant(id) {
  connections.get(id)?.close();
  connections.delete(id);
  participants.delete(id);
  document.querySelector(`[data-participant="${CSS.escape(id)}"]`)?.remove();
  updatePeople();
}

function resetVoiceCards() {
  connections.forEach((connection) => connection.close());
  connections.clear();
  participants.clear();
  grid.replaceChildren();
}

function signalMediaState(kind, enabled, trackId) {
  connections.forEach((connection, peerId) => socket.emit("voice signal", { target: peerId, signal: { media: { kind, enabled, trackId } } }));
}

function monitorAudio(id, audioStream) {
  if (!audioStream.getAudioTracks().length) return;
  audioContext ||= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(audioStream).connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
    if (!card) return;
    analyser.getByteFrequencyData(samples);
    card.classList.toggle("talking", samples.reduce((sum, sample) => sum + sample, 0) / samples.length > 10);
    requestAnimationFrame(tick);
  };
  tick();
}

async function negotiate(peerId, connection) {
  if (connection.negotiating || connection.signalingState !== "stable") { connection.needsNegotiation = true; return; }
  connection.negotiating = true;
  try {
    connection.makingOffer = true;
    await connection.setLocalDescription(await connection.createOffer());
    socket.emit("voice signal", { target: peerId, signal: { description: connection.localDescription } });
  } catch (error) { console.error("Voice renegotiation error:", error); }
  finally { connection.makingOffer = false; connection.negotiating = false; }
}

function renegotiateConnections() { connections.forEach((connection, peerId) => negotiate(peerId, connection)); }
function addTrackToConnections(track, source) { connections.forEach((connection) => connection.addTrack(track, source)); }
function removeTracksFromConnections(oldStream) {
  if (!oldStream) return;
  const oldTracks = new Set(oldStream.getTracks());
  connections.forEach((connection) => connection.getSenders().forEach((sender) => { if (oldTracks.has(sender.track)) connection.removeTrack(sender); }));
}

function makeConnection(peerId, peerName, peerAvatar = "") {
  if (connections.has(peerId)) return connections.get(peerId);
  participants.set(peerId, { id: peerId, name: peerName });
  addCard(peerId, peerName, peerAvatar);
  updatePeople();
  const connection = new RTCPeerConnection(rtcConfig);
  connection.polite = socket.id > peerId;
  connections.set(peerId, connection);
  [stream, cameraStream, screenStream].filter(Boolean).forEach((source) => source.getTracks().forEach((track) => connection.addTrack(track, source)));
  connection.onicecandidate = ({ candidate }) => { if (candidate) socket.emit("voice signal", { target: peerId, signal: { candidate } }); };
  connection.ontrack = ({ track, streams }) => {
    const remoteStream = streams[0] || new MediaStream([track]);
    if (track.kind === "audio") {
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = remoteStream;
      audio.muted = deafened;
      connection.remoteAudio = audio;
      monitorAudio(peerId, remoteStream);
    } else {
      const kind = connection.remoteTrackKinds?.[track.id];
      addVideo(peerId, track, false, kind === "camera" ? "Camera" : kind === "screen" ? "Screen" : "Video");
    }
  };
  connection.onsignalingstatechange = () => {
    if (connection.signalingState === "stable" && connection.needsNegotiation) { connection.needsNegotiation = false; negotiate(peerId, connection); }
  };
  connection.onconnectionstatechange = () => { if (["failed", "closed"].includes(connection.connectionState)) removeParticipant(peerId); };
  return connection;
}

async function callPeer(peer) { const connection = makeConnection(peer.id, peer.name, peer.avatar); await negotiate(peer.id, connection); }
socket.on("voice participants", (peers) => peers.forEach(callPeer));
socket.on("voice participant joined", (peer) => makeConnection(peer.id, peer.name, peer.avatar));
socket.on("voice participant left", removeParticipant);
socket.on("voice signal", async ({ from, name: peerName, avatar, signal }) => {
  const connection = makeConnection(from, peerName, avatar);
  try {
    if (signal.media) {
      connection.remoteTrackKinds ||= {};
      if (signal.media.enabled) {
        connection.remoteTrackKinds[signal.media.trackId] = signal.media.kind;
        const card = document.querySelector(`[data-participant="${CSS.escape(from)}"]`);
        const video = card?.querySelector(`[data-video-track="${CSS.escape(signal.media.trackId)}"]`);
        const badge = card?.querySelector(`.voice-video-label[data-video-track="${CSS.escape(signal.media.trackId)}"]`);
        if (video) video.dataset.videoKind = signal.media.kind;
        if (badge) { badge.dataset.videoKind = signal.media.kind; badge.textContent = signal.media.kind === "camera" ? "Camera" : "Screen"; }
      } else {
        delete connection.remoteTrackKinds[signal.media.trackId];
        clearVideoKind(from, signal.media.kind);
      }
      return;
    }
    if (signal.description) {
      const collision = signal.description.type === "offer" && (connection.makingOffer || connection.signalingState !== "stable");
      connection.ignoreOffer = !connection.polite && collision;
      if (connection.ignoreOffer) return;
      if (collision) await connection.setLocalDescription({ type: "rollback" });
      await connection.setRemoteDescription(signal.description);
      if (signal.description.type === "offer") {
        await connection.setLocalDescription(await connection.createAnswer());
        socket.emit("voice signal", { target: from, signal: { description: connection.localDescription } });
      }
    } else if (signal.candidate && !connection.ignoreOffer) await connection.addIceCandidate(signal.candidate);
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

async function refreshCameraOptions() {
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  flipCameraButton.hidden = cameras.length < 2;
}
function stopCamera() {
  if (!cameraStream) return;
  const oldStream = cameraStream;
  cameraStream = undefined;
  const oldTrackId = oldStream.getVideoTracks()[0]?.id;
  signalMediaState("camera", false, oldTrackId);
  removeTracksFromConnections(oldStream);
  clearVideoKind(socket.id, "camera");
  oldStream.getVideoTracks().forEach((track) => track.stop());
  cameraButton.textContent = "Camera";
  cameraButton.classList.remove("active-control");
  flipCameraButton.hidden = true;
  renegotiateConnections();
}
async function startCamera(preferredDeviceId) {
  try {
    const video = preferredDeviceId ? { deviceId: { exact: preferredDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { facingMode: { ideal: "user" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    const nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    const oldStream = cameraStream;
    cameraStream = nextStream;
    if (oldStream) removeTracksFromConnections(oldStream);
    clearVideoKind(socket.id, "camera");
    oldStream?.getTracks().forEach((track) => track.stop());
    nextStream.getVideoTracks().forEach((track) => { addVideo(socket.id, track, true, "Camera"); addTrackToConnections(track, nextStream); signalMediaState("camera", true, track.id); });
    cameraButton.textContent = "Camera off";
    cameraButton.classList.add("active-control");
    await refreshCameraOptions();
    status.textContent = "Camera is on.";
    renegotiateConnections();
  } catch (error) { status.textContent = "Camera access was not allowed or is unavailable."; }
}
cameraButton.addEventListener("click", () => cameraStream ? stopCamera() : startCamera());
flipCameraButton.addEventListener("click", async () => {
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  const currentId = cameraStream?.getVideoTracks()[0]?.getSettings().deviceId;
  const index = cameras.findIndex((device) => device.deviceId === currentId);
  if (cameras.length > 1) startCamera(cameras[(index + 1) % cameras.length].deviceId);
});

function stopScreenShare() {
  if (!screenStream) return;
  const oldStream = screenStream;
  screenStream = undefined;
  const oldTrackId = oldStream.getVideoTracks()[0]?.id;
  signalMediaState("screen", false, oldTrackId);
  removeTracksFromConnections(oldStream);
  clearVideoKind(socket.id, "screen");
  oldStream.getVideoTracks().forEach((track) => track.stop());
  shareScreenButton.textContent = "Share screen";
  shareScreenButton.classList.remove("active-control");
  status.textContent = "Screen sharing stopped.";
  renegotiateConnections();
}
async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    const track = screenStream.getVideoTracks()[0];
    track.addEventListener("ended", stopScreenShare, { once: true });
    addVideo(socket.id, track, true, "Screen");
    addTrackToConnections(track, screenStream);
    signalMediaState("screen", true, track.id);
    shareScreenButton.textContent = "Stop sharing";
    shareScreenButton.classList.add("active-control");
    status.textContent = "You are sharing your screen.";
    renegotiateConnections();
  } catch (error) { status.textContent = "Screen sharing was cancelled or is unavailable."; }
}
shareScreenButton.addEventListener("click", () => screenStream ? stopScreenShare() : startScreenShare());

function leaveVoice() {
  socket.emit("voice leave");
  [stream, cameraStream, screenStream].filter(Boolean).forEach((source) => source.getTracks().forEach((track) => track.stop()));
  connections.forEach((connection) => connection.close());
  window.close();
  setTimeout(() => window.location.assign("/"), 150);
}
leaveButton.addEventListener("click", leaveVoice);
window.addEventListener("pagehide", () => socket.emit("voice leave"));

async function joinVoice() {
  try {
    if (stream) {
      [stream, cameraStream, screenStream].filter(Boolean).forEach((source) => source.getTracks().forEach((track) => track.stop()));
      stream = undefined;
      cameraStream = undefined;
      screenStream = undefined;
      resetVoiceCards();
      cameraButton.textContent = "Camera";
      shareScreenButton.textContent = "Share screen";
      flipCameraButton.hidden = true;
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    participants.set(socket.id, { id: socket.id, name });
    addCard(socket.id, name, localStorage.getItem("open-chat-avatar") || "", true);
    monitorAudio(socket.id, stream);
    updatePeople();
    socket.emit("voice join", {}, (result) => { status.textContent = result?.ok ? "You are connected. Turn on camera or share a screen when ready." : result?.error || "Could not join voice."; });
  } catch (error) { status.textContent = "Microphone access is needed to join voice chat. Allow it in your browser, then reload this page."; }
}
socket.on("connect", () => socket.emit("join", { mode: "create", deviceId }, (result) => {
  if (!result?.ok) return status.textContent = result?.error || "Could not verify your account.";
  socket.emit("voice config", (config) => { if (config?.ok) rtcConfig = { iceServers: config.iceServers }; joinVoice(); });
}));
