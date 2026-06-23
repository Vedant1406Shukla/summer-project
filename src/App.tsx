import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Show, SignInButton, SignUpButton, UserButton, useUser } from '@clerk/react';

// ── Support languages ────────────────────────────────────────────────────────
const LANG_LABELS: Record<string, string> = {
  'en-US': 'English',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'ja-JP': 'Japanese',
  'de-DE': 'German',
  'hi-IN': 'Hindi',
};

const EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ── Waveform Helpers ─────────────────────────────────────────────────────────
function deterministicWaveData(seed: string, count = 28) {
  const bars = [];
  let h = 0.5;
  for (let i = 0; i < count; i++) {
    const c = seed.charCodeAt(i % seed.length);
    h = ((h * 17 + c * 0.04) % 0.75) + 0.25;
    bars.push(h);
  }
  return bars;
}

function drawProgressWaveform(canvas: HTMLCanvasElement, seed: string, progress: number, isSent: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const bars = deterministicWaveData(seed);
  const n = bars.length;
  const gap = 2;
  const barW = (W - gap * (n - 1)) / n;

  const playedColor = '#128c7e';
  const pendingColor = isSent ? 'rgba(18,140,126,0.25)' : 'rgba(102,117,129,0.3)';

  ctx.clearRect(0, 0, W, H);

  bars.forEach((h, i) => {
    const barH = h * H * 0.82;
    const x = i * (barW + gap);
    const y = (H - barH) / 2;
    const pct = i / n;
    ctx.fillStyle = pct <= progress ? playedColor : pendingColor;
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

// ── Audio Player Bubble Component ──────────────────────────────────────────
interface AudioPlayerBubbleProps {
  msg: { id: string; content: string; duration: number };
  isSent: boolean;
}

function AudioPlayerBubble({ msg, isSent }: AudioPlayerBubbleProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef  = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress]   = useState(0);
  const [remaining, setRemaining] = useState(msg.duration);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawProgressWaveform(canvas, msg.id, progress, isSent));
    ro.observe(canvas);
    drawProgressWaveform(canvas, msg.id, progress, isSent);
    return () => ro.disconnect();
  }, [msg.id, progress, isSent]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPause      = () => setIsPlaying(false);
    const onPlay       = () => setIsPlaying(true);
    const onTimeUpdate = () => {
      if (audio.duration) {
        setProgress(audio.currentTime / audio.duration);
        setRemaining(Math.ceil(audio.duration - audio.currentTime));
      }
    };
    const onEnded = () => { setIsPlaying(false); setProgress(0); setRemaining(msg.duration); };
    audio.addEventListener('pause', onPause);
    audio.addEventListener('play',  onPlay);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('play',  onPlay);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
    };
  }, [msg.duration]);

  const handlePlayToggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      document.querySelectorAll('audio').forEach(el => { if (el !== audio) (el as HTMLAudioElement).pause(); });
      audio.play();
    }
  };

  const fmt = (s: number) => { const v = Math.max(0, Math.floor(s)); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };

  return (
    <div className="message-audio-player">
      <span className="play-btn-wrap">
        <button className="btn-play-audio" onClick={handlePlayToggle} aria-label="Play Voice Message">
          <i className={`fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}`}></i>
        </button>
      </span>
      <canvas ref={canvasRef} className="audio-waveform-canvas" />
      <span className="audio-label-duration">{fmt(remaining)}</span>
      <audio ref={audioRef} src={msg.content} preload="metadata" />
    </div>
  );
}

// ── Message context menu ───────────────────────────────────────────────────
interface MsgMenuProps {
  msg: any;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}
