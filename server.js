const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// Inicializar la aplicación Express
const app = express();

// Configuración estricta de CORS para evitar bloqueos de recursos
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware para parsear JSON y formularios por si tu juego envía datos/guardados
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Deshabilitar cabecera por seguridad
app.disable('x-powered-by');

// Servir archivos estáticos desde la raíz del proyecto (HTML, JS, CSS, Assets)
app.use(express.static(path.resolve(__dirname)));

// Configuración de rutas explícitas para asegurar que no falle ningún recurso compartido
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
        if (err) {
            res.status(500).send("Error: El archivo index.html no se encuentra en la raíz del servidor.");
        }
    });
});

// Endpoint de respaldo para sistemas de monitoreo o Health Checks de Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: "online", 
        timestamp: new Date(),
        game: "Crush Cars Europa" 
    });
});

// Capturar cualquier otra ruta GET errónea y redirigirla al index.html (Evita el 'Cannot GET')
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Crear el servidor HTTP nativo unificado
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Inicializar y acoplar el servidor WebSocket
const wss = new WebSocketServer({ server });

// Memoria dinámica para la gestión de salas y emparejamientos
const salas = new Map();

// Generador de códigos únicos de sala sin caracteres ambiguos
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

// Lógica de Red y Mensajería WebSocket para el Multijugador
wss.on('connection', (ws, req) => {
    let salaActual = null;
    let jugadorId = null;

    console.log(`Nueva conexión establecida desde: ${req.socket.remoteAddress}`);

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
                    console.log(`Sala creada de forma segura: ${nuevoCodigo}`);
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
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'La sala no existe o ha expirado.' }));
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
                    // Retransmisión de datos de alta velocidad en tiempo real
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
                
                case 'PING':
                    // Mantiene la conexión activa en Render evitando que se cierre por inactividad
                    ws.send(JSON.stringify({ type: 'PONG' }));
                    break;
            }
        } catch (error) {
            console.error("Error al procesar el paquete de red:", error);
        }
    });

    ws.on('close', () => {
        if (salaActual && salas.has(salaActual)) {
            const sala = salas.get(salaActual);
            sala.jugadores.delete(ws);
            if (sala.jugadores.size === 0) {
                salas.delete(salaActual);
                console.log(`Sala destruida por vaciado: ${salaActual}`);
            } else {
                enviarActualizacionSala(salaActual);
            }
        }
    });
});

// Función de sincronización masiva de jugadores
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

// Iniciar la escucha en el puerto de Render
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` Servidor de Producción de Crush Cars Inicializado `);
    console.log(` Escuchando conexiones en el Puerto: ${PORT}       `);
    console.log(`====================================================`);
});
