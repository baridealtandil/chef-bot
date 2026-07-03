import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import { procesarWebhookTelegram, configurarWebhookTelegram } from './services/telegram.js';
import { inicializarBaseDeDatos, limpiarHistorialDePruebas } from './db/queries.js';

dotenv.config();

const app = new Hono();

// Ruta de healthcheck
app.get('/', (c) => c.text('Chef Bot (Bar Ideal + La Vereda) API is active.'));

// Ruta de depuración para variables de entorno
app.get('/debug', (c) => {
  return c.json({
    telegramToken: process.env.TELEGRAM_BOT_TOKEN ? 'defined' : 'undefined',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? 'defined' : 'undefined',
    geminiApiKey: process.env.GEMINI_API_KEY ? 'defined' : 'undefined',
    databaseUrl: process.env.DATABASE_URL ? 'defined' : 'undefined',
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
  });
});

// Ruta del webhook de Telegram
app.post('/webhook', async (c) => {
  try {
    const body = await c.req.json();
    // Esperar a que el procesamiento termine antes de responder, para que Railway no congele el contenedor
    await procesarWebhookTelegram(body);
    return c.json({ ok: true });
  } catch (error: any) {
    console.error('Error procesando webhook:', error);
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

// Ruta de mantenimiento: borra todo el historial de conversación y sesiones activas.
// Pensada para uso único (arrancar limpio después de pruebas). Requiere el parámetro
// de confirmación en la URL para evitar que se dispare por accidente.
app.get('/admin/limpiar-historial', async (c) => {
  const confirmacion = c.req.query('confirmar');
  if (confirmacion !== 'SI-BORRAR-TODO') {
    return c.json(
      { error: 'Falta confirmación. Agregá ?confirmar=SI-BORRAR-TODO a la URL para ejecutar esto.' },
      400
    );
  }

  const resultado = await limpiarHistorialDePruebas();
  return c.json({
    ok: true,
    message: 'Historial de conversación y sesiones borrados.',
    conversaciones_borradas: resultado.conversaciones,
    sesiones_borradas: resultado.sesiones,
  });
});

// Puerto del servidor
const port = Number(process.env.PORT) || 3000;

async function iniciar() {
  // El servidor arranca a escuchar PRIMERO, sin esperar nada — así Railway nunca lo ve colgado.
  console.log(`Iniciando servidor Hono en el puerto ${port}...`);
  serve({
    fetch: app.fetch,
    port: port,
  });

  // La inicialización de la base corre después, en paralelo. Si falla o tarda, el servidor
  // ya está arriba y respondiendo — no se cuelga por esto.
  try {
    await inicializarBaseDeDatos();
  } catch (error) {
    console.error('[DB] Error al inicializar la base de datos (el servidor sigue funcionando igual):', error);
  }
}

iniciar();
