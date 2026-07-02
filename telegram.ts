import dotenv from 'dotenv';
import { procesarMensajeChef } from './claude.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const telegramApiUrl = `https://api.telegram.org/bot${token}`;

async function enviarChatAction(chatId: number): Promise<void> {
  try {
    await fetch(`${telegramApiUrl}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch (e) {
    console.error('Error enviando typing action:', e);
  }
}

export async function enviarMensajeTelegram(chatId: number, texto: string): Promise<boolean> {
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN no configurado.');
    return false;
  }

  try {
    const res = await fetch(`${telegramApiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      const errorJson = await res.json();
      console.error('Error al enviar mensaje a Telegram con Markdown, reintentando sin formato:', errorJson);

      // Fallback: reintentar como texto plano por si el Markdown de la respuesta
      // rompe el parser de Telegram (ej. asteriscos o guiones bajos sueltos).
      const resPlano = await fetch(`${telegramApiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: texto }),
      });

      if (!resPlano.ok) {
        const errorPlano = await resPlano.json();
        console.error('Error al enviar mensaje a Telegram incluso en texto plano:', errorPlano);
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('Excepción al enviar mensaje a Telegram:', error);
    return false;
  }
}

export async function procesarWebhookTelegram(update: any): Promise<void> {
  console.log('[Telegram Webhook] Update recibido:', JSON.stringify(update));

  const message = update.message;
  if (!message || !message.text || !message.chat || !message.chat.id) {
    console.log('[Telegram Webhook] No contiene un mensaje de texto válido.');
    return;
  }

  const chatId = message.chat.id;
  const textoUsuario = message.text;

  // Mantener el indicador "escribiendo..." activo durante todo el procesamiento.
  // Telegram lo apaga solo a los ~5 segundos, así que lo reenviamos cada 4s
  // mientras dure la consulta (incluidas las vueltas de tool calling).
  await enviarChatAction(chatId);
  const typingInterval = setInterval(() => enviarChatAction(chatId), 4000);

  try {
    const respuestaIa = await procesarMensajeChef(chatId, textoUsuario);
    clearInterval(typingInterval);
    await enviarMensajeTelegram(chatId, respuestaIa);
  } catch (error: any) {
    clearInterval(typingInterval);
    console.error('Error al procesar el mensaje en el webhook:', error);
    await enviarMensajeTelegram(
      chatId,
      'Tuve un problema procesando tu consulta. Probá de nuevo en un momento; si sigue fallando, avisale a Gabriel.'
    );
  }
}

export async function configurarWebhookTelegram(url: string): Promise<boolean> {
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN no configurado.');
    return false;
  }

  try {
    const webhookUrl = `${url}/webhook`;
    console.log(`Configurando webhook de Telegram a: ${webhookUrl}`);

    const res = await fetch(`${telegramApiUrl}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });

    const resJson: any = await res.json();
    console.log('[Telegram API] setWebhook response:', resJson);
    return resJson.ok;
  } catch (error) {
    console.error('Error configurando webhook:', error);
    return false;
  }
}
