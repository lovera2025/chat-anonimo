const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const sgMail = require('@sendgrid/mail');
const language = require('@google-cloud/language');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');

// --- Configuración de Conexiones ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const mongoUri = process.env.MONGODB_URI;
const languageClient = new language.LanguageServiceClient();
const mongoClient = new MongoClient(mongoUri);

let db;
mongoClient.connect().then(client => {
    console.log('Conectado a la base de datos de MongoDB Atlas');
    db = client.db('chat_anonimo');
}).catch(err => console.error('Error al conectar a MongoDB:', err));

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = socketIO(server);

// --- Configuración de Sesiones ---
const sessionMiddleware = session({
    secret: 'mi_secreto_de_sesion_super_seguro_cambiar',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: mongoUri,
        ttl: 14 * 24 * 60 * 60 // 14 días
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production' // Usa cookies seguras en producción (Render)
    }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// --- Rutas de Autenticación ---
app.post('/register', async (req, res) => {
    const { email, password, fullName, specialty } = req.body;
    if (!db) return res.status(500).json({ message: 'Error del servidor.' });

    const existingProfessional = await db.collection('professionals').findOne({ email });
    if (existingProfessional) return res.status(400).json({ message: 'El email ya está registrado.' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newProfessional = { email, password: hashedPassword, fullName, specialty, createdAt: new Date() };
    
    try {
        await db.collection('professionals').insertOne(newProfessional);
        res.status(201).json({ success: true, message: 'Profesional registrado con éxito.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al registrar el profesional.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!db) return res.status(500).json({ message: 'Error del servidor.' });

    const professional = await db.collection('professionals').findOne({ email });
    if (!professional) return res.status(401).json({ message: 'Credenciales incorrectas.' });

    const isMatch = await bcrypt.compare(password, professional.password);
    if (!isMatch) return res.status(401).json({ message: 'Credenciales incorrectas.' });

    req.session.professional = { id: professional._id.toString(), email: professional.email, fullName: professional.fullName };
    res.json({ success: true, professional: req.session.professional });
});

app.get('/check-session', (req, res) => {
    if (req.session.professional) {
        res.json({ loggedIn: true, professional: req.session.professional });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ message: 'Error al cerrar sesión.' });
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// --- Lógica de Socket.IO ---
let liveUsers = {};
let adminSockets = [];

io.on('connection', (socket) => {
    const session = socket.request.session;

    if (session && session.professional) {
        console.log(`Un profesional (${session.professional.fullName}) se ha conectado: ${socket.id}`);
        adminSockets.push(socket.id);
        socket.join('admin-room'); // <-- CAMBIO 1: El profesional se une a la sala de admins
        socket.emit('admin-welcome', session.professional);
    } else {
        console.log(`Un usuario se ha conectado: ${socket.id}`);
    }

    socket.on('register-user', (userId) => {
        liveUsers[userId] = socket.id;
    });

    socket.on('admin-request-alerts', async () => {
        if (session && session.professional) {
            try {
                const alerts = await db.collection('alerts').find({ status: 'pendiente' }).sort({ timestamp: -1 }).toArray();
                socket.emit('alert-history', alerts);
            } catch (e) { console.error('Error al obtener alertas:', e); }
        }
    });

    socket.on('chat message', async (data) => {
        try {
            const document = { content: data.message, type: 'PLAIN_TEXT', language: 'es' };
            const [result] = await languageClient.analyzeSentiment({document});
            const sentiment = result.documentSentiment;
            if (sentiment.score <= -0.5 && sentiment.magnitude >= 0.5) {
                socket.emit('request-alert-confirmation', { message: data.message, user: data.senderId });
            } else {
                io.emit('chat message', data);
            }
        } catch (error) {
            console.error('ERROR con IA:', error);
            io.emit('chat message', data);
        }
    });
    
    socket.on('alert-confirmed', async (alertData) => {
        const alertRecord = { userId: alertData.user, message: alertData.message, timestamp: new Date(), status: 'pendiente' };
        try {
            const result = await db.collection('alerts').insertOne(alertRecord);
            socket.emit('alert-queued');

            // Notifica a todos los admins conectados
            adminSockets.forEach(adminId => {
                io.to(adminId).emit('new-alert-in-queue', { ...alertRecord, _id: result.insertedId });
            });
        } catch (e) { console.error(e); }
        
        sgMail.send({
            to: 'maximiliano1523@gmail.com', from: 'maximiliano1523@gmail.com',
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
            await db.collection('alerts').updateOne({ _id: new ObjectId(alertId) }, { $set: { status: 'activa', attendedBy: session.professional.fullName } });
            
            // <-- CAMBIO 2: Avisa a los otros admins en la sala que la alerta fue tomada
            socket.to('admin-room').emit('alert-claimed', { alertId: alertId });

            adminSocket.emit('private-session-started', { roomId: privateRoomId, user: targetUserId });
            userSocket.emit('private-session-started', { roomId: privateRoomId, user: session.professional.fullName });
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
                console.log(`Usuario ${userId} desconectado.`);
                break;
            }
        }
        const adminIndex = adminSockets.indexOf(socket.id);
        if (adminIndex > -1) {
            adminSockets.splice(adminIndex, 1);
            console.log(`Un profesional se ha desconectado: ${socket.id}`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});