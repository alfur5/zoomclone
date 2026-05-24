const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = {
//   adminId, adminName,
//   participants: { socketId -> { id, name, role, mic, cam, hand, reaction } },
//   waiting:      { socketId -> { id, name } }
// }
const rooms = {};

function makeId(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function roomParticipantList(room) {
  return Object.values(room.participants);
}

function roomWaitingList(room) {
  return Object.values(room.waiting);
}

io.on('connection', (socket) => {
  let myRoomId = null;
  let myInfo = null;

  /* ─── ADMIN: create room ─── */
  socket.on('create-room', ({ name }) => {
    const roomId = makeId();
    rooms[roomId] = {
      adminId: socket.id,
      adminName: name,
      participants: {},
      waiting: {}
    };
    myRoomId = roomId;
    myInfo = { id: socket.id, name, role: 'admin', mic: false, cam: false, hand: false, reaction: '' };
    rooms[roomId].participants[socket.id] = myInfo;
    socket.join(roomId);

    socket.emit('room-ready', {
      roomId,
      you: myInfo,
      participants: roomParticipantList(rooms[roomId])
    });
    socket.emit('chat-msg', sysMsg(`Room created. Share your Room ID with students: ${roomId}`));
  });

  /* ─── STUDENT: request join ─── */
  socket.on('request-join', ({ name, roomId }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error-msg', 'Room not found. Check the ID and try again.'); return; }

    myRoomId = roomId;
    myInfo = { id: socket.id, name, role: 'participant', mic: false, cam: false, hand: false, reaction: '' };
    room.waiting[socket.id] = myInfo;

    // notify student
    socket.emit('in-waiting-room', { roomId });

    // notify admin
    const adminSock = io.sockets.sockets.get(room.adminId);
    if (adminSock) {
      adminSock.emit('waiting-update', roomWaitingList(room));
    }
  });

  /* ─── ADMIN: admit student ─── */
  socket.on('admit', ({ targetId }) => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room || room.adminId !== socket.id) return;

    const info = room.waiting[targetId];
    if (!info) return;
    delete room.waiting[targetId];
    room.participants[targetId] = info;

    const targetSock = io.sockets.sockets.get(targetId);
    if (targetSock) {
      targetSock.join(myRoomId);
      targetSock.emit('admitted', {
        roomId: myRoomId,
        you: info,
        participants: roomParticipantList(room)
      });
      // tell new user about existing peers for WebRTC
      Object.keys(room.participants).forEach(pid => {
        if (pid !== targetId) {
          targetSock.emit('peer-joined', { peerId: pid, peerInfo: room.participants[pid] });
        }
      });
    }

    // tell room about the new person
    io.to(myRoomId).emit('participants-update', roomParticipantList(room));
    io.to(myRoomId).emit('chat-msg', sysMsg(`${info.name} joined the meeting.`));
    socket.emit('waiting-update', roomWaitingList(room));
  });

  /* ─── ADMIN: deny student ─── */
  socket.on('deny', ({ targetId }) => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room || room.adminId !== socket.id) return;
    const info = room.waiting[targetId];
    if (!info) return;
    delete room.waiting[targetId];
    const targetSock = io.sockets.sockets.get(targetId);
    if (targetSock) targetSock.emit('denied', 'Admin did not admit you to this meeting.');
    socket.emit('waiting-update', roomWaitingList(room));
  });

  /* ─── ADMIN: remove participant ─── */
  socket.on('remove-participant', ({ targetId }) => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room || room.adminId !== socket.id) return;
    const info = room.participants[targetId];
    if (!info) return;
    delete room.participants[targetId];
    const targetSock = io.sockets.sockets.get(targetId);
    if (targetSock) { targetSock.emit('you-were-removed'); targetSock.leave(myRoomId); }
    io.to(myRoomId).emit('participants-update', roomParticipantList(room));
    io.to(myRoomId).emit('peer-left', { peerId: targetId });
    io.to(myRoomId).emit('chat-msg', sysMsg(`${info.name} was removed by admin.`));
  });

  /* ─── ADMIN: force mute ─── */
  socket.on('force-mute', ({ targetId }) => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room || room.adminId !== socket.id) return;
    if (room.participants[targetId]) room.participants[targetId].mic = false;
    const targetSock = io.sockets.sockets.get(targetId);
    if (targetSock) targetSock.emit('force-muted');
    io.to(myRoomId).emit('participants-update', roomParticipantList(room));
  });

  /* ─── ADMIN: send reminder ─── */
  socket.on('send-reminder', ({ text, targetId }) => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room || room.adminId !== socket.id) return;
    const msg = reminderMsg(text);
    if (targetId === 'all') {
      io.to(myRoomId).emit('chat-msg', msg);
      io.to(myRoomId).emit('reminder-popup', { text });
    } else {
      const targetSock = io.sockets.sockets.get(targetId);
      if (targetSock) { targetSock.emit('chat-msg', msg); targetSock.emit('reminder-popup', { text }); }
      socket.emit('chat-msg', { ...msg, text: `📢 You sent a reminder to ${room.participants[targetId]?.name || 'participant'}: "${text}"` });
    }
  });

  /* ─── WebRTC signaling ─── */
  socket.on('rtc-offer',     ({ to, offer })     => { io.to(to).emit('rtc-offer',     { from: socket.id, fromInfo: myInfo, offer }); });
  socket.on('rtc-answer',    ({ to, answer })     => { io.to(to).emit('rtc-answer',    { from: socket.id, answer }); });
  socket.on('rtc-ice',       ({ to, candidate })  => { io.to(to).emit('rtc-ice',       { from: socket.id, candidate }); });

  /* ─── Chat ─── */
  socket.on('chat-msg', ({ text }) => {
    if (!myRoomId || !myInfo) return;
    io.to(myRoomId).emit('chat-msg', {
      from: myInfo.name, fromId: socket.id, text,
      isSystem: false, time: ts()
    });
  });

  /* ─── Media state ─── */
  socket.on('media-state', ({ mic, cam, hand, reaction }) => {
    if (!myRoomId || !myInfo) return;
    const room = rooms[myRoomId];
    if (!room || !room.participants[socket.id]) return;
    const p = room.participants[socket.id];
    if (mic !== undefined)      { p.mic = mic; myInfo.mic = mic; }
    if (cam !== undefined)      { p.cam = cam; myInfo.cam = cam; }
    if (hand !== undefined)     { p.hand = hand; myInfo.hand = hand; }
    if (reaction !== undefined) { p.reaction = reaction; myInfo.reaction = reaction; }
    io.to(myRoomId).emit('participants-update', roomParticipantList(room));
    if (reaction) {
      io.to(myRoomId).emit('reaction-burst', { name: myInfo.name, emoji: reaction });
      setTimeout(() => {
        if (room.participants[socket.id]) { room.participants[socket.id].reaction = ''; myInfo.reaction = ''; }
        io.to(myRoomId).emit('participants-update', roomParticipantList(room));
      }, 3500);
    }
  });

  /* ─── Disconnect ─── */
  socket.on('disconnect', () => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room) return;

    delete room.waiting[socket.id];
    const wasParticipant = !!room.participants[socket.id];
    const wasAdmin = room.adminId === socket.id;
    const name = myInfo?.name || 'Someone';

    if (wasParticipant) {
      delete room.participants[socket.id];
      io.to(myRoomId).emit('peer-left', { peerId: socket.id });
      io.to(myRoomId).emit('chat-msg', sysMsg(`${name} left the meeting.`));
    }

    if (wasAdmin) {
      io.to(myRoomId).emit('meeting-ended', 'Admin ended the meeting.');
      delete rooms[myRoomId];
    } else {
      if (room.participants && Object.keys(room.participants).length > 0) {
        io.to(myRoomId).emit('participants-update', roomParticipantList(room));
      }
    }
  });

  function ts() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function sysMsg(text) { return { from: 'System', text, isSystem: true, time: ts() }; }
  function reminderMsg(text) { return { from: '📢 Reminder', text, isSystem: true, isReminder: true, time: ts() }; }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ ZoomClone running → http://localhost:${PORT}\n`);
});
