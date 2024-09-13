const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const http = require('http');
const socketIO = require('socket.io');
const admin = require('firebase-admin');
require('dotenv').config();

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
    databaseURL: "https://your-firebase-project-id.firebaseio.com"
});

const db = admin.firestore();
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const cors = require('cors');

// Enable CORS for all routes
app.use(cors());

app.use(bodyParser.json());

// Handle incoming WhatsApp webhook (simulate)
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "whatsapp_verify_token_2024"; // Your verification token
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Log incoming query parameters for debugging
    console.log('Received GET request on /webhook');
    console.log('Mode:', mode);
    console.log('Token:', token);
    console.log('Challenge:', challenge);

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge); // Respond with the challenge token
        } else {
            console.log('Failed Verification. Invalid Token');
            res.sendStatus(403); // Token didn't match, respond with 403 Forbidden
        }
    } else {
        console.log('Missing mode or token in the request');
        res.sendStatus(400); // Missing necessary parameters, respond with 400 Bad Request
    }
});

app.post('/webhook', async (req, res) => {
    console.log("Incoming request body:", JSON.stringify(req.body, null, 2));  // Log the incoming request body for debugging

    try {
        // Ensure the incoming request is in the expected format
        if (req.body && req.body.entry && req.body.entry[0].changes && req.body.entry[0].changes[0].value.messages && req.body.entry[0].changes[0].value.messages[0]) {

            // Extract the necessary data from the incoming request
            const messageData = req.body.entry[0].changes[0].value;
            const from = messageData.messages[0].from;  // Sender's phone number
            const message = messageData.messages[0].text.body;  // Message text
            const timestamp = messageData.messages[0].timestamp;  // Unix timestamp
            const username = messageData.contacts[0].profile.name;  // User's name
            const to = messageData.metadata.display_phone_number;  // Business phone number

            // Generate a unique message ID or use the one provided in the request
            const messageId = messageData.messages[0].id || db.collection('messages').doc(from).collection('chat').doc().id;
            
            // Log the incoming message
            console.log(`Received message from ${from}: ${message}`);

            // Store the sender's phone number and name in Firestore (if not already present)
            const userRef = db.collection('messages').doc(from);
            await userRef.set({
                username: username,
                phone_number: from,
            }, { merge: true });  // Merge to avoid overwriting existing fields

            // Define the reference to the 'chat' sub-collection under the user's phone number
            const chatRef = userRef.collection('chat').doc(messageId);
            
            // Store the message in Firestore
            await chatRef.set({
                from: from,  // Who sent the message
                to: to,  // Who the message was sent to (your business)
                message: message,
                timestamp: new Date(parseInt(timestamp) * 1000)  // Convert Unix timestamp to JS Date
            });

            console.log("Message successfully stored in Firestore");

            // Respond with a success status to acknowledge receipt of the message
            res.sendStatus(200);
        } else {
            // Log and return an error if the request is not in the expected format
            console.error('Invalid request format:', JSON.stringify(req.body, null, 2));
            res.status(400).send('Invalid request format');
        }
    } catch (error) {
        // Handle and log any errors that occur during message processing
        console.error('Error processing request:', error.message);
        res.status(500).send('Internal server error');
    }
});

// Fetch all messages stored in Firestore
app.get('/messages', async (req, res) => {
    try {
        const messagesSnapshot = await db.collection('messages').get();
        const messages = [];
        
        messagesSnapshot.forEach(doc => {
            messages.push(doc.data());
        });

        res.status(200).json(messages);
    } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).send("Error fetching messages");
    }
});

// Webhook endpoint for WhatsApp messages
const messages = []; // Temporary storage, consider using a database

