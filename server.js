const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { Server: SocketIOServer } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Servir de forma estática imágenes, audios, texturas y modelos 3D del repositorio
app.use(express.static(path.resolve(__dirname)));

app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'crush-cars.html');
    fs.readFile(filePath, 'utf8', (err, html) => {
        if (err) {
            return res.status(500).send("Error critico: No se encontro crush-cars.html");
        }
        
        // 1. Inyección de Red Forzada e Instantánea en la cabecera (Anula fallos internos del HTML)
        const fixScript = `
        <head>
        <script>
            window.MP_SERVER = window.location.origin;
            
            // Forzar conexión inmediata en cuanto cargue el script de socket.io
            function iniciarRedInmediata() {
                if (typeof io !== 'undefined' && !window.socket) {
                    window.socket = io(window.location.origin, {
                        transports: ['websocket', 'polling'],
                        timeout: 5000,
                        reconnection: true
                    });
                    
                    window.socket.on('connect', () => {
                        console.log("¡Conectado automáticamente al servidor multijugador!");
                        // Vincular la instancia global si el juego usa otra variable
                        if (typeof socket === 'undefined') {
                            window.socket = window.socket;
                        }
                    });

                    window.socket.on('connect_error', (e) => {
                        console.log("Reintentando conexion...");
                    });
                }
            }

            // Ejecutar la conexión en bucle rápido hasta que se establezca con éxito
            const checkInt = setInterval(() => {
                if (typeof io !== 'undefined') {
                    iniciarRedInmediata();
                    clearInterval(checkInt);
                }
            }, 100);
        </script>`;
        
        let htmlModificado = html.replace('<head>', fixScript);

        // 2. Anular de raíz el script de fallback defectuoso que congela el juego en negro/azul
        htmlModificado = htmlModificado
            .replace('<script id="ioFallback">', '<!-- <script id="ioFallback">')
            .replace('<\/script>\r\n<style>', '<\/script> -->\r\n<style>')
            .replace('<\/script>\n<style>', '<\/script> -->\n<style>')
            .replace('<\/script><style>', '<\/script> --><style>');

        res.send(htmlModificado);
    });
});

