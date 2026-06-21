// ─────────────────────────────────────────────────────────────────────────────
//  VoiceBridge Application Controller
//  Voice chat app with credential auth, room management, real-time tab sync,
//  and direct audio routing via MediaRecorder + localStorage.
//  No Web Speech API. No client-side translation. Audio passes through as-is.
// ─────────────────────────────────────────────────────────────────────────────

// ── Storage Keys ──────────────────────────────────────────────────────────────
const DB = {
  USERS    : 'vb_users',
  ROOMS    : 'vb_rooms',
  MESSAGES : 'vb_messages',
};

// ── Language map (for display only — actual processing happens on backend) ────
const LANG_LABELS = {
  'en-US': 'English',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'ja-JP': 'Japanese',
  'de-DE': 'German',
  'hi-IN': 'Hindi',
};

// ── Application State ─────────────────────────────────────────────────────────
const state = {
  currentView      : 'auth',   // 'auth' | 'room' | 'chat'
  loggedInUser     : null,     // { username, language }
  currentRoom      : null,     // roomId string
  mediaRecorder    : null,
  audioChunks      : [],
  isRecording      : false,
  recTimerInterval : null,
  recStartTime     : 0,
  audioPlayState   : {},       // { msgId: { paused, interval } }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Storage Helpers
// ─────────────────────────────────────────────────────────────────────────────
function dbGet(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch { return []; }
}
function dbSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function dbAppend(key, item) {
  const arr = dbGet(key);
  arr.push(item);
  dbSet(key, arr);
}

// ─────────────────────────────────────────────────────────────────────────────
//  View Management
// ─────────────────────────────────────────────────────────────────────────────
function showView(name) {
  ['auth', 'room', 'chat'].forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  state.currentView = name;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auth — Sign Up
// ─────────────────────────────────────────────────────────────────────────────
function handleSignup() {
  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  const language = document.getElementById('signup-lang').value;
  const errEl    = document.getElementById('signup-error');

  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!username) return showError(errEl, 'Please choose a username.');
  if (username.length < 3) return showError(errEl, 'Username must be at least 3 characters.');
  if (!password) return showError(errEl, 'Please choose a password.');
  if (password.length < 4) return showError(errEl, 'Password must be at least 4 characters.');

  const users = dbGet(DB.USERS);
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return showError(errEl, `Username "${username}" is already taken. Please choose another.`);
  }

  const newUser = { username, password: btoa(password), language };
  dbAppend(DB.USERS, newUser);

  // Auto-login after signup
  loginUser(newUser);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auth — Login
// ─────────────────────────────────────────────────────────────────────────────
function handleLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');

  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!username) return showError(errEl, 'Please enter your username.');
  if (!password) return showError(errEl, 'Please enter your password.');

  const users = dbGet(DB.USERS);
  const user  = users.find(
    u => u.username.toLowerCase() === username.toLowerCase() && u.password === btoa(password)
  );

  if (!user) return showError(errEl, 'Invalid username or password.');

  loginUser(user);
}

