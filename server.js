const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.use(cors());

// Puerto dinámico asignado por Render o 3000 localmente
const PORT = process.env.PORT || 3000;

// Ruta base para que Render verifique que el servicio está activo (Health Check)
app.get('/', (req, res) => {
    res.send({ status: "online", game: "Crush Cars Europa" });
});

const server = app.listen(PORT, () => {
    console.log(`Servidor de Crush Cars corriendo en el puerto ${PORT}`);
});

// Inicializar el servidor WebSocket sobre el mismo servidor HTTP
const wss = new WebSocketServer({ server });

// Estructura de memoria para almacenar las salas activas
const salas = new Map();

// Función auxiliar para generar un código único de sala (Ej: CC-7K9P2)
function generarCodigoSala() {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Evitamos O, 0, I, 1
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

                    ws.send(JSON.stringify({
                        type: 'SALA_CREADA',
                        codigo: nuevoCodigo
                    }));
                    break;

                case 'UNIRSE_SALA':
                    const codigoUnir = data.codigo?.toUpperCase();
                    if (salas.has(codigoUnir)) {
                        salaActual = codigoUnir;
                        jugadorId = data.jugadorId || `Jugador_${Date.now()}`;
                        
                        const sala = salas.get(codigoUnir);
                        sala.jugadores.set(ws, { id: jugadorId, nombre: data.nombre, coche: data.coche, listo: false });

                        // Notificar el éxito al jugador que se une
                        ws.send(JSON.stringify({ type: 'SALA_UNIDO', codigo: codigoUnir, configuracion: sala.configuracion }));

                        // Actualizar lista de jugadores a todos en la sala
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
                    // Retransmisión rápida de coordenadas/física a los demás jugadores durante la partida
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
            console.error("Error procesando mensaje:", error);
        }
    });

    ws.on('close', () => {
        if (salaActual && salas.has(salaActual)) {
            const sala = salas.get(salaActual);
            sala.jugadores.delete(ws);

            if (sala.jugadores.size === 0) {
                salas.delete(salaActual); // Eliminar sala vacía
            } else {
                enviarActualizacionSala(salaActual); // Informar de la desconexión
            }
        }
    });
});

// Función para enviar la lista de jugadores conectados a todos los integrantes de una sala
function enviarActualizacionSala(codigoSala) {
    const sala = salas.get(codigoSala);
    if (!sala) return;

    const listaJugadores = Array.from(sala.jugadores.values());

    sala.jugadores.forEach((info, cliente) => {
        if (cliente.readyState === WebSocket.OPEN) {
            cliente.send(JSON.stringify({
                type: 'ACTUALIZAR_SALA',
                jugadores: listaJugadores
            }));
        }
    });
}