app.post('/webhook', async (req, res) => {
    console.log("Incoming request body:", JSON.stringify(req.body, null, 2));  // Log the entire incoming request body for debugging

    try {
        // Check if the message structure is correct
        if (req.body && req.body.entry && req.body.entry[0].changes && req.body.entry[0].changes[0].value.messages && req.body.entry[0].changes[0].value.messages[0]) {
            // Extract relevant data
            const from = req.body.entry[0].changes[0].value.messages[0].from;  // Sender's phone number (WhatsApp ID)
            const message = req.body.entry[0].changes[0].value.messages[0].text.body;  // Message content
            const timestamp = req.body.entry[0].changes[0].value.messages[0].timestamp;

            // Log extracted data to confirm it's parsed correctly
            console.log(`Message from: ${from}, Content: ${message}, Timestamp: ${timestamp}`);

            // Generate a unique message ID (this can be done using a UUID or Firestore's auto-generated ID)
            const messageId = req.body.entry[0].changes[0].value.messages[0].id || db.collection('messages').doc(from).collection('chat').doc().id;

            // Store the incoming message in Firestore (under the user's phone number as a document)
            const chatRef = db.collection('messages').doc(from).collection('chat').doc(messageId);
            await chatRef.set({
                from: from,
                message: message,
                timestamp: new Date(parseInt(timestamp) * 1000) // Convert from Unix timestamp
            });

            console.log("Incoming message successfully stored in Firestore");

            // Respond with a 200 status to acknowledge receipt of the message
            res.sendStatus(200);
        } else {
            console.error('Invalid request format:', JSON.stringify(req.body, null, 2));  // Log if the format is invalid
            res.status(400).send('Invalid request format');
        }
    } catch (error) {
        console.error('Error processing request:', error.message);  // Log the exact error message
        res.status(500).send('Internal server error');
    }
});

io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

app.post('/send-whatsapp-message', async (req, res) => {
    const { message, recipientNumber } = req.body;

    try {
        await sendWhatsAppMessage(message, recipientNumber); // Call your sendWhatsAppMessage function
        res.status(200).json({ message: 'Message sent successfully' });
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error sending message' });
    }
});

const sendWhatsAppMessage = (message, recipientNumber) => {
    const whatsappApiUrl = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`; 
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    axios.post(whatsappApiUrl, {
        messaging_product: "whatsapp",
        to: recipientNumber,  // The recipient's phone number
        type: "text",  // Changed to "text" for custom messages
        text: {
            body: message  // The custom message body
        }
    }, {
        headers: {
            Authorization: `Bearer EAAHikUfOVZBsBOxDJPX6KsmhDvRPKH0JxexXiKeV9JXe2hTojjBzF4K1JZAUELzdfczqaGuBolgXHJM3V2lODFdxXT65v0h2mD471CrqJwRlNsULGMlpejO9ntJ1SPXYtFYUunHSGLxL749IpcQZBBJSoE0AnZAlI7RssxnsfWnvHfFoeV83D03daa6O11ZAOedVFxIQMmq05ewN98xmVJrMcLKyHnZBcGOnoZD`,
            'Content-Type': 'application/json'
        }
    }).then((response) => {
        console.log('Message sent to WhatsApp:', response.data);
    }).catch((error) => {
        console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
    });
};

// const sendWhatsAppMessage = (message, recipientNumber) => {
//     const whatsappApiUrl = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`; 
//     const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

//     axios.post(whatsappApiUrl, {
//         messaging_product: "whatsapp",
//         to: recipientNumber, // The customer's phone number
//         type: "text",
//         text: { body: message }, // The message to be sent
//     }, {
//         headers: {
//             Authorization: `Bearer ${accessToken}`, // WhatsApp access token
//             'Content-Type': 'application/json'
//         }
//     }).then((response) => {
//         console.log('Message sent to WhatsApp:', response.data);
//     }).catch((error) => {
//         console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
//     });
// };

// Handle agent message, send to WhatsApp and Firestore
io.on('connection', (socket) => {
    console.log('Agent connected');

    socket.on('sendMessage', (data) => {
        const { message, to } = data;

        // Send message to WhatsApp via WhatsApp API
        sendWhatsAppMessage(message, to);

        // Store agent's message in Firestore
        db.collection('messages').add({
            from: 'agent',
            to,
            message,
            timestamp: new Date()
        }).then(() => {
            console.log('Message stored in Firestore');
        }).catch(err => {
            console.log('Error storing message:', err);
        });
    });

    socket.on('disconnect', () => {
        console.log('Agent disconnected');
    });
});

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});