app.get('*', (req, res) => {
    res.redirect('/');
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

const io = new SocketIOServer(server, {
    cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
    transports: ['polling', 'websocket'],
    pingTimeout: 90000,
    pingInterval: 20000
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    if (!pathname.startsWith('/socket.io')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
});

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

function actualizarSalaGlobal(codigoSala) {
    const sala = salas.get(codigoSala);
    if (!sala) return;

    const listaJugadores = Array.from(sala.jugadores.values());

    io.to(codigoSala).emit('ACTUALIZAR_SALA', { jugadores: listaJugadores });

    sala.jugadoresNat?.forEach((info, cliente) => {
        if (cliente.readyState === WebSocket.OPEN) {
            cliente.send(JSON.stringify({ type: 'ACTUALIZAR_SALA', jugadores: listaJugadores }));
        }
    });
}

io.on('connection', (socket) => {
    let salaActual = null;
    let jugadorId = null;

    socket.emit('connect_success', { status: 'ok' });

    socket.on('CREAR_SALA', (data) => {
        const nuevoCodigo = generarCodigoSala();
        salaActual = nuevoCodigo;
        jugadorId = data?.jugadorId || 'Host';

        socket.join(nuevoCodigo);
        salas.set(nuevoCodigo, {
            configuracion: data?.configuracion || {},
            jugadores: new Map([[socket.id, { id: jugadorId, nombre: data?.nombre || 'Piloto', coche: data?.coche, listo: false }]]),
            jugadoresNat: new Map()
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
            actualizarSalaGlobal(codigoUnir);
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
                actualizarSalaGlobal(salaActual);
            }
        }
    });

    socket.on('MOVIMIENTO_CARRERA', (data) => {
        if (salaActual) {
            socket.to(salaActual).emit('OPONENTE_MOVIMIENTO', { jugadorId, datos: data?.datos });
            salas.get(salaActual)?.jugadoresNat?.forEach((info, cliente) => {
                if (cliente.readyState === WebSocket.OPEN) {
                    cliente.send(JSON.stringify({ type: 'OPONENTE_MOVIMIENTO', jugadorId, datos: data?.datos }));
                }
            });
        }
    });

    socket.on('INICIAR_CARRERA', () => {
        if (salaActual) {
            io.to(salaActual).emit('CARRERA_EMPEZADA');
            salas.get(salaActual)?.jugadoresNat?.forEach((info, cliente) => {
                if (cliente.readyState === WebSocket.OPEN) {
                    cliente.send(JSON.stringify({ type: 'CARRERA_EMPEZADA' }));
                }
            });
        }
    });

    socket.on('disconnect', () => {
        if (salaActual && salas.has(salaActual)) {
            const sala = salas.get(salaActual);
            sala.jugadores?.delete(socket.id);
            if (sala.jugadores.size === 0 && sala.jugadoresNat.size === 0) {
                salas.delete(salaActual);
            } else {
                actualizarSalaGlobal(salaActual);
            }
        }
    });
});

wss.on('connection', (ws) => {
    let salaActual = null;
    let jugadorId = null;

    ws.send(JSON.stringify({ type: 'connect_success', status: 'ok' }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'CREAR_SALA':
                    const nuevoCodigo = generarCodigoSala();
                    salaActual = nuevoCodigo;
                    jugadorId = data.jugadorId || 'Host';

                    salas.set(nuevoCodigo, {
                        configuracion: data.configuracion || {},
                        jugadores: new Map(),
                        jugadoresNat: new Map([[ws, { id: jugadorId, nombre: data.nombre || 'Piloto', coche: data.coche, listo: false }]])
                    });
                    ws.send(JSON.stringify({ type: 'SALA_CREADA', codigo: nuevoCodigo }));
                    break;

                case 'UNIRSE_SALA':
                    const codigoUnir = data.codigo?.toUpperCase();
                    if (salas.has(codigoUnir)) {
                        salaActual = codigoUnir;
                        jugadorId = data.jugadorId || `Jugador_${Date.now()}`;
                        
                        const sala = salas.get(codigoUnir);
                        sala.jugadoresNat.set(ws, { id: jugadorId, nombre: data.nombre || 'Piloto', coche: data.coche, listo: false });

                        ws.send(JSON.stringify({ type: 'SALA_UNIDO', codigo: codigoUnir, configuracion: sala.configuracion }));
                        actualizarSalaGlobal(codigoUnir);
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'La sala no existe' }));
                    }
                    break;

                case 'ACTUALIZAR_ESTADO':
                    if (salaActual && salas.has(salaActual)) {
                        const sala = salas.get(salaActual);
                        const jugador = sala.jugadoresNat.get(ws);
                        if (jugador) {
                            if (data.coche) jugador.coche = data.coche;
                            if (typeof data.listo !== 'undefined') jugador.listo = data.listo;
                            actualizarSalaGlobal(salaActual);
                        }
                    }
break;
case 'MOVIMIENTO_CARRERA':
if (salaActual) {
const sala = salas.get(salaActual);
sala.jugadoresNat.forEach((info, cliente) => {
if (cliente !== ws && cliente.readyState === WebSocket.OPEN) {
cliente.send(JSON.stringify({ type: 'OPONENTE_MOVIMIENTO', jugadorId, datos: data.datos }));
}
});
io.to(salaActual).emit('OPONENTE_MOVIMIENTO', { jugadorId, datos: data.datos });
}
break;
case 'INICIAR_CARRERA':
if (salaActual) {
io.to(salaActual).emit('CARRERA_EMPEZADA');
salas.get(salaActual).jugadoresNat.forEach((info, cliente) => {
if (cliente.readyState === WebSocket.OPEN) {
cliente.send(JSON.stringify({ type: 'CARRERA_EMPEZADA' }));
}
});
}
break;
case 'PING':
ws.send(JSON.stringify({ type: 'PONG' }));
break;
}
} catch (e) {
console.error(e);
}
});
ws.on('close', () => {
if (salaActual && salas.has(salaActual)) {
const sala = salas.get(salaActual);
sala.jugadoresNat.delete(ws);
if (sala.jugadores.size === 0 && sala.jugadoresNat.size === 0) {
salas.delete(salaActual);
} else {
actualizarSalaGlobal(salaActual);
}
}
});
});
server.listen(PORT, () => {
console.log("Servidor reparador automatico en linea.");
});
