const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// These come from Render's Environment Variables, not hardcoded here
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Step 1: Meta pings this once to confirm the webhook is real
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Step 2: Meta sends incoming messages here
app.post('/webhook', async (req, res) => {
  console.log('Incoming webhook:', JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (message) {
      const from = message.from; // sender's phone number
      const text = message.text?.body || '';

      console.log(`Message from ${from}: ${text}`);

      await sendMessage(from, `Got your message: "${text}". LifeDrop is being built — thanks for your patience!`);
    }
  } catch (err) {
    if (err.response) {
      console.error('Error handling webhook. Status:', err.response.status);
      console.error('Error details:', JSON.stringify(err.response.data));
    } else {
      console.error('Error handling webhook:', err.message);
    }
  }

  res.sendStatus(200);
});

async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: text }
  };

  console.log('Sending message with payload:', JSON.stringify(payload));
  console.log('Using PHONE_NUMBER_ID:', PHONE_NUMBER_ID);

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('Message sent successfully:', JSON.stringify(response.data));
}

app.get('/', (req, res) => res.send('LifeDrop bot is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
