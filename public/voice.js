const socket = io();
let name = localStorage.getItem("open-chat-display-name");
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
const adminTools = document.querySelector("#admin-tools");
const invisibleToggle = document.querySelector("#admin-invisible-toggle");
const participants = new Map();
const connections = new Map();
let rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
let stream;
let cameraStream;
let screenStream;
let muted = false;
let deafened = false;
let isAdmin = false;
let kickedFromVoice = false;
let audioContext;

if (!name || !deviceId) window.location.replace("/");
document.querySelector("#voice-identity").textContent = `Voice as ${name}`;
const hiddenAdminIndicator = document.createElement("span");hiddenAdminIndicator.className="hidden-admin-indicator";hiddenAdminIndicator.hidden=true;hiddenAdminIndicator.setAttribute("role","status");hiddenAdminIndicator.innerHTML='<span class="hidden-admin-dot" aria-hidden="true"></span>Hidden admin in VC';document.querySelector("#voice-identity").after(hiddenAdminIndicator);
let isInvisible = false;

function applyInvisibleMode(enabled) { isInvisible=!!enabled; const self=participants.get(socket.id); if(self){self.invisible=isInvisible;if(isInvisible)document.querySelector(`[data-participant="${CSS.escape(socket.id)}"]`)?.remove();else addCard(socket.id,self.name,localStorage.getItem("open-chat-avatar")||"",true)}if(isInvisible){stopCamera();stopScreenShare()}[cameraButton,flipCameraButton,shareScreenButton].forEach(button=>{button.disabled=isInvisible});updatePeople() }

invisibleToggle?.addEventListener("change",()=>{invisibleToggle.disabled=true;socket.emit("set admin invisible",invisibleToggle.checked,result=>{invisibleToggle.disabled=false;if(!result?.ok){invisibleToggle.checked=!invisibleToggle.checked;status.textContent=result?.error||"Could not update invisible mode."}else invisibleToggle.checked=result.invisible})});
socket.on("admin invisible state",({enabled})=>{if(invisibleToggle)invisibleToggle.checked=!!enabled;applyInvisibleMode(!!enabled)});

function updatePeople() {
  const people = [...participants.values()].filter(person=>!person.invisible);
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
  if (card) { addKickButton(card, id, displayName); return card; }
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
  addKickButton(card, id, displayName);
  return card;
}

