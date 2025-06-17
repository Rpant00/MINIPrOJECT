const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
require('dotenv').config();
const app = express();
const server = http.createServer(app);
const io = new Server(server);


app.use(express.static('public'));
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const users = {};
const rooms = {
  lobby: { isPrivate: false, password: '' }
};

// Language opts
const LANGUAGE_NAMES = {
  'en': 'English',
  'hi': 'Hindi',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Chinese',
  'ar': 'Arabic',
  'ru': 'Russian'
};

// Translation for input text
app.post('/gemini-translate', async (req, res) => {
  const { text, targetLang } = req.body;

  if (!text || !targetLang) {
    return res.status(400).json({ error: 'Missing text or language' });
  }

  // Don't translate if already in same language
  if (targetLang === 'en') {
    return res.json({ translated: text });
  }

  try {
    const targetLanguageName = LANGUAGE_NAMES[targetLang] || targetLang;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Translate the following text to ${targetLanguageName}. Respond only with the translation, no explanations:

Text to translate: "${text}"`
          }]
        }]
      })
    });

    const data = await response.json();
    
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const translated = data.candidates[0].content.parts[0].text.trim();
      res.json({ translated });
    } else {
      console.error('Gemini translation error:', data);
      res.status(500).json({ error: 'Translation failed' });
    }

  } catch (err) {
    console.error('Gemini translation fetch error:', err);
    res.status(500).json({ error: 'Translation server error' });
  }
});

// ✅ Message translation
app.post('/translate-message', async (req, res) => {
  const { text, targetLang } = req.body;

  if (!text || !targetLang) {
    return res.status(400).json({ error: 'Missing text or language' });
  }

  if (targetLang === 'en') {
    return res.json({ translated: text });
  }

  try {
    const targetLanguageName = LANGUAGE_NAMES[targetLang] || targetLang;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Translate this message to ${targetLanguageName}. Keep the tone and meaning intact. Respond only with the translation:

"${text}"`
          }]
        }]
      })
    });

    const data = await response.json();
    
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const translated = data.candidates[0].content.parts[0].text.trim().replace(/"/g, '');
      res.json({ translated });
    } else {
      res.status(500).json({ error: 'Translation failed' });
    }

  } catch (err) {
    console.error('Message translation error:', err);
    res.status(500).json({ error: 'Translation server error' });
  }
});

// Gemini chatbot
app.post('/chatbot', async (req, res) => {
  const userPrompt = req.body.message || 'Say hello!';

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userPrompt }] }]
      })
    });

    const data = await response.json();

    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const reply = data.candidates[0].content.parts[0].text;
      res.json({ reply });
    } else if (data.error) {
      return res.status(500).json({ reply: `⚠️ Gemini API error: ${data.error.message}` });
    } else {
      return res.status(500).json({ reply: '⚠️ Gemini returned an unexpected response.' });
    }
  } catch (error) {
    console.error('Gemini fetch error:', error);
    return res.status(500).json({ reply: '⚠️ Internal server error while calling Gemini.' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  let username = 'Anonymous';

  socket.on('set username', (name) => {
    username = name || 'Anonymous';
    users[socket.id] = { username, room: 'lobby' };
    socket.join('lobby');
    io.emit('room list', Object.keys(rooms));
    io.to('lobby').emit('user list', getUsersInRoom('lobby'));
    console.log(`${username} joined room: lobby`);
  });

  socket.on('check room privacy', (roomName, callback) => {
    if (rooms[roomName]) {
      callback(!!rooms[roomName].isPrivate);
    } else {
      callback(false);
    }
  });

  socket.on('join room', ({ roomName, password }) => {
    const currentUser = users[socket.id];
    if (!currentUser) return;

    const oldRoom = currentUser.room;
    socket.leave(oldRoom);

    // Private Room Creation
    const isPrivate = password && password.trim() !== '';

    if (!rooms[roomName]) {
      rooms[roomName] = { isPrivate, password: password || '' };
      console.log(`Room created: ${roomName}, private: ${isPrivate}`);
    } else if (rooms[roomName].isPrivate && rooms[roomName].password !== password) {
      socket.emit('join error', 'Incorrect password for private room');
      socket.join(oldRoom);
      return;
    }

    users[socket.id].room = roomName;
    socket.join(roomName);
    io.emit('room list', Object.keys(rooms));
    io.to(roomName).emit('user list', getUsersInRoom(roomName));
    io.to(oldRoom).emit('user list', getUsersInRoom(oldRoom));
    console.log(`${username} joined room: ${roomName}`);
  });

  // ✅ Updated chat message
  socket.on('chat message', async (msg) => {
    const userData = users[socket.id];
    if (!userData) return;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
    // Show user's message to room
    io.to(userData.room).emit('chat message', {
      user: msg.user || userData.username,
      text: msg.text,
      time,
      originalLang: msg.lang || 'en' // Track original language
    });

    // Handle Gemini responses
    if (userData.room === 'gemini-room') {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: msg.text }] }]
          })
        });

        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "🤖 Gemini could not respond.";

        io.to('gemini-room').emit('chat message', {
          user: 'Gemini Bot 🤖',
          text: reply,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          originalLang: 'en'
        });
      } catch (err) {
        console.error('Gemini error:', err);
        io.to('gemini-room').emit('chat message', {
          user: 'Gemini Bot 🤖',
          text: '⚠️ Failed to contact Gemini API.',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          originalLang: 'en'
        });
      }
    }
  });

  socket.on('private message', ({ toUser, text }) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fromUser = users[socket.id]?.username;
    const targetSocketId = Object.entries(users).find(([id, u]) => u.username === toUser)?.[0];
    if (targetSocketId) {
      io.to(targetSocketId).emit('private message', {
        from: fromUser,
        text,
        time
      });
    }
  });

  socket.on('disconnect', () => {
    const userData = users[socket.id];
    if (!userData) return;
    const userRoom = userData.room;
    console.log(`${userData.username} disconnected`);
    delete users[socket.id];
    io.to(userRoom).emit('user list', getUsersInRoom(userRoom));
  });
});

function getUsersInRoom(room) {
  return Object.values(users)
    .filter(user => user.room === room)
    .map(user => user.username);
}

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});