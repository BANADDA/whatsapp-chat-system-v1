// Import necessary modules
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const http = require('http');
const socketIO = require('socket.io');
const admin = require('firebase-admin');
require('dotenv').config();
const cors = require('cors');

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert({
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: process.env.FIREBASE_AUTH_URI,
        token_uri: process.env.FIREBASE_TOKEN_URI,
        auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT,
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    }),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Enable CORS for all routes
app.use(cors());
app.use(bodyParser.json());

// Verify WhatsApp webhook
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.log('Failed Verification. Invalid Token');
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
    console.log("Incoming request body:", JSON.stringify(req.body, null, 2));

    try {
        if (req.body && req.body.entry && req.body.entry[0].changes &&
            req.body.entry[0].changes[0].value.messages && req.body.entry[0].changes[0].value.messages[0]) {

            const messageData = req.body.entry[0].changes[0].value;
            const messageObj = messageData.messages[0];
            const from = messageObj.from;  // Sender's WhatsApp ID (phone number)
            const messageText = messageObj.text ? messageObj.text.body : '';
            const timestamp = messageObj.timestamp;
            const messageId = messageObj.id;
            const userName = messageData.contacts[0].profile.name || 'Unknown';
            const to = messageData.metadata.display_phone_number;  // Your business's phone number
            const recipientId = to.replace(/\D/g, '');  // Normalize recipient phone number

            // Ensure users exist in Users collection
            // Sender
            const senderRef = db.collection('Users').doc(from);
            await senderRef.set({
                user_id: from,
                name: userName,
                phone_number: from,
                last_seen: new Date(parseInt(timestamp) * 1000),
                is_active: true
            }, { merge: true });

            // Recipient (your business)
            const recipientRef = db.collection('Users').doc(recipientId);
            await recipientRef.set({
                user_id: recipientId,
                name: 'Fibre Wire',
                phone_number: recipientId,
                is_active: true
            }, { merge: true });

            // Find existing conversation between sender and recipient, or create a new one
            let conversationId = null;
            const conversationsRef = db.collection('Conversations');
            const conversationSnapshot = await conversationsRef
                .where('participant_ids', 'array-contains', from)
                .where('status', '==', 'active')
                .get();

            // Check if a conversation exists between these two users
            let conversationExists = false;
            conversationSnapshot.forEach(doc => {
                const data = doc.data();
                if (data.participant_ids.includes(recipientId)) {
                    conversationExists = true;
                    conversationId = doc.id;
                }
            });

            if (!conversationExists) {
                // Create a new conversation
                const newConversationRef = conversationsRef.doc();
                await newConversationRef.set({
                    conversation_id: newConversationRef.id,
                    participant_ids: [from, recipientId],
                    status: 'active',
                    start_time: new Date(parseInt(timestamp) * 1000),
                    last_message: {
                        message_id: messageId,
                        content: messageText
                    }
                });
                conversationId = newConversationRef.id;
            } else {
                // Update last_message of the existing conversation
                const conversationRef = conversationsRef.doc(conversationId);
                await conversationRef.update({
                    last_message: {
                        message_id: messageId,
                        content: messageText
                    }
                });
            }

            // Store the message in Messages collection
            const messagesRef = db.collection('Messages').doc(messageId);
            await messagesRef.set({
                message_id: messageId,
                conversation_id: conversationId,
                sender_id: from,
                timestamp: new Date(parseInt(timestamp) * 1000),
                content: messageText,
                message_type: 'text',
                is_read: false
            });

            console.log("Message successfully stored in Firestore");

            // Emit the message to connected clients
            io.emit('newMessage', {
                conversation_id: conversationId,
                sender_id: from,
                content: messageText,
                timestamp: new Date(parseInt(timestamp) * 1000)
            });

            // Respond with a success status
            res.sendStatus(200);
        } else {
            console.error('Invalid request format:', JSON.stringify(req.body, null, 2));
            res.status(400).send('Invalid request format');
        }
    } catch (error) {
        console.error('Error processing request:', error.message);
        res.status(500).send('Internal server error');
    }
});

