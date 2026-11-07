const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Sirve el archivo index.html (tu juego) cuando alguien entra a la web
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Lógica básica de multijugador (relay de eventos)
io.on('connection', (socket) => {
  console.log('Nuevo piloto conectado:', socket.id);

  // El juego enviará eventos de creación de salas y movimiento
  // Debes replicar aquí la lógica de salas (rooms) de Socket.io que requiere el cliente
  socket.on('joinRoom', (roomCode) => {
    socket.join(roomCode);
    socket.to(roomCode).emit('playerJoined', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('Piloto desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
