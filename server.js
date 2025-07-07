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
const clientPromise = mongoClient.connect().then(client => {
    console.log('Conectado a la base de datos de MongoDB Atlas');
    db = client.db('chat_anonimo');
    return client;
}).catch(err => console.error('Error al conectar a MongoDB:', err));

const app = express();

// --- AJUSTE FINAL Y CLAVE ---
// Le decimos a Express que confíe en el proxy de Render.
// Esto debe ir antes de que se configure el middleware de sesión.
app.set('trust proxy', 1);

app.use(express.json());
const server = http.createServer(app);
const io = socketIO(server);

// --- Configuración de Sesiones ---
const sessionMiddleware = session({
    secret: 'mi_secreto_de_sesion_super_seguro_cambiar',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        clientPromise: clientPromise,
        ttl: 14 * 24 * 60 * 60,
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production'
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

    const professionalInfo = { 
        id: professional._id.toString(), 
        email: professional.email, 
        fullName: professional.fullName 
    };

    req.session.regenerate(err => {
        if (err) return res.status(500).json({ message: 'Error del servidor durante el login.' });
        req.session.professional = professionalInfo;
        req.session.save(saveErr => {
            if (saveErr) return res.status(500).json({ message: 'Error del servidor durante el login.' });
            res.json({ success: true, professional: req.session.professional });
        });
    });
});

app.get('/check-session', (req, res) => {
    if (req.session && req.session.professional) {
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
io.on('connection', (socket) => {
    const session = socket.request.session;
    if (session && session.professional) {
        console.log(`Un profesional (${session.professional.fullName}) se ha conectado: ${socket.id}`);
        socket.join('admin-room');
    }

    socket.on('register-user', (userId) => { liveUsers[userId] = socket.id; });

    socket.on('admin-request-alerts', async () => {
        socket.request.session.reload(async (err) => {
            if (err) return console.error("Error recargando sesión en socket:", err);
            if (socket.request.session && socket.request.session.professional) {
                try {
                    const alerts = await db.collection('alerts').find({ status: 'pendiente' }).sort({ timestamp: -1 }).toArray();
                    socket.emit('alert-history', alerts);
                } catch (e) { console.error('Error al obtener alertas:', e); }
            }
        });
    });

    socket.on('chat message', async (data) => {
        try {
            const document = { content: data.message, type: 'PLAIN_TEXT', language: 'es' };
            const [result] = await languageClient.analyzeSentiment({document});
            const sentiment = result.documentSentiment;
            if (sentiment.score <= -0.5 && sentiment.magnitude >= 0.5) {
                socket.emit('request-alert-confirmation', { message: data.message, user: data.senderId });
            } else { io.emit('chat message', data); }
        } catch (error) { io.emit('chat message', data); }
    });
    
    socket.on('alert-confirmed', async (alertData) => {
        const alertRecord = { userId: alertData.user, message: alertData.message, timestamp: new Date(), status: 'pendiente' };
        try {
            const result = await db.collection('alerts').insertOne(alertRecord);
            socket.emit('alert-queued');
            io.to('admin-room').emit('new-alert-in-queue', { ...alertRecord, _id: result.insertedId });
        } catch (e) { console.error(e); }
        
        sgMail.send({
            to: 'maximiliano1523@gmail.com', from: 'maximiliano1523@gmail.com',
            subject: '⚠️ NUEVA ALERTA PENDIENTE ⚠️',
            html: `<h1>Nueva Alerta en la Cola</h1><p>Usuario: ${alertData.user}</p><p>Mensaje: "${alertData.message}"</p><p>Inicia sesión en el panel para atenderla.</p>`
        }).catch(console.error);
    });

    socket.on('admin-connect-to-user', async (data) => {
        const professionalFullName = socket.request.session.professional ? socket.request.session.professional.fullName : 'Admin';
        const { alertId, targetUserId } = data;
        const targetSocketId = liveUsers[targetUserId];

        if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
            const userSocket = io.sockets.sockets.get(targetSocketId);
            const privateRoomId = `session-${alertId}`;
            socket.join(privateRoomId);
            userSocket.join(privateRoomId);
            await db.collection('alerts').updateOne({ _id: new ObjectId(alertId) }, { $set: { status: 'activa', attendedBy: professionalFullName } });
            socket.to('admin-room').emit('alert-claimed', { alertId: alertId });
            socket.emit('private-session-started', { roomId: privateRoomId, user: targetUserId });
            userSocket.emit('private-session-started', { roomId: privateRoomId, user: professionalFullName });
        } else {
            socket.emit('user-disconnected-error', { userId: targetUserId });
            await db.collection('alerts').updateOne({ _id: new ObjectId(alertId) }, { $set: { status: 'cerrada (offline)' } });
        }
    });

    socket.on('private-message', (data) => { socket.to(data.roomId).emit('private-message', data); });

    // --- Lógica para el indicador de escritura ---
    socket.on('typing', (data) => {
        const payload = { senderId: data.senderId };
        if (data.roomId) {
            socket.to(data.roomId).emit('typing', payload);
        } else {
            socket.broadcast.emit('typing', payload);
        }
    });

    socket.on('stop typing', (data) => {
        if (data.roomId) {
            socket.to(data.roomId).emit('stop typing');
        } else {
            socket.broadcast.emit('stop typing');
        }
    });
    // --- Fin de la lógica del indicador ---

    socket.on('disconnect', () => {
        for (const userId in liveUsers) {
            if (liveUsers[userId] === socket.id) {
                delete liveUsers[userId];
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});