// Send a message from the agent to the user
app.post('/send-whatsapp-message', async (req, res) => {
    const { message, recipientNumber } = req.body;

    try {
        // Send message via WhatsApp API
        await sendWhatsAppMessage(message, recipientNumber);

        // Ensure the recipient exists in Users collection
        const recipientRef = db.collection('Users').doc(recipientNumber);
        const recipientDoc = await recipientRef.get();
        if (!recipientDoc.exists) {
            await recipientRef.set({
                user_id: recipientNumber,
                name: 'Unknown User',
                phone_number: recipientNumber,
                is_active: true
            });
        }

        // Get or create a conversation between agent and recipient
        // const agentId = process.env.BUSINESS_PHONE_NUMBER.replace(/\D/g, '');  // Your business's phone number
        const agentId = process.env.BUSINESS_PHONE_NUMBER;
        let conversationId = null;
        const conversationsRef = db.collection('Conversations');
        const conversationSnapshot = await conversationsRef
            .where('participant_ids', 'array-contains', recipientNumber)
            .where('status', '==', 'active')
            .get();

        let conversationExists = false;
        conversationSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.participant_ids.includes(agentId)) {
                conversationExists = true;
                conversationId = doc.id;
            }
        });

        if (!conversationExists) {
            const newConversationRef = conversationsRef.doc();
            await newConversationRef.set({
                conversation_id: newConversationRef.id,
                participant_ids: [agentId, recipientNumber],
                status: 'active',
                start_time: new Date(),
                last_message: {
                    message_id: null,
                    content: message
                }
            });
            conversationId = newConversationRef.id;
        } else {
            const conversationRef = conversationsRef.doc(conversationId);
            await conversationRef.update({
                last_message: {
                    message_id: null,
                    content: message
                }
            });
        }

        // Store the agent's message in Messages collection
        const messageId = db.collection('Messages').doc().id;
        await db.collection('Messages').doc(messageId).set({
            message_id: messageId,
            conversation_id: conversationId,
            sender_id: agentId,
            timestamp: new Date(),
            content: message,
            message_type: 'text',
            is_read: false
        });

        console.log('Agent message stored in Firestore');

        res.status(200).json({ message: 'Message sent successfully' });
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error sending message' });
    }
});

// Function to send message via WhatsApp API
const sendWhatsAppMessage = (message, recipientNumber) => {
    const whatsappApiUrl = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`; 
    // const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    axios.post(whatsappApiUrl, {
        messaging_product: "whatsapp",
        to: recipientNumber,  // The recipient's phone number
        type: "text",  // Changed to "text" for custom messages
        text: {
            body: message  // The custom message body
        }
    }, {
        headers: {
            Authorization: `Bearer EAAHikUfOVZBsBO16eugBAzpVNjw3aesZBzsRFPfh8kj0r9Gi9A92s94uDnyT7k5cDLo7atzZBwKnXmXeZCZAC4tDIWFNQzJHvpixYDC9A3oZBrKYSW36s10Q3qyOJfR87sAz246mZAWcjpK945q6YTdPiH0RaKdCrnMvnnUBKBNeCkscIMy1yhm59b6nyKwkZBTvZAsf7MDnhfckhxeLouKzTlTZBIRzPgIPWwOcYZD`,
            'Content-Type': 'application/json'
        }
    }).then((response) => {
        console.log('Message sent to WhatsApp:', response.data);
    }).catch((error) => {
        console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
    });
};

// Socket.IO setup
io.on('connection', (socket) => {
    console.log('Client connected');

    socket.on('sendMessage', async (data) => {
        const { message, to } = data;

        try {
            // Send message via WhatsApp API
            await sendWhatsAppMessage(message, to);

            // Handle storing message and updating conversation
            // (Same as in /send-whatsapp-message endpoint)
            const agentId = process.env.BUSINESS_PHONE_NUMBER.replace(/\D/g, '');
            let conversationId = null;
            const conversationsRef = db.collection('Conversations');
            const conversationSnapshot = await conversationsRef
                .where('participant_ids', 'array-contains', to)
                .where('status', '==', 'active')
                .get();

            let conversationExists = false;
            conversationSnapshot.forEach(doc => {
                const data = doc.data();
                if (data.participant_ids.includes(agentId)) {
                    conversationExists = true;
                    conversationId = doc.id;
                }
            });

            if (!conversationExists) {
                const newConversationRef = conversationsRef.doc();
                await newConversationRef.set({
                    conversation_id: newConversationRef.id,
                    participant_ids: [agentId, to],
                    status: 'active',
                    start_time: new Date(),
                    last_message: {
                        message_id: null,
                        content: message
                    }
                });
                conversationId = newConversationRef.id;
            } else {
                const conversationRef = conversationsRef.doc(conversationId);
                await conversationRef.update({
                    last_message: {
                        message_id: null,
                        content: message
                    }
                });
            }

            // Store the agent's message in Messages collection
            const messageId = db.collection('Messages').doc().id;
            await db.collection('Messages').doc(messageId).set({
                message_id: messageId,
                conversation_id: conversationId,
                sender_id: agentId,
                timestamp: new Date(),
                content: message,
                message_type: 'text',
                is_read: false
            });

            console.log('Agent message stored in Firestore');

            // Emit the message to connected clients
            io.emit('newMessage', {
                conversation_id: conversationId,
                sender_id: agentId,
                content: message,
                timestamp: new Date()
            });

        } catch (error) {
            console.error('Error sending message:', error.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
