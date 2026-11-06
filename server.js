const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// CORS permisivo para que acepte peticiones desde cualquier origen configurado en tu input
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Servir archivos estáticos del repositorio
app.use(express.static(path.resolve(__dirname)));

// Cargar el juego en la ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'crush-cars.html'));
});

// Comodín para rutas caídas
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'crush-cars.html'));
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Inicialización flexible de Socket.io alineada con el cliente v4.7.5
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
    },
    allowEIO3: true, // Compatibilidad con clientes antiguos si los hubiera
    transports: ['polling', 'websocket'], // Asegura conexión aunque falle WebSocket directo
    pingTimeout: 60000,
    pingInterval: 25000
});

// Almacenamiento de salas en memoria dinámica
const salas = new Map();

function generarCodigoSala() {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codigo;
    do {
        let resultado = '';
        for (let i = 0; i < 5; i++) {
            resultado += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
        }
        codigo = `CC-${resultado}`;
    } while (salas.has(codigo));
    return codigo;
}

// Lógica de red para las salas multijugador del juego
io.on('connection', (socket) => {
    let salaActual = null;
    let jugadorId = null;

    // Evento de control para verificar enlace establecido
    socket.emit('connect_success', { status: 'ok' });

    socket.on('CREAR_SALA', (data) => {
        const nuevoCodigo = generarCodigoSala();
        salaActual = nuevoCodigo;
        jugadorId = data?.jugadorId || 'Host';

        socket.join(nuevoCodigo);
        salas.set(nuevoCodigo, {
            configuracion: data?.configuracion || {},
            jugadores: new Map([[socket.id, { id: jugadorId, nombre: data?.nombre || 'Piloto', coche: data?.coche, listo: false }]])
        });

        socket.emit('SALA_CREADA', { codigo: nuevoCodigo });
    });

    socket.on('UNIRSE_SALA', (data) => {
        const codigoUnir = data?.codigo?.toUpperCase();
        if (salas.has(codigoUnir)) {
            salaActual = codigoUnir;
            jugadorId = data?.jugadorId || `Jugador_${Date.now()}`;
            
            socket.join(codigoUnir);
            const sala = salas.get(codigoUnir);
            sala.jugadores.set(socket.id, { id: jugadorId, nombre: data?.nombre || 'Piloto', coche: data?.coche, listo: false });

            socket.emit('SALA_UNIDO', { codigo: codigoUnir, configuracion: sala.configuracion });
            io.to(codigoUnir).emit('ACTUALIZAR_SALA', { jugadores: Array.from(sala.jugadores.values()) });
        } else {
            socket.emit('ERROR', { message: 'La sala no existe' });
        }
    });

    socket.on('ACTUALIZAR_ESTADO', (data) => {
        if (salaActual && salas.has(salaActual)) {
            const sala = salas.get(salaActual);
            const jugador = sala.jugadores.get(socket.id);
            if (jugador) {
                if (data?.coche) jugador.coche = data.coche;
                if (typeof data?.listo !== 'undefined') jugador.listo = data.listo;
                io.to(salaActual).emit('ACTUALIZAR_SALA', { jugadores: Array.from(sala.jugadores.values()) });
            }
        }
    });

    socket.on('MOVIMIENTO_CARRERA', (data) => {
        if (salaActual) {
            socket.to(salaActual).emit('OPONENTE_MOVIMIENTO', {
                jugadorId: jugadorId,
                datos: data?.datos
            });
        }
    });

    socket.on('INICIAR_CARRERA', () => {
        if (salaActual) {
            io.to(salaActual).emit('CARRERA_EMPEZADA');
        }
    });

    socket.on('disconnect', () => {
        if (salaActual && salas.has(salaActual)) {
            const sala = salas.get(salaActual);
            sala.jugadores.delete(socket.id);

            if (sala.jugadores.size === 0) {
                salas.delete(salaActual);
            } else {
                io.to(salaActual).emit('ACTUALIZAR_SALA', { jugadores: Array.from(sala.jugadores.values()) });
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor multijugador robusto corriendo en puerto ${PORT}`);
});
