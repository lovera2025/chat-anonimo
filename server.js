const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const Sentiment = require('sentiment');
const sgMail = require('@sendgrid/mail');

const sentiment = new Sentiment(); 

// --- Configuración de SendGrid ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
// ----------------------------------

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
        
        // =======================================================
        //  LÓGICA DE DETECCIÓN CORREGIDA
        // =======================================================

        // 1. Lista de palabras clave ampliada.
        const keywords = [
            'abuso', 'abusan', 'maltrato', 'maltratan', 'ayudenme', 
            'peligro', 'socorro', 'violan', 'pegan', 'acoso', 
            'acosan', 'bullying', 'violencia'
        ];
        const hasKeyword = keywords.some(word => messageText.includes(word));

        // 2. Condición simplificada: ahora solo revisa si existe la palabra clave.
        if (hasKeyword) {
            socket.emit('request-alert-confirmation', {
                message: data.message,
                user: data.senderId
            });
        } else {
            io.emit('chat message', data);
        }
        // =======================================================
    });
    
    socket.on('alert-confirmed', (alertData) => {
        console.log(`¡ALERTA CONFIRMADA POR ${alertData.user}! Enviando Email con SendGrid...`);
        
        const msg = {
            to: 'maximiliano1523@gmail.com',
            from: 'maximiliano1523@gmail.com',
            // La línea del 'subject' ahora tiene comillas al principio y al final.
            subject: '⚠️ ALERTA DE ABUSO EN CHAT ANÓNIMO ⚠️', // <-- CORREGIDO
            html: `
                <h1>Alerta de Riesgo Detectada</h1>
                <p>Se ha detectado una posible situación de riesgo en el chat anónimo.</p>
                <ul>
                    <li><strong>Usuario Anónimo:</strong> ${alertData.user}</li>
                    <li><strong>Mensaje:</strong> "${alertData.message}"</li>
                </ul>
                <p>Por favor, revisa la situación.</p>
            `
        };

        sgMail
            .send(msg)
            .then(() => {
                console.log('Email de alerta enviado con éxito.');
            })
            .catch((error) => {
                console.error('Error al enviar el email con SendGrid:', error.response.body);
            });
    });

    socket.on('disconnect', () => {
        console.log(`Un usuario se ha desconectado: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});

// La llave extra '}' del final fue eliminada.