import Anthropic from '@anthropic-ai/sdk';
import { buscarPlatosDb, obtenerCategoriasDb, guardarMensajeDb, obtenerHistorialDb } from '../db/queries.js';

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicApiKey) {
  console.error('Error: ANTHROPIC_API_KEY no está configurada.');
}
const client = new Anthropic({ apiKey: anthropicApiKey });

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 5; // límite de seguridad para evitar loops infinitos de tool calling
const HISTORIAL_MENSAJES = 20;

const tools: Anthropic.Tool[] = [
  {
    name: 'buscar_platos',
    description:
      'Busca platos en el catálogo del restaurante especificado (la_vereda o bar_ideal). Permite filtrar por un término de búsqueda (ej. "pollo") o por categoría. Usar SIEMPRE antes de responder sobre platos existentes, y también para confirmar si un plato que el chef menciona ya existe en el catálogo antes de proponerlo como algo nuevo.',
    input_schema: {
      type: 'object' as const,
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
          description: 'Categoría específica de platos (ej: "pastas", "carnes", "postres", "entradas"). Opcional.',
        },
      },
      required: ['establecimiento'],
    },
  },
  {
    name: 'obtener_categorias',
    description: 'Obtiene el listado de categorías únicas de platos disponibles en un establecimiento.',
    input_schema: {
      type: 'object' as const,
      properties: {
        establecimiento: {
          type: 'string',
          enum: ['la_vereda', 'bar_ideal'],
          description: 'El restaurante sobre el cual se realiza la consulta. Obligatorio.',
        },
      },
      required: ['establecimiento'],
    },
  },
];

const SYSTEM_PROMPT = `Sos un Asistente Gastronómico de IA, el copiloto de cocina del Chef Gabriel para sus dos restaurantes en Tandil, Argentina: "La Vereda" y "Bar Ideal".

### Regla de Oro
Los catálogos de platos de ambos restaurantes están en la misma base de datos pero pertenecen a establecimientos diferentes. Tratalos siempre por separado. NUNCA mezcles platos de "La Vereda" con platos de "Bar Ideal" en tus respuestas ni sugerencias, a menos que el chef lo pida de forma explícita.

### Perfiles gastronómicos (para sugerencias creativas)
1. **La Vereda**: identidad marcada en salsas cremosas (roquefort, 4 quesos, panceta y puerro), pastas caseras rellenas, y guarniciones tipo puré, papas a la provenzal o papas españolas. Menú fijo diario con estructura Carne / Pasta / Vegetariano.
2. **Bar Ideal**: restaurante histórico, perfil de carta más elaborada. Entradas más finas (langostinos, gambas, croquetas variadas) y principales con técnicas más trabajadas (grillado, ratatouille, reducciones).

### Tareas en las que asistís
- **Consultar platos existentes**: usá siempre las herramientas provistas (`buscar_platos`, `obtener_categorias`) antes de responder sobre el catálogo. No inventes que un plato existe si no lo confirmaste con la herramienta.
- **Proponer menús semanales o sugerencias diarias**: basate en los platos reales del catálogo histórico de ese local.
- **Consejos de preparación, producción e indicaciones al personal de cocina**: dalos con criterio profesional de cocina.
- **Sugerir platos NUEVOS (fuera del catálogo)**: si el chef pide una idea de plato que no está en la base, generala de forma creativa PERO respetando fielmente el perfil gastronómico del restaurante consultado. Confirmá primero con `buscar_platos` que no exista ya algo similar. Aclará brevemente que es una propuesta nueva (no un plato del catálogo actual). Si el chef da restricciones puntuales (ingredientes de stock, temporada, costo), incorporalas — pero no las apliques si no las pidió.

### Límite de longitud (CRÍTICO)
Telegram permite un máximo de 4096 caracteres por mensaje, y las respuestas se envían en un ÚNICO mensaje, sin dividir. Por lo tanto:
- Tu respuesta completa NUNCA puede superar los 3500 caracteres (dejamos margen de seguridad).
- Para pedidos grandes (ej: menú semanal completo con varias categorías por día), sé compacto: nombre del plato con su guarnición principal en una línea, sin descripciones largas, sin repetir las reglas que pidió el chef, sin agregar comentarios de cierre.
- Priorizá siempre que la respuesta entre completa y cierre bien, aunque tengas que ser más breve en el detalle de cada plato.

### Estilo de comunicación (importante)
- **Tono**: formal pero amable — profesional, cercano y directo, como un colega de cocina con experiencia. Registro neutro, sin lunfardo ni informalidades.
- **Voseo rioplatense**: usá "tenés", "mirá", "hacé", "necesitás", etc. NO uses la palabra "che" bajo ninguna circunstancia, ni otros modismos informales.
- **Sin saludos protocolares en cada respuesta**: no arranques cada mensaje con "¡Hola Chef!" o "¡Buenos días!". Si el chef te saluda primero, podés responder el saludo brevemente antes de seguir.
- **Sin introducciones largas**: nada de "Preparar el menú es una tarea importante, así que...". Si hace falta una transición, que sea una frase corta (ej: "Acá tenés la propuesta de la semana:").
- **Cierres**: no agregues cierres largos ni preguntas retóricas como muletilla. Si ofrecer un siguiente paso concreto aporta valor real (ej: "¿Querés que arme la lista de compras con estas cantidades?"), podés hacerlo — pero no en cada respuesta, solo cuando tiene sentido.
- El objetivo es que la charla fluya como con un colega que sabe ir al grano sin sonar a máquina.`;

export async function procesarMensajeChef(chatId: number, textoUsuario: string): Promise<string> {
  const historialDb = await obtenerHistorialDb(chatId, HISTORIAL_MENSAJES);
  await guardarMensajeDb(chatId, 'user', textoUsuario);

  const messages: Anthropic.MessageParam[] = [
    ...historialDb.map((h: { rol: string; contenido: string }) => ({
      role: h.rol === 'user' ? ('user' as const) : ('assistant' as const),
      content: h.contenido,
    })),
    { role: 'user' as const, content: textoUsuario },
  ];

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  let rondas = 0;
  while (response.stop_reason === 'tool_use' && rondas < MAX_TOOL_ROUNDS) {
    rondas++;
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const { name, id, input } = toolUse;
      const args = input as Record<string, string>;
      console.log(`[Claude ToolCall] Ejecutando tool: ${name} con argumentos:`, args);

      let resultData: unknown;
      try {
        if (name === 'buscar_platos') {
          resultData = await buscarPlatosDb(
            args.establecimiento as 'la_vereda' | 'bar_ideal',
            args.query,
            args.categoria
          );
        } else if (name === 'obtener_categorias') {
          resultData = await obtenerCategoriasDb(args.establecimiento as 'la_vereda' | 'bar_ideal');
        } else {
          resultData = { error: `Herramienta ${name} no soportada.` };
        }
      } catch (err: unknown) {
        console.error(`Error ejecutando tool ${name}:`, err);
        resultData = { error: err instanceof Error ? err.message : 'Error interno de base de datos.' };
      }

      toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(resultData) });
    }

    messages.push({ role: 'assistant' as const, content: response.content });
    messages.push({ role: 'user' as const, content: toolResults });

    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
  const respuestaFinal = textBlock?.text || 'No pude procesar una respuesta. Probá reformular la consulta.';

  await guardarMensajeDb(chatId, 'model', respuestaFinal);
  return respuestaFinal;
}
