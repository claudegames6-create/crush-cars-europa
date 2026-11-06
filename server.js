const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.use(cors());

// Hace que la carpeta 'public' sea accesible desde el navegador
app.use(express.static(path.join(__dirname, 'public')));

// Puerto dinámico de Render
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
    console.log(`Servidor de Crush Cars corriendo en el puerto ${PORT}`);
});

// Inicializar el servidor WebSocket
const wss = new WebSocketServer({ server });
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

wss.on('connection', (ws) => {
    let salaActual = null;
    let jugadorId = null;

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
                        jugadores: new Map([[ws, { id: jugadorId, nombre: data.nombre, coche: data.coche, listo: false }]])
                    });

                    ws.send(JSON.stringify({ type: 'SALA_CREADA', codigo: nuevoCodigo }));
                    break;

                case 'UNIRSE_SALA':
                    const codigoUnir = data.codigo?.toUpperCase();
                    if (salas.has(codigoUnir)) {
                        salaActual = codigoUnir;
                        jugadorId = data.jugadorId || `Jugador_${Date.now()}`;
                        
                        const sala = salas.get(codigoUnir);
                        sala.jugadores.set(ws, { id: jugadorId, nombre: data.nombre, coche: data.coche, listo: false });

                        ws.send(JSON.stringify({ type: 'SALA_UNIDO', codigo: codigoUnir, configuracion: sala.configuracion }));
                        enviarActualizacionSala(codigoUnir);
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'La sala no existe' }));
                    }
                    break;

                case 'ACTUALIZAR_ESTADO':
                    if (salaActual && salas.has(salaActual)) {
                        const sala = salas.get(salaActual);
                        const jugador = sala.jugadores.get(ws);
                        if (jugador) {
                            if (data.coche) jugador.coche = data.coche;
                            if (typeof data.listo !== 'undefined') jugador.listo = data.listo;
                            enviarActualizacionSala(salaActual);
                        }
                    }
                    break;

                case 'MOVIMIENTO_CARRERA':
                    if (salaActual && salas.has(salaActual)) {
                        const sala = salas.get(salaActual);
                        sala.jugadores.forEach((info, cliente) => {
                            if (cliente !== ws && cliente.readyState === WebSocket.OPEN) {
                                cliente.send(JSON.stringify({
                                    type: 'OPONENTE_MOVIMIENTO',
                                    jugadorId: jugadorId,
                                    datos: data.datos
                                }));
                            }
                        });
                    }
                    break;

                case 'INICIAR_CARRERA':
                    if (salaActual && salas.has(salaActual)) {
                        salas.get(salaActual).jugadores.forEach((info, cliente) => {
                            if (cliente.readyState === WebSocket.OPEN) {
                                cliente.send(JSON.stringify({ type: 'CARRERA_EMPEZADA' }));
                            }
                        });
                    }
                    break;
            }
        } catch (error) {
            console.error("Error:", error);
        }
    });

    ws.on('close', () => {
        if (salaActual && salas.has(salaActual)) {
            const sala = salas.get(salaActual);
            sala.jugadores.delete(ws);
            if (sala.jugadores.size === 0) {
                salas.delete(salaActual);
            } else {
                enviarActualizacionSala(salaActual);
            }
        }
    });
});

function enviarActualizacionSala(codigoSala) {
    const sala = salas.get(codigoSala);
    if (!sala) return;

    const listaJugadores = Array.from(sala.jugadores.values());
    sala.jugadores.forEach((info, cliente) => {
        if (cliente.readyState === WebSocket.OPEN) {
            cliente.send(JSON.stringify({ type: 'ACTUALIZAR_SALA', jugadores: listaJugadores }));
        }
    });
}
