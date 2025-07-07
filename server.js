const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const sgMail = require('@sendgrid/mail');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');

// --- Configuración de Conexiones ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const mongoUri = process.env.MONGODB_URI;
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
    secret: 'mi_secreto_de_sesion_super_seguro', // Cambia esto por otra frase
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: mongoUri,
        dbName: 'chat_anonimo',
        collectionName: 'sessions',
        ttl: 14 * 24 * 60 * 60 // 14 días
    })
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// =======================================================
//  INICIO: RUTA DE LOGIN CON DEPURACIÓN
// =======================================================
app.post('/login', async (req, res) => {
    console.log('--- Intento de Login Recibido ---');
    const { email, password } = req.body;
    
    console.log('Email recibido del formulario:', email);
    console.log('Contraseña recibida del formulario:', password);

    if (!db) {
        console.log('Error: La conexión a la base de datos no está lista.');
        return res.status(500).json({ message: 'Error del servidor, intente de nuevo.' });
    }

    const professional = await db.collection('professionals').findOne({ email });

    if (!professional) {
        console.log('Resultado: No se encontró el profesional en la BD.');
        return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    console.log('Profesional encontrado en la BD:', professional.email);
    console.log('Hash de la BD:', professional.password);

    // Comparación de la contraseña
    const isMatch = await bcrypt.compare(password, professional.password);
    
    console.log('¿La contraseña coincide? (bcrypt.compare):', isMatch); // <-- EL LOG MÁS IMPORTANTE

    if (!isMatch) {
        console.log('Resultado: Las contraseñas NO coinciden.');
        return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }
    
    console.log('Resultado: ¡Login exitoso!');
    req.session.professional = {
        id: professional._id,
        email: professional.email,
        fullName: professional.fullName
    };

    res.json({ success: true, professional: req.session.professional });
});
// =======================================================
//  FIN: RUTA DE LOGIN CON DEPURACIÓN
// =======================================================

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

let adminSocketId = null; 
let liveUsers = {};

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (session && session.professional) {
        adminSocketId = socket.id;
        liveUsers['ADMINISTRADOR'] = socket.id;
        console.log(`Un profesional (${session.professional.fullName}) se ha conectado: ${socket.id}`);
        socket.emit('admin-welcome', session.professional);
    } else {
        console.log(`Un usuario se ha conectado: ${socket.id}`);
    }

    socket.on('register-user', (userId) => {
        liveUsers[userId] = socket.id;
    });

    socket.on('admin-request-alerts', async () => {
        if (socket.id !== adminSocketId) return;
        try {
            const alerts = await db.collection('alerts').find({ status: 'pendiente' }).sort({ timestamp: -1 }).toArray();
            socket.emit('alert-history', alerts);
        } catch (e) { console.error(e); }
    });

    socket.on('chat message', async (data) => {
        // La lógica de la IA fue removida en la versión anterior para simplificar,
        // usando solo palabras clave. Se mantiene esa lógica.
        const messageText = data.message.toLowerCase();
        const keywords = ['abuso', 'maltrato', 'ayuda', 'peligro', 'socorro', 'violan', 'pegan', 'acoso', 'bullying', 'violencia'];
        const hasKeyword = keywords.some(word => messageText.includes(word));

        if (hasKeyword) {
            socket.emit('request-alert-confirmation', { message: data.message, user: data.senderId });
        } else {
            io.emit('chat message', data);
        }
    });
    
    socket.on('alert-confirmed', async (alertData) => {
        const alertRecord = {
            userId: alertData.user,
            message: alertData.message,
            timestamp: new Date(),
            status: 'pendiente'
        };
        try {
            const result = await db.collection('alerts').insertOne(alertRecord);
            socket.emit('alert-queued');
            if(adminSocketId) {
                io.to(adminSocketId).emit('new-alert-in-queue', { ...alertRecord, _id: result.insertedId });
            }
        } catch (e) { console.error(e); }
        
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
            await db.collection('alerts').updateOne({ _id: new ObjectId(alertId) }, { $set: { status: 'activa', attendedBy: session.professional.id } });
            adminSocket.emit('private-session-started', { roomId: privateRoomId, userId: targetUserId });
            userSocket.emit('private-session-started', { roomId: privateRoomId, userId: session.professional.fullName });
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
                if (socket.id === adminSocketId) adminSocketId = null;
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});