function loginUser(user) {
  state.loggedInUser = { username: user.username, language: user.language };
  sessionStorage.setItem('vb_session', JSON.stringify(state.loggedInUser));
  populateRoomView();
  showView('room');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Room View — Populate user info
// ─────────────────────────────────────────────────────────────────────────────
function populateRoomView() {
  const u = state.loggedInUser;
  if (!u) return;
  safeSetText('user-display-name', u.username);
  safeSetText('user-display-lang', LANG_LABELS[u.language] || u.language);
  safeSetText('user-avatar-initials', u.username.charAt(0).toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Room — Join
// ─────────────────────────────────────────────────────────────────────────────
function handleJoinRoom() {
  const roomId   = document.getElementById('room-id').value.trim().toUpperCase();
  const password = document.getElementById('room-password').value;
  const errEl    = document.getElementById('room-error');

  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!roomId)   return showError(errEl, 'Please enter a Room ID.');
  if (!password) return showError(errEl, 'Please enter the room password.');

  const rooms = dbGet(DB.ROOMS);
  const room  = rooms.find(r => r.roomId === roomId);

  if (!room) return showError(errEl, `Room "${roomId}" does not exist. Create it first.`);
  if (room.password !== btoa(password)) {
    return showError(errEl, 'Incorrect room password. Please try again.');
  }

  enterRoom(roomId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Room — Create
// ─────────────────────────────────────────────────────────────────────────────
function handleCreateRoom() {
  const roomId   = document.getElementById('room-id').value.trim().toUpperCase();
  const password = document.getElementById('room-password').value;
  const errEl    = document.getElementById('room-error');

  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!roomId)   return showError(errEl, 'Please enter a Room ID.');
  if (roomId.length < 3) return showError(errEl, 'Room ID must be at least 3 characters.');
  if (!password) return showError(errEl, 'Please set a room password.');
  if (password.length < 4) return showError(errEl, 'Room password must be at least 4 characters.');

  const rooms = dbGet(DB.ROOMS);
  if (rooms.find(r => r.roomId === roomId)) {
    return showError(errEl, `Room "${roomId}" already exists. Use "Join Room" instead.`);
  }

  dbAppend(DB.ROOMS, { roomId, password: btoa(password) });
  enterRoom(roomId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Enter Chat Room
// ─────────────────────────────────────────────────────────────────────────────
function enterRoom(roomId) {
  state.currentRoom = roomId;

  // Populate chat header
  safeSetText('chat-display-room-id', roomId);
  safeSetText('chat-display-username', state.loggedInUser.username);
  safeSetText('chat-display-lang', LANG_LABELS[state.loggedInUser.language] || state.loggedInUser.language);

  showView('chat');

  // Reset date separator tracker for clean rendering
  _lastDateLabel = null;

  // Render all existing messages for this room
  const viewport = document.getElementById('chat-viewport');
  viewport.innerHTML = '';
  const allMessages = dbGet(DB.MESSAGES).filter(m => m.roomId === roomId);

  if (allMessages.length === 0) {
    renderEmptyState(viewport);
  } else {
    allMessages.forEach(msg => renderMessage(msg));
    viewport.scrollTop = viewport.scrollHeight;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Leave Room
// ─────────────────────────────────────────────────────────────────────────────
function handleLeaveRoom() {
  stopRecordingIfActive();
  state.currentRoom = null;
  document.getElementById('room-id').value = '';
  document.getElementById('room-password').value = '';
  document.getElementById('room-error').classList.add('hidden');
  showView('room');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Send Text Message
// ─────────────────────────────────────────────────────────────────────────────
function handleSendText() {
  const input = document.getElementById('chat-message-input');
  const text  = input.value.trim();
  if (!text || !state.currentRoom) return;

  const msg = {
    id        : generateId(),
    roomId    : state.currentRoom,
    sender    : state.loggedInUser.username,
    senderLang: state.loggedInUser.language,
    type      : 'text',
    content   : text,
    timestamp : Date.now(),
  };

  // Clear empty state if present
  clearEmptyState();

  dbAppend(DB.MESSAGES, msg);
  renderMessage(msg);
  input.value = '';

  const viewport = document.getElementById('chat-viewport');
  viewport.scrollTop = viewport.scrollHeight;

  // Dispatch a custom storage event so OTHER tabs in the same origin
  // receive the update (same-tab storage events are not fired by default)
  notifyOtherTabs();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Voice Message — MediaRecorder capture
// ─────────────────────────────────────────────────────────────────────────────
async function handleAudioRecordToggle() {
  if (state.isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (!state.currentRoom) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaRecorder = new MediaRecorder(stream);
    state.audioChunks   = [];
    state.isRecording   = true;
    state.recStartTime  = Date.now();

    state.mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.mediaRecorder.onstop = async () => {
      const blob       = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType || 'audio/webm' });
      const base64     = await blobToBase64(blob);
      const duration   = Math.round((Date.now() - state.recStartTime) / 1000);
      const mimeType   = blob.type;

      const msg = {
        id        : generateId(),
        roomId    : state.currentRoom,
        sender    : state.loggedInUser.username,
        senderLang: state.loggedInUser.language,
        type      : 'audio',
        content   : base64,
        mimeType,
        duration,
        timestamp : Date.now(),
      };

      // Stop all mic tracks
      stream.getTracks().forEach(t => t.stop());

      // Clear empty state if present
      clearEmptyState();

      dbAppend(DB.MESSAGES, msg);
      renderMessage(msg);

      const viewport = document.getElementById('chat-viewport');
      viewport.scrollTop = viewport.scrollHeight;

      notifyOtherTabs();
    };

    state.mediaRecorder.start();

    // Update UI
    updateRecordingUI(true);
    startRecTimer();

  } catch (err) {
    console.error('Microphone error:', err);
    alert('Microphone access denied or not available.\n\nPlease allow microphone access in your browser settings.');
    state.isRecording = false;
  }
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') return;
  state.mediaRecorder.stop();
  state.isRecording = false;
  stopRecTimer();
  updateRecordingUI(false);
}

function stopRecordingIfActive() {
  if (state.isRecording) stopRecording();
}

function updateRecordingUI(isRecording) {
  const btn     = document.getElementById('btn-record-audio');
  const banner  = document.getElementById('rec-status-banner');
  const title   = document.getElementById('audio-deck-title');
  const desc    = document.getElementById('audio-deck-desc');

  if (isRecording) {
    btn.classList.add('recording');
    btn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    banner.classList.remove('hidden');
    title.textContent = 'Recording...';
    desc.textContent  = 'Click to stop & send';
  } else {
    btn.classList.remove('recording');
    btn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
    banner.classList.add('hidden');
    title.textContent = 'Tap to Record';
    desc.textContent  = 'Click to speak a voice message';
    document.getElementById('rec-timer').textContent = '0:00';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Recording Timer
// ─────────────────────────────────────────────────────────────────────────────
function startRecTimer() {
  state.recTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.recStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = String(elapsed % 60).padStart(2, '0');
    const timerEl = document.getElementById('rec-timer');
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 500);
}

function stopRecTimer() {
  clearInterval(state.recTimerInterval);
  state.recTimerInterval = null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Render a Message Bubble
// ─────────────────────────────────────────────────────────────────────────────
function renderEmptyState(viewport) {
  const el = document.createElement('div');
  el.className = 'chat-empty-state';
  el.id = 'chat-empty-state';
  el.innerHTML = `
    <div class="empty-icon"><i class="fa-solid fa-microphone-lines"></i></div>
    <h3>No messages yet</h3>
    <p>Be the first to send a message or a voice note in this room. Messages are synced across all open tabs.</p>
  `;
  viewport.appendChild(el);
}

function clearEmptyState() {
  const el = document.getElementById('chat-empty-state');
  if (el) el.remove();
}

let _lastDateLabel = null;

function renderMessage(msg) {
  const viewport  = document.getElementById('chat-viewport');
  if (!viewport) return;

  const isSent    = msg.sender === state.loggedInUser?.username;
  const timeStr   = formatTime(msg.timestamp);

  // Date separator — only show if date changed
  const dateLabel = new Date(msg.timestamp).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (dateLabel !== _lastDateLabel) {
    _lastDateLabel = dateLabel;
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.innerHTML = `<span>${dateLabel}</span>`;
    viewport.appendChild(sep);
  }

  const row = document.createElement('div');
  row.className    = `message-row ${isSent ? 'sent' : 'received'}`;
  row.dataset.msgId = msg.id;
  row.style.animation = 'slideInBubble 0.25s ease-out forwards';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  // Sender name (only on received)
  if (!isSent) {
    const senderEl = document.createElement('div');
    senderEl.className   = 'message-sender';
    senderEl.textContent = msg.sender;
    bubble.appendChild(senderEl);
  }

  // Content
  if (msg.type === 'text') {
    const textEl = document.createElement('div');
    textEl.className   = 'message-text';
    textEl.textContent = msg.content;
    bubble.appendChild(textEl);
  } else if (msg.type === 'audio') {
    const playerBlock = buildAudioPlayer(msg, isSent);
    bubble.appendChild(playerBlock);
  }

  // Footer: time + checkmarks
  const footer = document.createElement('div');
  footer.className = 'message-footer';
  footer.innerHTML = `
    <span>${timeStr}</span>
    ${isSent ? '<span class="blue-checkmarks"><i class="fa-solid fa-check-double"></i></span>' : ''}
  `;
  bubble.appendChild(footer);

  row.appendChild(bubble);
  viewport.appendChild(row);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Audio Player Builder (inside bubble)
// ─────────────────────────────────────────────────────────────────────────────
function buildAudioPlayer(msg, isSent) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-audio-player';

  // Play button
  const btn = document.createElement('button');
  btn.className = 'btn-play-audio';
  btn.setAttribute('aria-label', 'Play Voice Message');
  btn.innerHTML = '<i class="fa-solid fa-play"></i>';

  // Canvas waveform
  const canvas = document.createElement('canvas');
  canvas.className = 'audio-waveform-canvas';
  canvas.id = `wave-${msg.id}`;

  // Duration badge
  const dur = document.createElement('span');
  dur.className   = 'audio-label-duration';
  dur.textContent = formatDuration(msg.duration || 0);
  dur.id = `dur-${msg.id}`;

  wrapper.appendChild(btn);
  wrapper.appendChild(canvas);
  wrapper.appendChild(dur);

  // Wire up playback
  const audioEl = new Audio(msg.content);
  let   progressInterval = null;

  btn.addEventListener('click', () => {
    if (!audioEl.paused) {
      // Pause
      audioEl.pause();
      btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      clearInterval(progressInterval);
      drawStaticWaveform(canvas, msg.id, isSent);
    } else {
      // Stop any other playing
      stopAllAudioPlayback();

      // Play
      audioEl.currentTime = 0;
      audioEl.play();
      btn.innerHTML = '<i class="fa-solid fa-pause"></i>';

      progressInterval = setInterval(() => {
        if (!audioEl.paused && audioEl.duration) {
          const progress = audioEl.currentTime / audioEl.duration;
          drawProgressWaveform(canvas, msg.id, progress, isSent);

          // Update duration display
          const remaining = Math.ceil(audioEl.duration - audioEl.currentTime);
          const durEl = document.getElementById(`dur-${msg.id}`);
          if (durEl) durEl.textContent = formatDuration(remaining);
        }
      }, 60);

      audioEl.onended = () => {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        clearInterval(progressInterval);
        drawStaticWaveform(canvas, msg.id, isSent);
        const durEl = document.getElementById(`dur-${msg.id}`);
        if (durEl) durEl.textContent = formatDuration(msg.duration || 0);
      };

      // Store reference to stop later
      state.audioPlayState[msg.id] = { audio: audioEl, interval: progressInterval, btn };
    }
  });

  // Draw static waveform after layout (so canvas has dimensions)
  requestAnimationFrame(() => drawStaticWaveform(canvas, msg.id, isSent));

  return wrapper;
}

function stopAllAudioPlayback() {
  Object.values(state.audioPlayState).forEach(({ audio, interval, btn }) => {
    if (audio && !audio.paused) audio.pause();
    clearInterval(interval);
    if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
  });
  state.audioPlayState = {};
}

// ─────────────────────────────────────────────────────────────────────────────
//  Waveform Canvas Drawing
// ─────────────────────────────────────────────────────────────────────────────
function deterministicWaveData(seed, count = 28) {
  const bars = [];
  let h = 0.5;
  for (let i = 0; i < count; i++) {
    const c = seed.charCodeAt(i % seed.length);
    h = ((h * 17 + c * 0.04) % 0.75) + 0.25;
    bars.push(h);
  }
  return bars;
}

function drawStaticWaveform(canvas, seed, isSent) {
  drawProgressWaveform(canvas, seed, 0, isSent);
}

function drawProgressWaveform(canvas, seed, progress, isSent) {
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;

  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const W      = rect.width;
  const H      = rect.height;
  const bars   = deterministicWaveData(seed);
  const n      = bars.length;
  const gap    = 2;
  const barW   = (W - gap * (n - 1)) / n;

  const playedColor  = isSent ? '#128c7e' : '#128c7e';
  const pendingColor = isSent ? 'rgba(18,140,126,0.25)' : 'rgba(102,117,129,0.3)';

  ctx.clearRect(0, 0, W, H);

  bars.forEach((h, i) => {
    const barH = h * H * 0.82;
    const x    = i * (barW + gap);
    const y    = (H - barH) / 2;
    const pct  = i / n;

    ctx.fillStyle = pct <= progress ? playedColor : pendingColor;

    // Rounded bars
    const r = barW / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + barH - r);
    ctx.quadraticCurveTo(x + barW, y + barH, x + barW - r, y + barH);
    ctx.lineTo(x + r, y + barH);
    ctx.quadraticCurveTo(x, y + barH, x, y + barH - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Real-time Sync: Cross-Tab localStorage listener
// ─────────────────────────────────────────────────────────────────────────────
function notifyOtherTabs() {
  // Write a tiny "ping" key. Other tabs will see this via the 'storage' event.
  const ping = { ts: Date.now(), by: state.loggedInUser?.username };
  localStorage.setItem('vb_ping', JSON.stringify(ping));
}

window.addEventListener('storage', e => {
  // Only react to ping — then pull latest messages for the current room
  if (e.key !== 'vb_ping' && e.key !== DB.MESSAGES) return;
  if (state.currentView !== 'chat' || !state.currentRoom) return;

  const viewport    = document.getElementById('chat-viewport');
  if (!viewport) return;

  const rendered    = new Set([...viewport.querySelectorAll('[data-msg-id]')].map(el => el.dataset.msgId));
  const allMessages = dbGet(DB.MESSAGES).filter(m => m.roomId === state.currentRoom);
  let hasNew = false;

  allMessages.forEach(msg => {
    if (!rendered.has(msg.id)) {
      renderMessage(msg);
      hasNew = true;
    }
  });

  if (hasNew) viewport.scrollTop = viewport.scrollHeight;
});

// ─────────────────────────────────────────────────────────────────────────────
//  Logout
// ─────────────────────────────────────────────────────────────────────────────
function handleLogout() {
  stopRecordingIfActive();
  state.loggedInUser = null;
  state.currentRoom  = null;
  sessionStorage.removeItem('vb_session');
  showView('auth');
  showAuthCard('login');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auth Card Toggler
// ─────────────────────────────────────────────────────────────────────────────
function showAuthCard(which) {
  const loginCard  = document.getElementById('card-login');
  const signupCard = document.getElementById('card-signup');
  if (!loginCard || !signupCard) return;

  if (which === 'login') {
    loginCard.classList.remove('hidden');
    signupCard.classList.add('hidden');
  } else {
    signupCard.classList.remove('hidden');
    loginCard.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utility functions
// ─────────────────────────────────────────────────────────────────────────────
function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function safeSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function formatTime(ts) {
  const d   = new Date(ts);
  let h     = d.getHours();
  const m   = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror   = reject;
    reader.readAsDataURL(blob);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Session Restore (on page reload)
// ─────────────────────────────────────────────────────────────────────────────
function restoreSession() {
  try {
    const raw = sessionStorage.getItem('vb_session');
    if (!raw) return false;
    const session = JSON.parse(raw);
    if (!session?.username) return false;
    state.loggedInUser = session;
    populateRoomView();
    showView('room');
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Boot: Attach Events + Restore Session
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {

  // Auth view events
  document.getElementById('btn-signup-submit')?.addEventListener('click', handleSignup);
  document.getElementById('btn-login-submit')?.addEventListener('click',  handleLogin);
  document.getElementById('link-show-signup')?.addEventListener('click',  e => { e.preventDefault(); showAuthCard('signup'); });
  document.getElementById('link-show-login')?.addEventListener('click',   e => { e.preventDefault(); showAuthCard('login'); });

  // Enter key support for auth forms
  ['login-username', 'login-password'].forEach(id => {
    document.getElementById(id)?.addEventListener('keypress', e => {
      if (e.key === 'Enter') handleLogin();
    });
  });
  ['signup-username', 'signup-password'].forEach(id => {
    document.getElementById(id)?.addEventListener('keypress', e => {
      if (e.key === 'Enter') handleSignup();
    });
  });

  // Room view events
  document.getElementById('btn-join-room')?.addEventListener('click',   handleJoinRoom);
  document.getElementById('btn-create-room')?.addEventListener('click', handleCreateRoom);
  document.getElementById('btn-logout')?.addEventListener('click',      handleLogout);

  ['room-id', 'room-password'].forEach(id => {
    document.getElementById(id)?.addEventListener('keypress', e => {
      if (e.key === 'Enter') handleJoinRoom();
    });
  });

  // Chat view events
  document.getElementById('btn-leave-room')?.addEventListener('click',   handleLeaveRoom);
  document.getElementById('btn-send-message')?.addEventListener('click', handleSendText);
  document.getElementById('btn-record-audio')?.addEventListener('click', handleAudioRecordToggle);

  document.getElementById('chat-message-input')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') handleSendText();
  });

  // Restore session or start at auth
  if (!restoreSession()) {
    showView('auth');
    showAuthCard('login');
  }
});
