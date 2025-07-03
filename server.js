const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const language = require('@google-cloud/language'); // <-- LIBRERÍA DE GOOGLE IA
const sgMail = require('@sendgrid/mail');

// --- Configuración de Google Cloud y SendGrid ---
// El cliente de la IA de Google leerá las credenciales del archivo secreto automáticamente.
const languageClient = new language.LanguageServiceClient(); 
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
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

    // La función ahora es 'async' para poder esperar la respuesta de la IA
    socket.on('chat message', async (data) => {
        const messageText = data.message;
        
        try {
            const document = {
                content: messageText,
                type: 'PLAIN_TEXT',
                language: 'es' // Especificamos que el texto es en español
            };

            const [result] = await languageClient.analyzeSentiment({document: document});
            const sentiment = result.documentSentiment;

            console.log(`Texto: "${messageText}" | Puntaje: ${sentiment.score.toFixed(2)}, Magnitud: ${sentiment.magnitude.toFixed(2)}`);

            // Condición avanzada: puntaje muy negativo Y emoción fuerte (magnitud alta)
            if (sentiment.score <= -0.5 && sentiment.magnitude >= 0.5) {
                console.log('¡Intención de riesgo detectada por la IA!');
                socket.emit('request-alert-confirmation', {
                    message: data.message,
                    user: data.senderId
                });
            } else {
                io.emit('chat message', data);
            }
        } catch (error) {
            console.error('ERROR al analizar con la IA de Google:', error);
            io.emit('chat message', data);
        }
    });
    
    socket.on('alert-confirmed', (alertData) => {
        console.log(`¡ALERTA CONFIRMADA POR ${alertData.user}! Enviando Email con SendGrid...`);
        const msg = {
            to: 'maximiliano1523@gmail.com',
            from: 'maximiliano1523@gmail.com', // Debe ser tu email verificado en SendGrid
            // LÍNEA CORREGIDA: Se añadieron las comillas al principio y al final
            subject: '⚠️ ALERTA DE ABUSO EN CHAT ANÓNIMO (IA) ⚠️',
            html: `<h1>Alerta de Riesgo Detectada</h1><p>Se ha detectado una posible situación de riesgo en el chat anónimo.</p><ul><li><strong>Usuario Anónimo:</strong> ${alertData.user}</li><li><strong>Mensaje:</strong> "${alertData.message}"</li></ul><p>Por favor, revisa la situación.</p>`
        };
        sgMail.send(msg).then(() => console.log('Email de alerta enviado con éxito.')).catch((error) => console.error('Error al enviar el email con SendGrid:', error.response ? error.response.body : error));
    });

    socket.on('disconnect', () => {
        console.log(`Un usuario se ha desconectado: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
// La llave extra '}' del final fue eliminada.