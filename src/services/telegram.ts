import dotenv from 'dotenv';
import { procesarMensajeChef } from './claude.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const telegramApiUrl = `https://api.telegram.org/bot${token}`;

const LIMITE_TELEGRAM = 4096;
const AVISO_RECORTE = '\n\n(Respuesta recortada por límite de Telegram — pedime que siga si falta algo)';

// Teclado de botones fijo: cada botón manda su propio texto como si el chef lo hubiera escrito.
const TECLADO_PRINCIPAL = {
  keyboard: [
    [{ text: '🅛 La Vereda' }, { text: '🅘 Bar Ideal' }],
    [
      { text: 'Menú semanal: 2 carnes + 2 pastas + 2 vegetarianos' },
      { text: 'Menú semanal: plato del día + sugerencia' },
    ],
    [{ text: 'cargar nuevo plato' }, { text: 'sugerime algo' }, { text: 'modificar nuevos platos' }],
  ],
  resize_keyboard: true,
};

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

// Red de seguridad: el prompt de Claude ya está instruido para no superar
// ~3500 caracteres, así que esto solo debería activarse en casos excepcionales.
// SIEMPRE se envía un único mensaje: si no entra, se recorta con aviso.
function ajustarAlLimite(texto: string): string {
  if (texto.length <= LIMITE_TELEGRAM) return texto;

  console.warn(`[Telegram] Respuesta de ${texto.length} caracteres supera el límite, se recorta.`);

  const limiteConAviso = LIMITE_TELEGRAM - AVISO_RECORTE.length;
  let corte = texto.lastIndexOf('\n\n', limiteConAviso);
  if (corte === -1) corte = texto.lastIndexOf('\n', limiteConAviso);
  if (corte === -1) corte = limiteConAviso;

  return texto.slice(0, corte).trim() + AVISO_RECORTE;
}

export async function enviarMensajeTelegram(chatId: number, texto: string): Promise<boolean> {
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN no configurado.');
    return false;
  }

  const textoFinal = ajustarAlLimite(texto);

  try {
    const res = await fetch(`${telegramApiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: textoFinal,
        parse_mode: 'Markdown',
        reply_markup: TECLADO_PRINCIPAL,
      }),
    });

    if (!res.ok) {
      const errorJson = await res.json();
      console.error('Error al enviar mensaje a Telegram con Markdown, reintentando sin formato:', errorJson);

      const resPlano = await fetch(`${telegramApiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: textoFinal,
          reply_markup: TECLADO_PRINCIPAL,
        }),
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

  await enviarChatAction(chatId);
  const typingInterval = setInterval(() => enviarChatAction(chatId), 4000);

  try {
    const respuestaIa = await procesarMensajeChef(chatId, textoUsuario);
    clearInterval(typingInterval);

    const enviado = await enviarMensajeTelegram(chatId, respuestaIa);
    if (!enviado) {
      console.error('[Telegram] El envío de la respuesta falló, se avisa al chef.');
      await enviarMensajeTelegram(
        chatId,
        'Procesé tu consulta pero no pude entregarte la respuesta. Probá de nuevo; si se repite, avisale a Gabriel.'
      );
    }
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
