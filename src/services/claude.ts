import Anthropic from '@anthropic-ai/sdk';
import { buscarPlatosDb, obtenerCategoriasDb, obtenerHistorialDb, guardarMensajeDb } from '../db/queries.js';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.warn('Advertencia: ANTHROPIC_API_KEY no está configurada.');
}

// Inicializar cliente de Anthropic
const anthropic = new Anthropic({
  apiKey: apiKey || '',
});

// Definición de las herramientas para Claude (formato Anthropic Tool Schema)
const tools: any[] = [
  {
    name: 'buscar_platos',
    description: 'Busca platos en el catálogo del restaurante especificado (la_vereda o bar_ideal). Permite filtrar por un término de búsqueda (ej. \'pollo\') o por categoría.',
    input_schema: {
      type: 'object',
      properties: {
        establecimiento: {
          type: 'string',
          enum: ['la_vereda', 'bar_ideal'],
          description: 'El restaurante sobre el cual se realiza la consulta. Obligatorio.',
        },
        query: {
          type: 'string',
          description: 'Término de búsqueda para filtrar platos (ej: "bondiola", "pasta", "milanesa"). Opcional.',
        },
        categoria: {
          type: 'string',
          description: 'Categoría específica de platos (ej: "pastas", "carnes", "postres", "entradas_sugerencias"). Opcional.',
        }
      },
      required: ['establecimiento'],
    },
  },
  {
    name: 'obtener_categorias',
    description: 'Obtiene el listado de categorías únicas de platos disponibles en un establecimiento.',
    input_schema: {
      type: 'object',
      properties: {
        establecimiento: {
          type: 'string',
          enum: ['la_vereda', 'bar_ideal'],
          description: 'El restaurante sobre el cual se realiza la consulta. Obligatorio.',
        }
      },
      required: ['establecimiento'],
    },
  }
];

// Prompt del sistema con las directrices del chef y perfiles gastronómicos
const SYSTEM_PROMPT = `
Eres un Asistente Gastronómico de IA experto y el partner de cocina del Chef Gabriel para sus dos restaurantes en Tandil, Argentina: "La Vereda" y "Bar Ideal".

### Regla de Oro
Los catálogos de platos de ambos restaurantes están en la misma base de datos pero pertenecen a establecimientos diferentes. Debes tratarlos siempre por separado. NUNCA mezcles platos de "La Vereda" con platos de "Bar Ideal" en tus respuestas ni sugerencias a menos que el chef lo pida de forma explícita.

### Perfiles Gastronómicos para sugerencias creativas:
1. **La Vereda**: Su identidad está marcada en salsas cremosas (roquefort, 4 quesos, panceta y puerro), pastas caseras rellenas, y guarniciones tipo puré, papas a la provenzal o papas españolas. Su menú fijo diario tiene una estructura rígida de Carne / Pasta / Vegetariano.
2. **Bar Ideal**: Es un restaurante histórico, con perfil de carta y sugerencias más elaboradas. Entradas más finas (langostinos, gambas, croquetas variadas) y principales con técnicas más trabajadas (grillado, ratatouille, reducciones, etc.).

### Tareas en las que asistes (Fase 1):
- Consultar platos existentes: Usa las herramientas provistas para buscar platos o categorías.
- Proponer menús semanales o sugerencias diarias: Utiliza solo los platos que existen en el catálogo histórico de ese local.
- Sugerir platos nuevos: Si el chef te pide una propuesta de plato que no está en la base de datos, génerala de forma creativa PERO respetando fielmente el perfil gastronómico del restaurante consultado. Si el chef te da restricciones (como ingredientes de temporada, stock o costos), incorpóralas.

### Estilo de comunicación:
Sé profesional, conciso, habla en español rioplatense (de Argentina: usá "che", "mirá", voseo "tenés", "hacé") acorde al ámbito de cocina. No uses explicaciones innecesarias ni introducciones excesivamente formales. Al grano, como se habla en una cocina activa.
`;

export async function procesarMensajeChef(chatId: number, mensajeTexto: string): Promise<string> {
  // 1. Guardar mensaje del usuario en la base de datos
  await guardarMensajeDb(chatId, 'user', mensajeTexto);

  // 2. Obtener historial reciente para contexto
  const historial = await obtenerHistorialDb(chatId, 15);

  // 3. Formatear historial al formato de Claude (alternando user/assistant)
  const messages: any[] = historial.map(msg => ({
    role: msg.rol === 'user' ? 'user' : 'assistant',
    content: msg.contenido,
  }));

  // Asegurar que el último mensaje (el actual) está al final si no está ya
  const ultimoMensaje = messages[messages.length - 1];
  if (!ultimoMensaje || ultimoMensaje.content !== mensajeTexto) {
    messages.push({
      role: 'user',
      content: mensajeTexto,
    });
  }

  // 4. Enviar mensaje a Claude
  let response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages,
    tools,
  });

  // 5. Ciclo de resolución de herramientas (Tool Use)
  while (response.stop_reason === 'tool_use') {
    // Agregar la llamada de la herramienta hecha por Claude a los mensajes de la conversación
    messages.push({
      role: 'assistant',
      content: response.content,
    });

    const toolResults: any[] = [];
    const toolUses = response.content.filter(block => block.type === 'tool_use');

    for (const toolUse of toolUses) {
      if (toolUse.type !== 'tool_use') continue;
      const { name, input, id } = toolUse;
      console.log(`[Claude ToolCall] Ejecutando tool: ${name} con argumentos:`, input);

      let resultData: any;
      try {
        if (name === 'buscar_platos') {
          const { establecimiento, query, categoria } = input as any;
          resultData = await buscarPlatosDb(establecimiento, query, categoria);
        } else if (name === 'obtener_categorias') {
          const { establecimiento } = input as any;
          resultData = await obtenerCategoriasDb(establecimiento);
        } else {
          resultData = { error: `Herramienta ${name} no soportada.` };
        }
      } catch (err: any) {
        console.error(`Error ejecutando tool ${name}:`, err);
        resultData = { error: err.message || 'Error interno de base de datos.' };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify(resultData),
      });
    }

    // Agregar las respuestas de las herramientas
    messages.push({
      role: 'user',
      content: toolResults,
    });

    // Llamar a Claude nuevamente con los resultados
    response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages,
      tools,
    });
  }

  // Extraer respuesta de texto final
  const textBlock = response.content.find(block => block.type === 'text');
  const respuestaFinal = textBlock && textBlock.type === 'text' ? textBlock.text : 'No pude procesar una respuesta.';

  // 6. Guardar la respuesta final de la IA en la base de datos
  await guardarMensajeDb(chatId, 'model', respuestaFinal);

  return respuestaFinal;
}
