const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const Sentiment = require('sentiment');
const twilio = require('twilio');

// --- Configuración de Twilio y Sentiment ---
// Se leen las credenciales de forma segura desde las Variables de Entorno de Render.
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = new twilio(accountSid, authToken);
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const myPhoneNumber = process.env.MY_PHONE_NUMBER;

const sentiment = new Sentiment();
// ---------------------------------------------

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Define el puerto para el servidor
const PORT = process.env.PORT || 3000;

// Sirve archivos estáticos desde la carpeta actual
app.use(express.static(__dirname));

// Ruta principal para servir el archivo index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Manejo de conexiones Socket.IO
io.on('connection', (socket) => {
    console.log(`Un usuario se ha conectado: ${socket.id}`);

    // Manejar eventos de chat
    socket.on('chat message', (data) => {
        const messageText = data.message.toLowerCase();
        const result = sentiment.analyze(messageText);

        const keywords = ['abuso', 'maltrato', 'ayudenme', 'peligro', 'socorro', 'violan', 'pegan', 'acoso', 'bullying'];
        const hasKeyword = keywords.some(word => messageText.includes(word));

        if (hasKeyword && result.score < 0) {
            socket.emit('request-alert-confirmation', {
                message: data.message,
                user: data.senderId
            });
        } else {
            io.emit('chat message', data);
        }
    });
    
    // Escuchar la confirmación del usuario para enviar la alerta
    socket.on('alert-confirmed', (alertData) => {
        console.log(`¡ALERTA CONFIRMADA POR ${alertData.user}! Enviando SMS...`);
        
        const alertMessageBody = `ALERTA DE ABUSO EN CHAT ANÓNIMO:\nUsuario: ${alertData.user}\nMensaje: "${alertData.message}"\nPor favor, revisa la situación.`;

        twilioClient.messages
            .create({
                body: alertMessageBody,
                from: twilioPhoneNumber,
                to: myPhoneNumber
            })
            .then(message => console.log('SMS de alerta enviado con SID:', message.sid))
            .catch(err => console.error('Error al enviar SMS:', err));
    });

    // Manejar desconexiones
    socket.on('disconnect', () => {
        console.log(`Un usuario se ha desconectado: ${socket.id}`);
    });
});

// Iniciar el servidor
server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});