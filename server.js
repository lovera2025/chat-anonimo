const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb'); // <-- LIBRERÍA DE MONGODB
const sgMail = require('@sendgrid/mail');
const language = require('@google-cloud/language');

// --- Configuración de Conexiones ---
const languageClient = new language.LanguageServiceClient(); 
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const mongoUri = process.env.MONGODB_URI;
const mongoClient = new MongoClient(mongoUri);

let db;
// Conexión a MongoDB al iniciar
mongoClient.connect().then(client => {
    console.log('Conectado a la base de datos de MongoDB Atlas');
    db = client.db('chat_anonimo');
}).catch(err => console.error('Error al conectar a MongoDB:', err));

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = "gg_proyecto"; // Cambia esto por una clave más segura

let liveUsers = {}; // Mapa para rastrear usuarios en vivo { userId: socket.id }
let adminSocketId = null; // Guardará el socket del admin

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

io.on('connection', (socket) => {
    console.log(`Un usuario se ha conectado: ${socket.id}`);

    socket.on('register-user', (userId) => {
        liveUsers[userId] = socket.id;
        console.log(`Usuario ${userId} registrado con socket ${socket.id}`);
    });

    socket.on('admin-connect', (key) => {
        if (key === ADMIN_KEY) {
            adminSocketId = socket.id;
            liveUsers['ADMINISTRADOR'] = socket.id; // También registramos al admin
            console.log(`¡ADMINISTRADOR CONECTADO!: ${socket.id}`);
            socket.emit('admin-welcome');
        }
    });

    socket.on('admin-request-alerts', async () => {
        if (socket.id !== adminSocketId) return; // Seguridad extra
        try {
            const alerts = await db.collection('alerts').find({ status: 'pendiente' }).sort({ timestamp: -1 }).toArray();
            socket.emit('alert-history', alerts);
        } catch (e) {
            console.error('Error al obtener alertas:', e);
        }
    });

    socket.on('chat message', async (data) => {
        const messageText = data.message;
        try {
            const document = { content: messageText, type: 'PLAIN_TEXT', language: 'es' };
            const [result] = await languageClient.analyzeSentiment({document: document});
            const sentiment = result.documentSentiment;
            console.log(`Texto: "${messageText}" | Puntaje: ${sentiment.score.toFixed(2)}, Magnitud: ${sentiment.magnitude.toFixed(2)}`);
            if (sentiment.score <= -0.5 && sentiment.magnitude >= 0.5) {
                console.log('¡Intención de riesgo detectada por la IA!');
                socket.emit('request-alert-confirmation', { message: data.message, user: data.senderId });
            } else {
                io.emit('chat message', data);
            }
        } catch (error) {
            console.error('ERROR al analizar con la IA de Google:', error);
            io.emit('chat message', data);
        }
    });
    
    socket.on('alert-confirmed', async (alertData) => {
        console.log(`Alerta confirmada por ${alertData.user}. Guardando en BD...`);
        const alertRecord = {
            userId: alertData.user,
            message: alertData.message,
            timestamp: new Date(),
            status: 'pendiente'
        };
        try {
            const result = await db.collection('alerts').insertOne(alertRecord);
            console.log('Alerta guardada en la base de datos.');
            socket.emit('alert-queued');

            if(adminSocketId) {
                io.to(adminSocketId).emit('new-alert-in-queue', { ...alertRecord, _id: result.insertedId });
            }

        } catch (e) {
            console.error('Error al guardar alerta en la BD:', e);
        }
        
        sgMail.send({
            to: 'maximiliano1523@gmail.com',
            from: 'maximiliano1523@gmail.com',
            subject: '⚠️ NUEVA ALERTA PENDIENTE ⚠️',
            html: `<h1>Nueva Alerta en la Cola</h1><p>Usuario: ${alertData.user}</p><p>Mensaje: "${alertData.message}"</p><p>Inicia sesión en el panel para atenderla.</p>`
        }).catch(console.error);
    });

    socket.on('admin-connect-to-user', async (data) => {
        const { alertId, targetUserId } = data;
        const targetSocketId = liveUsers[targetUserId];
        const adminSocket = socket;

        if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
            const userSocket = io.sockets.sockets.get(targetSocketId);
            const privateRoomId = `session-${alertId}`;

            adminSocket.join(privateRoomId);
            userSocket.join(privateRoomId);
            
            await db.collection('alerts').updateOne({ _id: new ObjectId(alertId) }, { $set: { status: 'activa' } });
            
            adminSocket.emit('private-session-started', { roomId: privateRoomId, userId: targetUserId });
            userSocket.emit('private-session-started', { roomId: privateRoomId, userId: 'ADMINISTRADOR' });
        } else {
            adminSocket.emit('user-disconnected-error', { userId: targetUserId });
            await db.collection('alerts').updateOne({ _id: new ObjectId(alertId) }, { $set: { status: 'cerrada (offline)' } });
        }
    });

    socket.on('private-message', (data) => {
        socket.to(data.roomId).emit('private-message', data);
    });

    socket.on('disconnect', () => {
        for (const userId in liveUsers) {
            if (liveUsers[userId] === socket.id) {
                delete liveUsers[userId];
                console.log(`Usuario ${userId} desconectado y eliminado del registro.`);
                if (userId === 'ADMINISTRADOR') adminSocketId = null;
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});