const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const Sentiment = require('sentiment');
const sgMail = require('@sendgrid/mail'); // Se usa la librería de SendGrid

// --- Configuración de SendGrid ---
// Se establece la API Key desde las Variables de Entorno de Render
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
    
    // --- LÓGICA PARA ENVIAR CORREO CON SENDGRID ---
    socket.on('alert-confirmed', (alertData) => {
        console.log(`¡ALERTA CONFIRMADA POR ${alertData.user}! Enviando Email con SendGrid...`);
        
        const msg = {
            // =================================================================
            //  ¡IMPORTANTE! USA TUS CORREOS REALES AQUÍ
            // =================================================================
            
            // El email que RECIBE la alerta.
            to: 'maximiliano1523@gmail.com', 
            
            // El email que ENVÍA la alerta (DEBE ser el que verifico en SendGrid).
            from: 'maximiliano1523@gmail.com', 
            
            // =================================================================

            subject: '⚠️ ALERTA DE ABUSO EN CHAT ANÓNIMO ⚠️',
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
    // --- FIN DE LA LÓGICA ---

    socket.on('disconnect', () => {
        console.log(`Un usuario se ha desconectado: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
