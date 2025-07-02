const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const Sentiment = require('sentiment');
const twilio = require('twilio');

// --- Configuración de Twilio y Sentiment ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = new twilio(accountSid, authToken);
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

// Se leen ambos números desde las variables de entorno
const myPhoneNumber = process.env.MY_PHONE_NUMBER;
const friendPhoneNumber = process.env.FRIEND_PHONE_NUMBER; // <-- NUEVO

const sentiment = new Sentiment();
// ---------------------------------------------

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`Un usuario se ha conectado: ${socket.id}`);

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
    
    socket.on('alert-confirmed', (alertData) => {
        console.log(`¡ALERTA CONFIRMADA POR ${alertData.user}! Enviando SMS a los destinatarios...`);
        
        const alertMessageBody = `ALERTA DE ABUSO EN CHAT ANÓNIMO:\nUsuario: ${alertData.user}\nMensaje: "${alertData.message}"\nPor favor, revisa la situación.`;

        // --- LÓGICA MODIFICADA PARA ENVIAR A MÚLTIPLES NÚMEROS ---
        const numbersToSendTo = [myPhoneNumber, friendPhoneNumber]; // Se crea una lista con los números

        // Se recorre la lista y se envía un SMS a cada número que exista
        numbersToSendTo.forEach(number => {
            if (number) { // Se asegura de que la variable de entorno exista antes de enviar
                twilioClient.messages
                    .create({
                        body: alertMessageBody,
                        from: twilioPhoneNumber,
                        to: number // Se usa el número actual de la lista
                    })
                    .then(message => console.log(`SMS de alerta enviado a ${number} con SID:`, message.sid))
                    .catch(err => console.error(`Error al enviar SMS a ${number}:`, err));
            }
        });
        // --- FIN DE LA LÓGICA MODIFICADA ---
    });

    socket.on('disconnect', () => {
        console.log(`Un usuario se ha desconectado: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
