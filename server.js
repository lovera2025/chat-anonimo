const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const sgMail = require('@sendgrid/mail');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');

// --- Configuración (sin cambios) ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const mongoUri = process.env.MONGODB_URI;
const mongoClient = new MongoClient(mongoUri);
let db;
mongoClient.connect().then(client => {
    console.log('Conectado a la base de datos');
    db = client.db('chat_anonimo');
}).catch(console.error);
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = socketIO(server);
const sessionMiddleware = session({
    secret: 'mi_secreto_de_sesion_super_seguro',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: mongoUri, dbName: 'chat_anonimo', collectionName: 'sessions', ttl: 14 * 24 * 60 * 60 })
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
// --- Fin de la Configuración ---


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

// ... (El resto del código de Socket.IO no cambia) ...
io.on('connection', (socket) => {
    // ...
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});