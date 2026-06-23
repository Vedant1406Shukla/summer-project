require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── MongoDB ──────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/icom';
const PORT = process.env.PORT || 3001;

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });

// ── Schemas ──────────────────────────────────────────────────────────────────
const RoomSchema = new mongoose.Schema({
  roomId:   { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
}, { timestamps: true });

const MessageSchema = new mongoose.Schema({
  id:         { type: String, required: true, unique: true },
  roomId:     { type: String, required: true, index: true },
  sender:     { type: String, required: true },
  senderLang: { type: String, required: true },
  type:       { type: String, enum: ['text', 'audio'], required: true },
  content:    { type: String, required: true },
  mimeType:   { type: String },
  duration:   { type: Number },
  timestamp:  { type: Date, default: Date.now },
  edited:     { type: Boolean, default: false },
  deleted:    { type: Boolean, default: false },
});

const Room    = mongoose.model('Room', RoomSchema);
const Message = mongoose.model('Message', MessageSchema);

// ── Edit/Delete window ────────────────────────────────────────────────────────
const EDIT_WINDOW_MS = 5 * 60 * 1000;

// ── Grace-period cleanup timers ───────────────────────────────────────────────
//
// WHY: When the browser shows the microphone permission dialog it briefly
// freezes the JS event loop, which drops the WebSocket (transport close).
// The disconnect fires on the server. Without a grace period we'd wipe the
// room immediately, even though the client reconnects a second later.
//
// HOW: When the last user disconnects we start a 20-second timer instead of
// deleting right away.  If anyone rejoins the room before the timer fires we
// cancel it.  Only explicit "Leave Room" (room:leave event) triggers an
// immediate delete — because the user actually chose to leave.
//
const cleanupTimers = new Map(); // roomId -> NodeJS.Timeout

/** Cancel any pending grace-period timer for a room (called on join). */
function cancelCleanupTimer(roomId) {
  const t = cleanupTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    cleanupTimers.delete(roomId);
    console.log(`Cleanup timer cancelled for room ${roomId} (user rejoined).`);
  }
}

/** Schedule cleanup for roomId after GRACE_MS if it is still empty then. */
const GRACE_MS = 60_000; // 60 seconds — plenty of time for any reconnect scenario

function scheduleCleanup(roomId) {
  // Don't stack timers
  cancelCleanupTimer(roomId);

  const t = setTimeout(async () => {
    cleanupTimers.delete(roomId);
    const remaining = getRoomSize(roomId);
    if (remaining === 0) {
      console.log(`Grace period expired — room ${roomId} still empty. Purging.`);
      try {
        await Message.deleteMany({ roomId });
        await Room.deleteOne({ roomId });
        console.log(`Cleanup done for room ${roomId}.`);
      } catch (err) {
        console.error(`Cleanup error for room ${roomId}:`, err);
      }
    } else {
      console.log(`Grace period expired — room ${roomId} has ${remaining} member(s). Keeping data.`);
    }
  }, GRACE_MS);

  cleanupTimers.set(roomId, t);
  console.log(`Cleanup scheduled for room ${roomId} in ${GRACE_MS / 1000}s.`);
}

/** Immediate cleanup — used only for explicit room:leave. */
async function immediateCleanup(roomId) {
  cancelCleanupTimer(roomId); // cancel any pending grace-period timer
  const remaining = getRoomSize(roomId);
  console.log(`Explicit leave: room ${roomId} has ${remaining} remaining member(s).`);
  if (remaining === 0) {
    console.log(`Room ${roomId} empty — purging immediately.`);
    try {
      await Message.deleteMany({ roomId });
      await Room.deleteOne({ roomId });
      console.log(`Immediate cleanup done for room ${roomId}.`);
    } catch (err) {
      console.error(`Cleanup error for room ${roomId}:`, err);
    }
  }
}