function MessageContextMenu({ msg, onEdit, onDelete, onClose }: MsgMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const age = Date.now() - new Date(msg.timestamp).getTime();
  const withinWindow = age < EDIT_WINDOW_MS;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div className="msg-context-menu" ref={ref}>
      {msg.type === 'text' && withinWindow && (
        <button className="msg-menu-item" onClick={onEdit}>
          <i className="fa-solid fa-pen"></i> Edit
        </button>
      )}
      {withinWindow && (
        <button className="msg-menu-item danger" onClick={onDelete}>
          <i className="fa-solid fa-trash"></i> Delete
        </button>
      )}
      {!withinWindow && (
        <span className="msg-menu-expired">
          <i className="fa-solid fa-clock"></i> 5-min window expired
        </span>
      )}
    </div>
  );
}

// ── Main App Component ──────────────────────────────────────────────────────
export default function App() {
  const { user } = useUser();
  const socketRef      = useRef<Socket | null>(null);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);

  // ── Keep refs so audio onstop and reconnect callbacks always see live values
  // (fixes the stale-closure bug that broke sending after mic permission dialog)
  const currentRoomRef    = useRef<string | null>(null);
  // Store the base64-encoded password so we can auto-rejoin after a reconnect
  const roomPasswordRef   = useRef<string | null>(null);

  const [authMode, setAuthMode]           = useState<'login' | 'signup'>('login');
  const [comfortLanguage, setComfortLanguage] = useState('en-US');
  const [currentRoom, setCurrentRoom]     = useState<string | null>(null);
  const [joined, setJoined]               = useState(false);
  const [roomError, setRoomError]         = useState('');
  const [messages, setMessages]           = useState<any[]>([]);
  const [roomIdInput, setRoomIdInput]     = useState('');
  const [roomPasswordInput, setRoomPasswordInput] = useState('');
  const [textMessageInput, setTextMessageInput]   = useState('');

  // Audio recording
  const [isRecording, setIsRecording]     = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  const chunksRef        = useRef<Blob[]>([]);
  const recIntervalRef   = useRef<any>(null);
  const recStartRef      = useRef<number>(0);

  // Edit/Delete state
  const [activeMenu, setActiveMenu]           = useState<string | null>(null);
  const [editingId, setEditingId]             = useState<string | null>(null);
  const [editText, setEditText]               = useState('');

  // Mic permission — requested BEFORE joining a room so the browser dialog
  // never appears mid-session (which would drop the WebSocket connection)
  const [micPermission, setMicPermission] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle');

  // Keep currentRoomRef in sync with state
  useEffect(() => { currentRoomRef.current = currentRoom; }, [currentRoom]);


  // getUserDisplayName memoized (needed in callbacks)
  // Depend on stable primitives only — not the user object itself,
  // because Clerk returns a new object reference on every render.
  const getUserDisplayName = useCallback(() => {
    return user?.username || user?.firstName || user?.primaryEmailAddress?.emailAddress?.split('@')[0] || 'User';
  }, [user?.id, user?.username, user?.firstName, user?.primaryEmailAddress?.emailAddress]);

  // ── Setup WebSocket connection ─────────────────────────────────────────────
  //
  // CRITICAL: We depend on [user?.id], NOT [user].
  //
  // Clerk's useUser() returns a NEW object reference on EVERY render (any
  // state update, any keystroke). If we put [user] in the deps array, React
  // sees a changed dep on every render, tears down the old effect (which
  // disconnects the socket), and runs it again (reconnecting). That is exactly
  // what causes the rapid connect/disconnect spam visible in the server logs.
  //
  // user?.id is a stable primitive string that only changes when the user
  // actually signs in or out, so the socket is created exactly once per session.
  useEffect(() => {
    if (!user?.id) return;

    const socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 60000,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    // In socket.io-client v4, the 'reconnect' event is emitted on the
    // Manager (socket.io), NOT on the Socket itself.
    // socket.on('reconnect') silently does nothing — that's the bug.
    // The correct way is to use socket.on('connect') for EVERY connection
    // (initial + reconnects) and distinguish using a flag.
    let isFirstConnect = true;

    socket.on('connect', () => {
      if (isFirstConnect) {
        // First time connecting — nothing to rejoin
        isFirstConnect = false;
        console.log('Socket connected (initial):', socket.id);
        return;
      }

      // This is a RECONNECT. Re-join the room so the server-side
      // socket.io room subscription is restored and we receive broadcasts.
      console.log('Socket reconnected:', socket.id);
      const room = currentRoomRef.current;
      const pwd  = roomPasswordRef.current;
      if (room && pwd) {
        console.log(`Auto-rejoining room ${room} after reconnect…`);
        socket.emit('room:join', { roomId: room, password: pwd }, (res: any) => {
          if (res.success) {
            // Sync messages with the server list to capture edits and deletions
            setMessages(res.messages || []);
            console.log(`Auto-rejoin OK for room ${room}.`);
          } else {
            console.warn('Auto-rejoin failed:', res.error);
          }
        });
      }
    });

    socket.on('disconnect', (reason) => console.warn('Socket disconnected:', reason));
    socket.on('connect_error', (err)  => console.error('Socket connect error:', err));

    // New message
    socket.on('message:received', (msg: any) => {
      setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
    });

    // Message edited by anyone in room
    socket.on('message:updated', ({ id, content, edited }: any) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, content, edited } : m));
    });

    // Message deleted by anyone in room
    socket.on('message:deleted', ({ id }: any) => {
      setMessages(prev => prev.filter(m => m.id !== id));
    });

    return () => { socket.disconnect(); socketRef.current = null; };
  }, [user?.id]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (chatViewportRef.current) {
      chatViewportRef.current.scrollTop = chatViewportRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getUserInitials = () => {
    if (user?.firstName) return user.firstName.charAt(0).toUpperCase();
    if (user?.username)  return user.username.charAt(0).toUpperCase();
    return 'U';
  };

  // ── Mic permission ─────────────────────────────────────────────────────────
  // Requesting permission here (before joining) means the browser dialog
  // appears BEFORE the socket is in a room. We stop the stream immediately
  // after — we only need the browser to cache the permission grant.
  const requestMicPermission = async () => {
    setMicPermission('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop()); // release immediately
      setMicPermission('granted');
    } catch {
      setMicPermission('denied');
    }
  };

  // ── Room actions ───────────────────────────────────────────────────────────
  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    setRoomError('');
    if (micPermission !== 'granted') return setRoomError('Please grant microphone access first.');
    const rid = roomIdInput.trim().toUpperCase();
    const pwd = roomPasswordInput;
    if (!rid) return setRoomError('Please enter a Room ID.');
    if (rid.length < 3) return setRoomError('Room ID must be at least 3 characters.');
    if (!pwd) return setRoomError('Please set a room password.');
    if (pwd.length < 4) return setRoomError('Password must be at least 4 characters.');
    if (!socketRef.current) return setRoomError('Server connection not ready. Try again.');

    socketRef.current.emit('room:create', { roomId: rid, password: btoa(pwd) }, (res: any) => {
      if (res.success) joinRoomEmit(rid, pwd);
      else setRoomError(res.error || 'Failed to create room.');
    });
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    setRoomError('');
    if (micPermission !== 'granted') return setRoomError('Please grant microphone access first.');
    const rid = roomIdInput.trim().toUpperCase();
    const pwd = roomPasswordInput;
    if (!rid) return setRoomError('Please enter a Room ID.');
    if (!pwd) return setRoomError('Please enter the room password.');
    joinRoomEmit(rid, pwd);
  };

  const joinRoomEmit = (rid: string, pwd: string) => {
    if (!socketRef.current) return setRoomError('Server connection not ready.');
    const encodedPwd = btoa(pwd);
    socketRef.current.emit('room:join', { roomId: rid, password: encodedPwd }, (res: any) => {
      if (res.success) {
        // Store encoded password so reconnect handler can auto-rejoin
        roomPasswordRef.current = encodedPwd;
        setCurrentRoom(rid);
        setJoined(true);
        setMessages(res.messages || []);
      } else {
        setRoomError(res.error || 'Failed to join room.');
      }
    });
  };

  const handleLeaveRoom = () => {
    if (isRecording) stopRecording();
    if (socketRef.current && currentRoom) {
      socketRef.current.emit('room:leave', { roomId: currentRoom });
    }
    // Clear refs so reconnect handler doesn't auto-rejoin a room we left
    currentRoomRef.current  = null;
    roomPasswordRef.current = null;
    setCurrentRoom(null);
    setJoined(false);
    setRoomIdInput('');
    setRoomPasswordInput('');
    setMessages([]);
    setRoomError('');
  };

  // ── Send text ──────────────────────────────────────────────────────────────
  const handleSendText = () => {
    const text = textMessageInput.trim();
    if (!text || !currentRoom || !socketRef.current) return;
    const messageData = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      roomId: currentRoom,
      sender: getUserDisplayName(),
      senderLang: comfortLanguage,
      type: 'text',
      content: text,
    };
    socketRef.current.emit('message:send', messageData, (res: any) => {
      if (res.success) setTextMessageInput('');
      else console.error('Send error:', res.error);
    });
  };

  // ── Edit message ───────────────────────────────────────────────────────────
  const handleEditSubmit = (msg: any) => {
    const trimmed = editText.trim();
    if (!trimmed || !socketRef.current || !currentRoom) return;
    socketRef.current.emit('message:edit', {
      messageId: msg.id,
      roomId: currentRoom,
      sender: getUserDisplayName(),
      newContent: trimmed,
    }, (res: any) => {
      if (res.success) {
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, content: trimmed, edited: true } : m));
      } else {
        alert(res.error);
      }
      setEditingId(null);
      setEditText('');
    });
  };

  // ── Delete message ─────────────────────────────────────────────────────────
  const handleDelete = (msg: any) => {
    if (!socketRef.current || !currentRoom) return;
    if (!window.confirm('Delete this message for everyone?')) return;
    socketRef.current.emit('message:delete', {
      messageId: msg.id,
      roomId: currentRoom,
      sender: getUserDisplayName(),
    }, (res: any) => {
      if (res.success) {
        setMessages(prev => prev.filter(m => m.id !== msg.id));
      } else {
        alert(res.error);
      }
      setActiveMenu(null);
    });
  };

  // ── Audio Recording ────────────────────────────────────────────────────────
  // IMPORTANT: startRecording reads currentRoomRef.current (ref, not closure)
  // so the onstop callback always sees the live room even after mic permission
  // dialog briefly suspends the tab (which can cause socket reconnection and
  // state that looks stale inside a plain closure).

  const startRecording = async () => {
    if (!currentRoomRef.current) return;
    try {
      // Permission is already granted before room entry — getUserMedia here
      // will NOT show a browser dialog, so the WebSocket stays alive.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      setIsRecording(true);
      recStartRef.current = Date.now();
      setRecordingSeconds(0);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob     = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const duration = Math.round((Date.now() - recStartRef.current) / 1000);

        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          const liveSocket = socketRef.current;
          const liveRoom   = currentRoomRef.current;

          if (!liveSocket || !liveRoom) {
            console.warn('Audio ready but socket/room unavailable — dropping.');
            return;
          }

          const audioMessage = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            roomId: liveRoom,
            sender: getUserDisplayName(),
            senderLang: comfortLanguage,
            type: 'audio',
            content: reader.result as string,
            mimeType: blob.type,
            duration,
          };

          liveSocket.emit('message:send', audioMessage, (res: any) => {
            if (!res.success) console.error('Audio send error:', res.error);
          });
        };

        stream.getTracks().forEach(t => t.stop());
      };

      recorder.start();

      recIntervalRef.current = setInterval(() => {
        setRecordingSeconds(Math.floor((Date.now() - recStartRef.current) / 1000));
      }, 500);

    } catch (err) {
      console.error('Mic error:', err);
      alert('Microphone access denied or unavailable.');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    clearInterval(recIntervalRef.current);
    recIntervalRef.current = null;
    setIsRecording(false);
  };

  const handleAudioRecordToggle = async () => {
    if (isRecording) stopRecording();
    else await startRecording();
  };

  // ── Formatters ─────────────────────────────────────────────────────────────
  const formatTimer = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const formatMessageTime = (ts: any) => {
    const d = new Date(ts);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
  };

  let lastDateLabel = '';

  return (
    <div className="app-container">
      {/* ── Auth View ───────────────────────────────────────────────────────── */}
      <Show when="signed-out">
        <div id="view-auth" className="view-panel">
          <div className="auth-card-container">
            <div className="auth-brand">
              <i className="fa-solid fa-microphone-lines brand-icon"></i>
              <h1>iCom</h1>
              <p>Imperior Communications</p>
            </div>

            {authMode === 'login' ? (
              <div className="auth-card">
                <h2>Welcome Back</h2>
                <p className="auth-subtitle">Log in using Clerk to enter secure chat rooms</p>
                <SignInButton mode="modal">
                  <button className="btn btn-primary btn-full">
                    <span>Log In with Clerk</span> <i className="fa-solid fa-right-to-bracket"></i>
                  </button>
                </SignInButton>
                <div className="auth-toggle">
                  <span>New to iCom?</span>{' '}
                  <a href="#" onClick={(e) => { e.preventDefault(); setAuthMode('signup'); }}>
                    Create Account
                  </a>
                </div>
              </div>
            ) : (
              <div className="auth-card">
                <h2>Create Account</h2>
                <p className="auth-subtitle">Set up your profile to start communicating</p>
                <SignUpButton mode="modal">
                  <button className="btn btn-primary btn-full">
                    <span>Sign Up with Clerk</span> <i className="fa-solid fa-user-plus"></i>
                  </button>
                </SignUpButton>
                <div className="auth-toggle">
                  <span>Already have an account?</span>{' '}
                  <a href="#" onClick={(e) => { e.preventDefault(); setAuthMode('login'); }}>
                    Log In
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      </Show>

      {/* ── App Dashboard ───────────────────────────────────────────────────── */}
      <Show when="signed-in">
        {!joined ? (
          <div id="view-room" className="view-panel">
            <div className="room-card-container">
              <div className="user-greeting-card">
                <div className="user-greeting-avatar">{getUserInitials()}</div>
                <div className="user-greeting-text">
                  <h3>Hello, <span>{getUserDisplayName()}</span></h3>
                  <span className="user-lang-badge">
                    <i className="fa-solid fa-globe"></i> Comfort Language: <strong>{LANG_LABELS[comfortLanguage]}</strong>
                  </span>
                </div>
                <UserButton />
              </div>

              <div className="room-card">
                <h2>iCom Room Console</h2>
                <p className="room-subtitle">Enter an ID and Password to create or join a chat room</p>

                {/* ── Mic permission banner ──────────────────────────────── */}
                <div className={`mic-permission-banner ${micPermission}`}>
                  {micPermission === 'idle' && (
                    <>
                      <div className="mic-perm-icon"><i className="fa-solid fa-microphone"></i></div>
                      <div className="mic-perm-text">
                        <strong>Microphone access required</strong>
                        <span>iCom uses your mic for voice messages. Grant access before entering a room.</span>
                      </div>
                      <button className="btn-mic-grant" onClick={requestMicPermission}>
                        Grant Access
                      </button>
                    </>
                  )}
                  {micPermission === 'requesting' && (
                    <>
                      <div className="mic-perm-icon spin"><i className="fa-solid fa-circle-notch"></i></div>
                      <div className="mic-perm-text">
                        <strong>Waiting for permission…</strong>
                        <span>Please click "Allow" in your browser's permission dialog.</span>
                      </div>
                    </>
                  )}
                  {micPermission === 'granted' && (
                    <>
                      <div className="mic-perm-icon granted"><i className="fa-solid fa-circle-check"></i></div>
                      <div className="mic-perm-text">
                        <strong>Microphone access granted</strong>
                        <span>You're all set — voice messages are enabled.</span>
                      </div>
                    </>
                  )}
                  {micPermission === 'denied' && (
                    <>
                      <div className="mic-perm-icon denied"><i className="fa-solid fa-microphone-slash"></i></div>
                      <div className="mic-perm-text">
                        <strong>Microphone access denied</strong>
                        <span>Enable mic in your browser settings, then <a href="#" onClick={(e) => { e.preventDefault(); requestMicPermission(); }}>try again</a>.</span>
                      </div>
                    </>
                  )}
                </div>

                <form onSubmit={(e) => e.preventDefault()}>
                  <div className="form-group">
                    <label htmlFor="room-id"><i className="fa-solid fa-hashtag"></i> Room ID</label>
                    <input type="text" id="room-id" placeholder="e.g. ROOM-7F3K" autoComplete="off"
                      value={roomIdInput} onChange={(e) => setRoomIdInput(e.target.value)} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="room-password"><i className="fa-solid fa-key"></i> Room Password</label>
                    <input type="password" id="room-password" placeholder="Room password credentials"
                      value={roomPasswordInput} onChange={(e) => setRoomPasswordInput(e.target.value)} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="signup-lang"><i className="fa-solid fa-language"></i> Preferred Comfort Language</label>
                    <div className="select-wrapper">
                      <select id="signup-lang" value={comfortLanguage} onChange={(e) => setComfortLanguage(e.target.value)}>
                        <option value="en-US">English (US)</option>
                        <option value="es-ES">Spanish (Spain)</option>
                        <option value="fr-FR">French (France)</option>
                        <option value="ja-JP">Japanese (Japan)</option>
                        <option value="de-DE">German (Germany)</option>
                        <option value="hi-IN">Hindi (India)</option>
                      </select>
                    </div>
                  </div>

                  {roomError && <div className="alert-box error">{roomError}</div>}

                  <div className="room-action-buttons">
                    <button
                      className="btn btn-secondary flex-grow"
                      onClick={handleJoinRoom}
                      disabled={micPermission !== 'granted'}
                    >
                      <i className="fa-solid fa-right-to-bracket"></i> Join Room
                    </button>
                    <button
                      className="btn btn-primary flex-grow"
                      onClick={handleCreateRoom}
                      disabled={micPermission !== 'granted'}
                    >
                      <i className="fa-solid fa-plus"></i> Create Room
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        ) : (
          <div id="view-chat" className="view-panel">
            {/* Header */}
            <header className="chat-header">
              <div className="chat-header-left">
                <div className="room-avatar"><i className="fa-solid fa-comments"></i></div>
                <div className="room-info">
                  <span className="room-name">{currentRoom}</span>
                  <span className="room-status"><i className="fa-solid fa-circle"></i> Connected Socket Session</span>
                </div>
              </div>
              <div className="chat-header-center">
                <div className="brand-mini">
                  <i className="fa-solid fa-microphone-lines"></i>
                  <span>iCom</span>
                </div>
              </div>
              <div className="chat-header-right">
                <div className="current-user-tag">
                  <span className="tag-name">{getUserDisplayName()}</span>
                  <span className="tag-lang">{LANG_LABELS[comfortLanguage]}</span>
                </div>
                <button className="btn btn-danger btn-mini" onClick={handleLeaveRoom}>
                  <i className="fa-solid fa-arrow-right-from-bracket"></i> <span>Leave</span>
                </button>
              </div>
            </header>

            {/* Messages viewport */}
            <section className="chat-viewport" ref={chatViewportRef}>
              {messages.length === 0 ? (
                <div className="chat-empty-state">
                  <div className="empty-icon"><i className="fa-solid fa-microphone-lines"></i></div>
                  <h3>No messages yet</h3>
                  <p>Be the first to send a message or a voice note. Messages sync via WebSocket.</p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isSent   = msg.sender === getUserDisplayName();
                  const dateLabel = new Date(msg.timestamp).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                  const showDateSep = dateLabel !== lastDateLabel;
                  lastDateLabel = dateLabel;
                  const isMenuOpen  = activeMenu === msg.id;
                  const isEditMode  = editingId === msg.id;

                  return (
                    <React.Fragment key={msg.id}>
                      {showDateSep && (
                        <div className="date-separator"><span>{dateLabel}</span></div>
                      )}
                      <div className={`message-row ${isSent ? 'sent' : 'received'}`}>
                        {/* 3-dot menu trigger — only for sender's messages */}
                        {isSent && (
                          <div className="msg-actions-wrap">
                            <button
                              className="btn-msg-menu"
                              onClick={() => setActiveMenu(isMenuOpen ? null : msg.id)}
                              aria-label="Message options"
                            >
                              <i className="fa-solid fa-ellipsis-vertical"></i>
                            </button>
                            {isMenuOpen && (
                              <MessageContextMenu
                                msg={msg}
                                onClose={() => setActiveMenu(null)}
                                onEdit={() => {
                                  setEditingId(msg.id);
                                  setEditText(msg.content);
                                  setActiveMenu(null);
                                }}
                                onDelete={() => handleDelete(msg)}
                              />
                            )}
                          </div>
                        )}

                        <div className="message-bubble">
                          {!isSent && <div className="message-sender">{msg.sender}</div>}

                          {isEditMode ? (
                            <div className="edit-input-wrap">
                              <input
                                className="edit-input"
                                value={editText}
                                autoFocus
                                onChange={(e) => setEditText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleEditSubmit(msg);
                                  if (e.key === 'Escape') { setEditingId(null); setEditText(''); }
                                }}
                              />
                              <div className="edit-actions">
                                <button className="edit-btn save" onClick={() => handleEditSubmit(msg)}>Save</button>
                                <button className="edit-btn cancel" onClick={() => { setEditingId(null); setEditText(''); }}>Cancel</button>
                              </div>
                            </div>
                          ) : msg.type === 'text' ? (
                            <div className="message-text">
                              {msg.content}
                              {msg.edited && <span className="edited-badge"> (edited)</span>}
                            </div>
                          ) : (
                            <AudioPlayerBubble msg={msg} isSent={isSent} />
                          )}

                          <div className="message-footer">
                            <span>{formatMessageTime(msg.timestamp)}</span>
                            {isSent && <span className="blue-checkmarks"><i className="fa-solid fa-check-double"></i></span>}
                          </div>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })
              )}
            </section>

            {/* Recording banner */}
            {isRecording && (
              <div className="recording-status-banner">
                <div className="rec-banner-content">
                  <div className="rec-pulse-circle"></div>
                  <span>Recording Audio Message...</span>
                  <span className="rec-timer">{formatTimer(recordingSeconds)}</span>
                </div>
              </div>
            )}

            {/* Footer */}
            <footer className="chat-control-footer">
              <div className="audio-control-deck">
                <button
                  className={`btn-audio-record ${isRecording ? 'recording' : ''}`}
                  onClick={handleAudioRecordToggle}
                  aria-label="Record Voice"
                >
                  <i className={`fa-solid ${isRecording ? 'fa-stop' : 'fa-microphone'}`}></i>
                </button>
                <div className="audio-deck-text">
                  <span className="audio-deck-title">{isRecording ? 'Recording...' : 'Tap to Record'}</span>
                  <span className="audio-deck-desc">{isRecording ? 'Click to stop & send' : 'Click to speak a voice message'}</span>
                </div>
              </div>

              <div className="chat-message-deck">
                <input
                  type="text"
                  placeholder="Type a message here..."
                  autoComplete="off"
                  value={textMessageInput}
                  onChange={(e) => setTextMessageInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendText()}
                />
                <button className="btn-send-message" onClick={handleSendText} aria-label="Send Message">
                  <i className="fa-solid fa-paper-plane"></i>
                </button>
              </div>
            </footer>
          </div>
        )}
      </Show>
    </div>
  );
}
