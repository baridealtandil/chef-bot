import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import { procesarWebhookTelegram, configurarWebhookTelegram } from './services/telegram.js';

dotenv.config();

const app = new Hono();

// Ruta de healthcheck
app.get('/', (c) => c.text('Chef Bot (Bar Ideal + La Vereda) API is active.'));

// Ruta del webhook de Telegram
app.post('/webhook', async (c) => {
  try {
    const body = await c.req.json();
    // Procesar actualización de forma asíncrona para no bloquear el webhook de Telegram (timeout de 10s)
    procesarWebhookTelegram(body).catch((err) => {
      console.error('Error asíncrono procesando webhook:', err);
    });
    return c.json({ ok: true });
  } catch (error: any) {
    console.error('Error parseando json en webhook:', error);
    return c.json({ error: error.message || 'Invalid JSON' }, 400);
  }
});

// Ruta para registrar el webhook con Telegram de manera sencilla
app.post('/setup-webhook', async (c) => {
  const { url } = await c.req.json();
  if (!url) {
    return c.json({ error: 'Falta el campo "url" en el cuerpo de la solicitud.' }, 400);
  }

  const exito = await configurarWebhookTelegram(url);
  if (exito) {
    return c.json({ ok: true, message: `Webhook configurado con éxito a ${url}/webhook` });
  } else {
    return c.json({ error: 'No se pudo configurar el webhook con Telegram.' }, 500);
  }
});

// Puerto del servidor
const port = Number(process.env.PORT) || 3000;
console.log(`Iniciando servidor Hono en el puerto ${port}...`);

serve({
  fetch: app.fetch,
  port: port,
});