function getRoomSize(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  return room ? room.size : 0;
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  let currentRoomId = null;

  // 1. Join room
  socket.on('room:join', async ({ roomId, password }, callback) => {
    try {
      const upper = roomId.toUpperCase();
      const room = await Room.findOne({ roomId: upper });
      if (!room) return callback({ success: false, error: `Room "${roomId}" does not exist.` });
      if (room.password !== password) return callback({ success: false, error: 'Incorrect room password.' });

      // Cancel any grace-period cleanup — someone is rejoining
      cancelCleanupTimer(upper);

      socket.join(upper);
      currentRoomId = upper;
      console.log(`${socket.id} joined ${upper}. Total: ${getRoomSize(upper)}`);

      const messages = await Message.find({ roomId: upper }).sort({ timestamp: 1 });
      callback({ success: true, messages });
    } catch (err) {
      console.error('room:join error:', err);
      callback({ success: false, error: 'Internal server error.' });
    }
  });

  // 2. Create room
  socket.on('room:create', async ({ roomId, password }, callback) => {
    try {
      const upper = roomId.toUpperCase();
      if (await Room.findOne({ roomId: upper })) {
        return callback({ success: false, error: `Room "${roomId}" already exists. Join it instead.` });
      }
      await new Room({ roomId: upper, password }).save();
      cancelCleanupTimer(upper); // should be no-op for a new room but be safe
      socket.join(upper);
      currentRoomId = upper;
      console.log(`${socket.id} created & joined ${upper}.`);
      callback({ success: true });
    } catch (err) {
      console.error('room:create error:', err);
      callback({ success: false, error: 'Internal server error.' });
    }
  });

  // 3. Send message
  socket.on('message:send', async (msgData, callback) => {
    try {
      const { id, roomId, sender, senderLang, type, content, mimeType, duration } = msgData;
      if (!roomId || !sender || !type || !content) {
        return callback({ success: false, error: 'Missing required fields.' });
      }
      const msg = await new Message({
        id, roomId, sender, senderLang, type, content, mimeType, duration, timestamp: new Date(),
      }).save();
      io.to(roomId).emit('message:received', msg);
      callback({ success: true });
    } catch (err) {
      console.error('message:send error:', err);
      callback({ success: false, error: 'Internal server error.' });
    }
  });

  // 4. Edit message (text only, within 5-min window)
  socket.on('message:edit', async ({ messageId, roomId, sender, newContent }, callback) => {
    try {
      const msg = await Message.findOne({ id: messageId });
      if (!msg) return callback({ success: false, error: 'Message not found.' });
      if (msg.sender !== sender) return callback({ success: false, error: 'You can only edit your own messages.' });
      if (msg.type !== 'text') return callback({ success: false, error: 'Audio messages cannot be edited.' });
      if (Date.now() - new Date(msg.timestamp).getTime() > EDIT_WINDOW_MS) {
        return callback({ success: false, error: 'Edit window (5 min) has expired.' });
      }
      msg.content = newContent.trim();
      msg.edited  = true;
      await msg.save();
      io.to(roomId).emit('message:updated', { id: messageId, content: msg.content, edited: true });
      callback({ success: true });
    } catch (err) {
      console.error('message:edit error:', err);
      callback({ success: false, error: 'Internal server error.' });
    }
  });

  // 5. Delete message (own messages only, within 5-min window)
  socket.on('message:delete', async ({ messageId, roomId, sender }, callback) => {
    try {
      const msg = await Message.findOne({ id: messageId });
      if (!msg) return callback({ success: false, error: 'Message not found.' });
      if (msg.sender !== sender) return callback({ success: false, error: 'You can only delete your own messages.' });
      if (Date.now() - new Date(msg.timestamp).getTime() > EDIT_WINDOW_MS) {
        return callback({ success: false, error: 'Delete window (5 min) has expired.' });
      }
      await Message.deleteOne({ id: messageId });
      io.to(roomId).emit('message:deleted', { id: messageId });
      callback({ success: true });
    } catch (err) {
      console.error('message:delete error:', err);
      callback({ success: false, error: 'Internal server error.' });
    }
  });

  // 6. Explicit Leave Room — user pressed the Leave button
  //    Immediate cleanup (no grace period) because the user intentionally left.
  socket.on('room:leave', async ({ roomId }) => {
    socket.leave(roomId);
    if (currentRoomId === roomId) currentRoomId = null;
    await immediateCleanup(roomId);
  });

  // 7. Disconnect — could be a temporary network drop / mic-permission freeze.
  //    Use a grace period so that a quick reconnect doesn't wipe the room.
  socket.on('disconnect', async (reason) => {
    console.log(`Socket ${socket.id} disconnected (${reason})`);
    if (currentRoomId) {
      // socket.leave is implicit on disconnect, but getRoomSize already won't
      // count this socket, so no need to call socket.leave manually here.
      const roomId = currentRoomId;
      currentRoomId = null;
      const remaining = getRoomSize(roomId);
      console.log(`After disconnect, room ${roomId} has ${remaining} member(s).`);
      if (remaining === 0) {
        scheduleCleanup(roomId); // wait 20s before wiping
      }
    }
  });
});

server.listen(PORT, () => console.log(`iCom Backend running on port ${PORT}`));
