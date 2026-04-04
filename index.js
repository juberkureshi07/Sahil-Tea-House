const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fetch = require('node-fetch');

const FIREBASE_URL = process.env.FIREBASE_URL;
const orderStates = {};

async function getMenuFromApp() {
try {
const res = await fetch("${FIREBASE_URL}/dishes.json");
const data = await res.json();
if (!data) return [];

    return Object.keys(data).map(key => ({
        id: key,
        name: data[key].name,
        price: data[key].price,
        imageUrl: data[key].imageUrl
    }));
} catch (err) {
    console.log("Menu fetch error:", err);
    return [];
}

}

async function startBot() {
if (!FIREBASE_URL) {
console.log("FIREBASE_URL missing!");
process.exit(1);
}

const { state, saveCreds } = await useMultiFileAuthState('session_data');
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
});

sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qr)}`;
        console.log("\nSCAN QR:");
        console.log(qrUrl + "\n");
    }

    if (connection === 'open') {
        console.log("BOT ONLINE ✅");
    }

    if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason !== DisconnectReason.loggedOut) {
            startBot();
        }
    }
});

sock.ev.on('creds.update', saveCreds);

sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = (msg.message.conversation || "").toLowerCase();

    // STEP 2: complete order
    if (orderStates[sender]?.step === 'WAITING') {
        const details = text;
        const item = orderStates[sender].item;
        const number = sender.split('@')[0];

        if (details.length < 10) {
            await sock.sendMessage(sender, { text: "Send valid name, phone & address" });
            return;
        }

        const order = {
            userId: "whatsapp_" + number,
            phone: number,
            address: details,
            items: [{
                id: item.id,
                name: item.name,
                price: parseFloat(item.price),
                quantity: 1
            }],
            total: (parseFloat(item.price) + 50).toFixed(2),
            status: "Placed"
        };

        await fetch(`${FIREBASE_URL}/orders.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(order)
        });

        await sock.sendMessage(sender, {
            text: `Order Confirmed ✅\n${item.name}\n₹${order.total}`
        });

        delete orderStates[sender];
        return;
    }

    // STEP 1: start order
    if (text.startsWith("order ")) {
        const query = text.replace("order ", "");
        const menu = await getMenuFromApp();

        const item = menu.find(i => i.name.toLowerCase().includes(query));

        if (!item) {
            await sock.sendMessage(sender, { text: "Item not found. Type menu" });
            return;
        }

        orderStates[sender] = { step: 'WAITING', item };

        await sock.sendMessage(sender, {
            text: `${item.name} - ₹${item.price}\nSend name, phone, address`
        });
    }

    else if (text === "menu") {
        const menu = await getMenuFromApp();

        let msgText = "MENU:\n\n";
        menu.forEach(i => {
            msgText += `${i.name} - ₹${i.price}\n`;
        });

        await sock.sendMessage(sender, { text: msgText });
    }

    else {
        await sock.sendMessage(sender, { text: "Type menu or order [item]" });
    }
});

}

startBot();
