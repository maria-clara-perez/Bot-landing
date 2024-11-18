import * as baileys from '@whiskeysockets/baileys';
import fetch from 'node-fetch';
import { getLinkPreview } from 'link-preview-js';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import sharp from 'sharp'; // Importar sharp

// Configuración de rutas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authPath = path.join(__dirname, './auth');

// Configuración inicial del bot
let isAntiLinkActive = true;
let isLinkSharingActive = false;
let groupsToShareLinks = new Set(); // Usamos un Set para evitar duplicados
let allGroups = new Set(); // Lista de grupos donde el bot está activo

// Enlaces a compartir
const linksToShare = ['https://whattssapy.shop/', 'https://whatsapp.chatinvite.shop/'];
let currentLinkIndex = 0; // Índice para alternar entre las URLs
const shareInterval = 60 * 10000; // 30 segundos

// Función personalizada para obtener la vista previa del enlace, incluyendo redirecciones
async function getLinkPreviewWithRedirect(url) {
    try {
        const response = await fetch(url, {
            redirect: 'follow', // Permitir redirecciones
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const html = await response.text();
        const title = html.match(/<title>(.*?)<\/title>/)?.[1] || '';
        const description = html.match(/<meta name="description" content="(.*?)"/)?.[1] || '';

        console.log('Vista previa obtenida:', { title, description });
        return { title, description, images: [] }; // Sin imágenes por ahora
    } catch (error) {
        console.error('Error al obtener la vista previa del enlace:', error);
        return null;
    }
}

// Función para generar la miniatura de la imagen usando sharp
async function generateThumbnail(imageUrl) {
    try {
        const imageBuffer = await fetch(imageUrl).then(res => res.buffer()); // Descargar la imagen
        const thumbnailBuffer = await sharp(imageBuffer)
            .resize(100) // Ajustamos el tamaño de la miniatura (100px de ancho)
            .toBuffer();
        return thumbnailBuffer;
    } catch (error) {
        console.error('Error al generar la miniatura:', error);
        return null; // En caso de error, devolvemos null
    }
}

// Función principal para iniciar el bot
const startBot = async () => {
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authPath);

    const socket = baileys.makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ["Bot", "Chrome", "10.0"],
    });

    // Maneja actualizaciones de conexión
    socket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        console.log('Estado de conexión:', update);

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== baileys.DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Conexión establecida correctamente con WhatsApp');

            // Iniciar el envío periódico del enlace
            startLinkSharing(socket);
        }
    });

    // Maneja eventos de credenciales
    socket.ev.on('creds.update', saveCreds);

    // Escucha mensajes
    socket.ev.on('messages.upsert', async (messageUpdate) => {
        for (const msg of messageUpdate.messages) {
            if (!msg.message) continue;
            const chatId = msg.key.remoteJid;
            const senderId = msg.key.participant || msg.key.remoteJid;
            const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

            // Mostrar solo comandos en consola
            if (userMessage && userMessage.startsWith('!')) {
                console.log('Comando recibido:', userMessage);
            }

            // Procesamos solo comandos
            if (userMessage && userMessage.startsWith('!antilink')) {
                await handleAntilinkCommand(socket, chatId, userMessage, senderId);
            } else if (userMessage && userMessage.startsWith('!linksharing')) {
                await handleLinkSharingCommand(socket, chatId, userMessage, senderId);
            } else if (userMessage && !userMessage.startsWith(linksToShare[0])) {
                await handleLinkDetection(socket, chatId, msg, userMessage, senderId);
            }
        }
    });
};

// Comando para activar o desactivar el antilink
async function handleAntilinkCommand(sock, chatId, userMessage, senderId) {
    if (userMessage === '!antilink on') {
        isAntiLinkActive = true;
        await sock.sendMessage(chatId, { text: 'correcto' });
        // Activar en todos los grupos
        allGroups.forEach(group => sock.sendMessage(group, { text: '¡Antilink activado!' }));
    } else if (userMessage === '!antilink 0') {
        isAntiLinkActive = false;
        await sock.sendMessage(chatId, { text: 'desactivada' });
        // Desactivar en todos los grupos
        allGroups.forEach(group => sock.sendMessage(group, { text: '¡Antilink desactivado!' }));
    }
}

// Comando para activar o desactivar el envío de enlaces
async function handleLinkSharingCommand(sock, chatId, userMessage, senderId) {
    if (userMessage === '!linksharing on') {
        isLinkSharingActive = true;
        groupsToShareLinks.add(chatId); // Añadir grupo a la lista de grupos para compartir enlaces
        allGroups.add(chatId); // Añadir el grupo a la lista global de grupos activos
        await sock.sendMessage(chatId, { text: 'correcto' });
        console.log(`Compartición de enlaces activada en el grupo: ${chatId}`);
    } else if (userMessage === '!linksharing 0') {
        isLinkSharingActive = false;
        groupsToShareLinks.delete(chatId); // Eliminar de la lista de grupos para compartir enlaces
        allGroups.delete(chatId); // Eliminar de la lista global de grupos activos
        await sock.sendMessage(chatId, { text: 'desactivada.' });
        console.log(`Compartición de enlaces desactivada en el grupo: ${chatId}`);
    }
}

// Detectar y eliminar enlaces en los mensajes
async function handleLinkDetection(sock, chatId, message, userMessage, senderId) {
    if (!isAntiLinkActive) return; // Si el antilink está desactivado, no hace nada

    const linkRegex = /https?:\/\/(?!chat\.whatsapp\.com)[^\s]+/;
    if (linkRegex.test(userMessage)) {
        const quotedMessageId = message.key.id;
        const quotedParticipant = message.key.participant || senderId;

        try {
            // Eliminar el mensaje con el enlace
            await sock.sendMessage(chatId, {
                delete: { remoteJid: chatId, fromMe: false, id: quotedMessageId, participant: quotedParticipant },
            });
            console.log(`Mensaje con enlace eliminado en el chat: ${chatId}`);
        } catch (error) {
            console.error('No se pudo eliminar el mensaje:', error);
        }
    }
}

// Iniciar el envío periódico de enlaces con vista previa
async function startLinkSharing(sock) {
    setInterval(async () => {
        // Verifica si la compartición de enlaces está activa y si hay grupos a los que enviar el enlace
        if (isLinkSharingActive && groupsToShareLinks.size > 0) {
            console.log('Enviando enlaces a los grupos:', Array.from(groupsToShareLinks)); // Verifica los grupos
            for (const chatId of groupsToShareLinks) {
                try {
                    // Obtener el enlace actual
                    const linkToSend = linksToShare[currentLinkIndex];
                    // Intentamos obtener la vista previa del enlace, con un timeout de 5 segundos
                    const preview = await Promise.race([ 
                        getLinkPreviewWithRedirect(linkToSend),  // Obtenemos la vista previa con redirección
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                    ]);

                    // Enviar la vista previa al grupo
                    await sock.sendMessage(chatId, {
                        text: `${preview.title}\n\n${preview.description}\n${linkToSend}`,
                    });

                    currentLinkIndex = (currentLinkIndex + 1) % linksToShare.length; // Cambiar al siguiente enlace
                } catch (error) {
                    console.error('Error al enviar el enlace o obtener la vista previa:', error);
                }
            }
        }
    }, shareInterval);
};

startBot();