function addKickButton(card, id, displayName) {
  if (!isAdmin || id === socket.id || card.querySelector(".voice-kick-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "voice-kick-button danger-button";
  button.textContent = "Kick";
  button.title = `Remove ${displayName} from voice chat`;
  button.setAttribute("aria-label", `Remove ${displayName} from voice chat`);
  button.addEventListener("click", () => {
    button.disabled = true;
    socket.emit("voice kick", id, (result) => {
      if (!result?.ok) {
        button.disabled = false;
        status.textContent = result?.error || "Could not remove that participant.";
        return;
      }
      status.textContent = `${displayName} was removed from voice chat.`;
    });
  });
  card.append(button);
}

function addVideo(id, track, isSelf, label, mediaStreamId = "") {
  const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
  if (!card) return;
  const kind = label.toLowerCase();
  if (kind === "camera") clearCameraVideos(id);
  else if (isSelf || kind === "screen") clearVideoKind(id, kind);
  if (card.querySelector(`[data-video-track="${CSS.escape(track.id)}"]`)) return;
  let stage = card.querySelector(".voice-video-stage");
  if (!stage) { stage = document.createElement("div"); stage.className = "voice-video-stage"; card.prepend(stage); }
  const video = document.createElement("video");
  video.className = "voice-video" + (isSelf && label === "Camera" ? " self-camera" : "");
  video.dataset.videoTrack = track.id;
  video.dataset.videoKind = kind;
  if (mediaStreamId) video.dataset.videoStream = mediaStreamId;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isSelf;
  video.srcObject = new MediaStream([track]);
  const badge = document.createElement("span");
  badge.className = "voice-video-label";
  badge.textContent = label;
  badge.dataset.videoTrack = track.id;
  badge.dataset.videoKind = kind;
  if (mediaStreamId) badge.dataset.videoStream = mediaStreamId;
  stage.append(video, badge);
  track.addEventListener("ended", () => removeVideo(id, track.id), { once: true });
}

function clearVideoKind(id, kind) {
  const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
  if (!card) return;
  card.querySelectorAll(`.voice-video[data-video-kind="${CSS.escape(kind)}"], .voice-video-label[data-video-kind="${CSS.escape(kind)}"]`).forEach((element) => element.remove());
  if (!card.querySelector(".voice-video")) card.querySelector(".voice-video-stage")?.remove();
}

function clearCameraVideos(id, keepTrackId = "") {
  const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
  if (!card) return;
  const tracks = new Set([...card.querySelectorAll('.voice-video[data-video-kind="camera"], .voice-video[data-video-kind="video"]')]
    .map((video) => video.dataset.videoTrack)
    .filter((trackId) => trackId && trackId !== keepTrackId));
  tracks.forEach((trackId) => removeVideo(id, trackId));
  if (!keepTrackId) card.querySelectorAll('.voice-video-label[data-video-kind="camera"], .voice-video-label[data-video-kind="video"]').forEach((badge) => badge.remove());
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

function signalMediaState(kind, enabled, trackId, streamId, targetId) {
  const peers = targetId ? [[targetId, connections.get(targetId)]] : [...connections.entries()];
  peers.forEach(([peerId, connection]) => {
    if (connection) socket.emit("voice signal", { target: peerId, signal: { media: { kind, enabled, trackId, streamId } } });
  });
}

function sendCurrentMediaState(peerId) {
  [["camera", cameraStream], ["screen", screenStream]].forEach(([kind, source]) => {
    if (source) signalMediaState(kind, true, source.getVideoTracks()[0]?.id, source.id, peerId);
  });
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

function makeConnection(peerId, peerName = "Hidden admin", peerAvatar = "", invisible = false) {
  if (connections.has(peerId)) return connections.get(peerId);
  participants.set(peerId, { id: peerId, name: peerName || "Hidden admin", avatar: peerAvatar || "", invisible });
  if(!invisible)addCard(peerId, peerName || "Hidden admin", peerAvatar);
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
      if (connection.remoteRetiredStreams?.has(remoteStream.id)) return;
      const mediaKinds = Object.entries(connection.remoteMediaKinds || {});
      const matchingKind = mediaKinds.find(([, state]) => state.enabled && state.streamId === remoteStream.id)?.[0];
      const activeKinds = mediaKinds.filter(([, state]) => state.enabled);
      let kind = connection.remoteStreamKinds?.[remoteStream.id] || matchingKind;
      if (!kind && connection.remoteMediaKinds) {
        if (activeKinds.length !== 1 || (activeKinds[0][1].streamId && activeKinds[0][1].streamId !== remoteStream.id)) return;
        kind = activeKinds[0][0];
      }
      kind ||= "video";
      if(!participants.get(peerId)?.invisible)addVideo(peerId, track, false, kind === "camera" ? "Camera" : kind === "screen" ? "Screen" : "Video", remoteStream.id);
    }
  };
  connection.onsignalingstatechange = () => {
    if (connection.signalingState === "stable" && connection.needsNegotiation) { connection.needsNegotiation = false; negotiate(peerId, connection); }
  };
  connection.onconnectionstatechange = () => { if (["failed", "closed"].includes(connection.connectionState)) removeParticipant(peerId); };
  sendCurrentMediaState(peerId);
  return connection;
}

async function callPeer(peer) { const connection = makeConnection(peer.id, peer.name, peer.avatar, peer.invisible); await negotiate(peer.id, connection); }
socket.on("voice participants", (peers) => peers.forEach(callPeer));
socket.on("voice participant joined", (peer) => makeConnection(peer.id, peer.name, peer.avatar, peer.invisible));
socket.on("voice participant visibility",({id,invisible,name:peerName,avatar})=>{const person=participants.get(id);if(!person)return;person.invisible=!!invisible;if(id===socket.id){applyInvisibleMode(invisible);return}if(!invisible){person.name=peerName||person.name;person.avatar=avatar||"";addCard(id,person.name,person.avatar)}else document.querySelector(`[data-participant="${CSS.escape(id)}"]`)?.remove();updatePeople()});
socket.on("hidden admin presence",({present})=>{hiddenAdminIndicator.hidden=!present});
socket.on("voice participant left", removeParticipant);
socket.on("voice signal", async ({ from, name: peerName, avatar, signal }) => {
  const connection = makeConnection(from, peerName || "Hidden admin", avatar, participants.get(from)?.invisible || false);
  try {
    if (signal.media) {
      connection.remoteStreamKinds ||= {};
      connection.remoteMediaKinds ||= {};
      connection.remoteRetiredStreams ||= new Set();
      connection.remoteMediaKinds[signal.media.kind] = { enabled: signal.media.enabled, streamId: signal.media.streamId };
      if (signal.media.enabled) {
        if (signal.media.streamId) {
          connection.remoteStreamKinds[signal.media.streamId] = signal.media.kind;
          connection.remoteRetiredStreams.delete(signal.media.streamId);
        }
        const card = document.querySelector(`[data-participant="${CSS.escape(from)}"]`);
        const video = card?.querySelector(signal.media.streamId ? `.voice-video[data-video-stream="${CSS.escape(signal.media.streamId)}"]` : ".voice-video[data-video-kind='video']") || card?.querySelector(".voice-video[data-video-kind='video']");
        if (signal.media.kind === "camera") clearCameraVideos(from, video?.dataset.videoTrack || "");
        const badge = video && card?.querySelector(`.voice-video-label[data-video-track="${CSS.escape(video.dataset.videoTrack)}"]`);
        if (video) { video.dataset.videoKind = signal.media.kind; if (signal.media.streamId) video.dataset.videoStream = signal.media.streamId; }
        if (badge) { badge.dataset.videoKind = signal.media.kind; if (signal.media.streamId) badge.dataset.videoStream = signal.media.streamId; badge.textContent = signal.media.kind === "camera" ? "Camera" : "Screen"; }
      } else {
        if (signal.media.streamId) {
          delete connection.remoteStreamKinds[signal.media.streamId];
          connection.remoteRetiredStreams.add(signal.media.streamId);
        }
        if (signal.media.streamId) {
          const card = document.querySelector(`[data-participant="${CSS.escape(from)}"]`);
          card?.querySelectorAll(`[data-video-stream="${CSS.escape(signal.media.streamId)}"]`).forEach((element) => element.remove());
        }
        if (signal.media.kind === "camera") clearCameraVideos(from);
        else clearVideoKind(from, signal.media.kind);
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
  signalMediaState("camera", false, oldTrackId, oldStream.id);
  removeTracksFromConnections(oldStream);
  clearCameraVideos(socket.id);
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
    clearCameraVideos(socket.id);
    oldStream?.getTracks().forEach((track) => track.stop());
    nextStream.getVideoTracks().forEach((track) => { addVideo(socket.id, track, true, "Camera", nextStream.id); addTrackToConnections(track, nextStream); signalMediaState("camera", true, track.id, nextStream.id); });
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
  signalMediaState("screen", false, oldTrackId, oldStream.id);
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
    addVideo(socket.id, track, true, "Screen", screenStream.id);
    addTrackToConnections(track, screenStream);
    signalMediaState("screen", true, track.id, screenStream.id);
    shareScreenButton.textContent = "Stop sharing";
    shareScreenButton.classList.add("active-control");
    status.textContent = "You are sharing your screen.";
    renegotiateConnections();
  } catch (error) { status.textContent = "Screen sharing was cancelled or is unavailable."; }
}
shareScreenButton.addEventListener("click", () => screenStream ? stopScreenShare() : startScreenShare());

function leaveVoice() {
  if (kickedFromVoice) { window.location.assign("/"); return; }
  socket.emit("voice leave");
  [stream, cameraStream, screenStream].filter(Boolean).forEach((source) => source.getTracks().forEach((track) => track.stop()));
  connections.forEach((connection) => connection.close());
  window.close();
  setTimeout(() => window.location.assign("/"), 150);
}
leaveButton.addEventListener("click", leaveVoice);
window.addEventListener("pagehide", () => socket.emit("voice leave"));

socket.on("voice kicked", (result = {}) => {
  kickedFromVoice = true;
  [stream, cameraStream, screenStream].filter(Boolean).forEach((source) => source.getTracks().forEach((track) => track.stop()));
  stream = cameraStream = screenStream = undefined;
  resetVoiceCards();
  updatePeople();
  socket.disconnect();
  [muteButton, deafenButton, cameraButton, flipCameraButton, shareScreenButton].forEach((button) => { button.disabled = true; });
  leaveButton.textContent = "Back to chat";
  status.textContent = result.message || "An admin removed you from voice chat.";
});

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
    participants.set(socket.id, { id: socket.id, name, invisible:isInvisible });
    if(!isInvisible)addCard(socket.id, name, localStorage.getItem("open-chat-avatar") || "", true);
    monitorAudio(socket.id, stream);
    updatePeople();
    socket.emit("voice join", {}, (result) => { if(result?.ok)applyInvisibleMode(result.invisible);status.textContent = result?.ok ? (result.invisible?"You are connected in invisible mode; your microphone remains active.":"You are connected. Turn on camera or share a screen when ready.") : result?.error || "Could not join voice."; });
  } catch (error) { status.textContent = "Microphone access is needed to join voice chat. Allow it in your browser, then reload this page."; }
}
socket.on("connect", () => socket.emit("join", { mode: "create", deviceId }, (result) => {
  if (!result?.ok) return status.textContent = result?.error || "Could not verify your account.";
  name = result.displayName || result.account?.name || name;
  isAdmin = !!result.account?.admin;
  adminTools.hidden=!isAdmin;
  document.querySelector("#voice-identity").textContent = `Voice as ${name}`;
  participants.forEach((person, id) => {
    const card = document.querySelector(`[data-participant="${CSS.escape(id)}"]`);
    if (id !== socket.id && card) addKickButton(card, id, person.name);
  });
  socket.emit("get admin invisible",state=>{if(state?.ok){if(invisibleToggle)invisibleToggle.checked=state.invisible;applyInvisibleMode(state.invisible)}});socket.emit("voice config", (config) => {
    if (!config?.ok) { status.textContent = config?.error || "Could not load voice settings."; return; }
    rtcConfig = { iceServers: config.iceServers };
    joinVoice();
  });
}));
socket.on("connect_error", () => { status.textContent = "Could not connect to voice chat."; });
