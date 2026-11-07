const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // En producción, cambia esto por tu dominio real
        methods: ["GET", "POST"]
    }
});

// Servir archivos estáticos (tu HTML, CSS, JS del cliente)
app.use(express.static('public'));

// Almacén en memoria de las salas activas
const rooms = {};

// Función para generar un código alfanumérico de 5 letras para el lobby
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

io.on('connection', (socket) => {
    console.log(`🟢 Jugador conectado: ${socket.id}`);

    // CREAR UNA SALA (mplobby)
    socket.on('createRoom', (data, callback) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            players: [{ id: socket.id, name: data.playerName, isHost: true }],
            status: 'waiting', // waiting, playing
            map: null
        };
        
        socket.join(roomCode);
        console.log(`Sala creada: ${roomCode} por ${data.playerName}`);
        
        // Devolvemos el código al cliente para que lo muestre en la UI
        callback({ success: true, roomCode: roomCode });
    });

    // UNIRSE A UNA SALA MEDIANTE CÓDIGO
    socket.on('joinRoom', (data, callback) => {
        const roomCode = data.roomCode.toUpperCase();
        const room = rooms[roomCode];

        if (room && room.status === 'waiting') {
            if (room.players.length >= 4) { // Límite máximo de jugadores (ejemplo: 4)
                return callback({ success: false, message: 'La sala está llena.' });
            }

            room.players.push({ id: socket.id, name: data.playerName, isHost: false });
            socket.join(roomCode);
            
            // Avisar a todos los de la sala que entró alguien nuevo
            io.to(roomCode).emit('playerJoined', room.players);
            callback({ success: true, roomCode: roomCode, players: room.players });
        } else {
            callback({ success: false, message: 'Código de sala inválido o partida en curso.' });
        }
    });

    // SELECCIONAR MAPA Y EMPEZAR PARTIDA
    socket.on('startGame', (roomCode, mapData) => {
        const room = rooms[roomCode];
        if (room) {
            room.status = 'playing';
            room.map = mapData;
            io.to(roomCode).emit('gameStarted', { map: mapData });
        }
    });

    // SINCRONIZACIÓN DE VEHÍCULOS EN TIEMPO REAL
    socket.on('playerUpdate', (data) => {
        // data incluye: roomCode, x, y, rotación, velocidad, etc.
        // Se reenvía a los demás jugadores de la misma sala (broadcast)
        socket.to(data.roomCode).emit('enemyUpdate', {
            id: socket.id,
            x: data.x,
            y: data.y,
            rotation: data.rotation,
            speed: data.speed
        });
    });

    // DESCONEXIÓN
    socket.on('disconnect', () => {
        console.log(`🔴 Jugador desconectado: ${socket.id}`);
        // Buscar en qué sala estaba y eliminarlo
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    delete rooms[roomCode]; // Borrar la sala si se queda vacía
                } else {
                    io.to(roomCode).emit('playerLeft', room.players); // Actualizar UI del lobby
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor de CRUSH CARS corriendo en el puerto ${PORT}`);
});
