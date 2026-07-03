import Anthropic from '@anthropic-ai/sdk';
import { buscarPlatosDb, obtenerCategoriasDb, guardarMensajeDb, obtenerHistorialDb, agregarPlatoDb, obtenerUltimosPlatosDb, editarPlatoDb, eliminarPlatoDb, obtenerSesionDb, actualizarSesionDb } from '../db/queries.js';

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicApiKey) {
  console.error('Error: ANTHROPIC_API_KEY no está configurada.');
}
const client = new Anthropic({ apiKey: anthropicApiKey });

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 20; // límite de seguridad para evitar loops infinitos de tool calling
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
  {
    name: 'agregar_plato',
    description:
      'Guarda un plato NUEVO de forma permanente en el catálogo del establecimiento. Usar SOLO cuando el chef pide explícitamente agregar, cargar, sumar o guardar un plato al catálogo (ej: "agregá este plato a La Vereda", "cargá esta receta nueva al Ideal"). NUNCA usar esta herramienta cuando el chef solo pide una idea o sugerencia de plato nuevo sin pedir que se guarde.',
    input_schema: {
      type: 'object' as const,
      properties: {
        establecimiento: {
          type: 'string',
          enum: ['la_vereda', 'bar_ideal'],
          description: 'El restaurante al que pertenece el plato nuevo. Obligatorio.',
        },
        nombre: {
          type: 'string',
          description: 'Nombre completo del plato, incluyendo guarnición si corresponde (ej: "Bondiola a la mostaza con puré de batatas"). Obligatorio.',
        },
        categoria: {
          type: 'string',
          description: 'Categoría del plato (ej: "carnes", "pastas", "vegetarianos", "postres", "entradas"). Obligatorio.',
        },
        descripcion: {
          type: 'string',
          description: 'Descripción u observaciones adicionales del plato. Opcional.',
        },
      },
      required: ['establecimiento', 'nombre', 'categoria'],
    },
  },
  {
    name: 'listar_ultimos_platos',
    description:
      'Lista los platos agregados más recientemente al catálogo, del más nuevo al más viejo. Usar cuando el chef pide ver las últimas cargas, o para encontrar el id exacto de un plato antes de editarlo o eliminarlo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        establecimiento: {
          type: 'string',
          enum: ['la_vereda', 'bar_ideal'],
          description: 'Filtrar por local. Opcional: si no se especifica, muestra de ambos.',
        },
        limite: {
          type: 'number',
          description: 'Cantidad de platos a mostrar. Opcional, por defecto 10.',
        },
      },
      required: [],
    },
  },
  {
    name: 'editar_plato',
    description:
      'Edita un plato existente del catálogo por su id exacto. Usar SIEMPRE después de confirmar el id con buscar_platos o listar_ultimos_platos primero — nunca adivinar el id. Solo hace falta pasar los campos que cambian.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'ID exacto del plato a editar, obtenido previamente con buscar_platos o listar_ultimos_platos.',
        },
        nombre: { type: 'string', description: 'Nuevo nombre del plato. Opcional, solo si cambia.' },
        categoria: { type: 'string', description: 'Nueva categoría. Opcional, solo si cambia.' },
        descripcion: { type: 'string', description: 'Nueva descripción. Opcional, solo si cambia.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'eliminar_plato',
    description:
      'Elimina un plato del catálogo de forma PERMANENTE por su id exacto. Usar SOLO cuando el chef lo pide explícitamente, y después de confirmar el id con buscar_platos o listar_ultimos_platos. Si hay ambigüedad sobre cuál plato eliminar, mostrar las opciones y pedir confirmación antes de ejecutar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ID exacto del plato a eliminar.' },
      },
      required: ['id'],
    },
  },
];

const SYSTEM_PROMPT = `Sos un Asistente Gastronómico de IA, el copiloto de cocina del Chef Nahuel para los dos restaurantes de Tandil, Argentina que gestiona Gabriel: "La Vereda" y "Bar Ideal".

### Sobre el establecimiento activo (leer con atención)
Si más arriba en este prompt aparece la sección "Contexto actual de esta conversación" con un establecimiento activo, es un dato confirmado por código (no una suposición tuya) — usalo con confianza, no hace falta volver a preguntar. Si NO aparece esa sección, significa que todavía no hay negocio confirmado para este chat: si el pedido del chef depende de saber a qué local corresponde (agregar un plato, sugerir una idea, armar un menú), preguntá primero a qué establecimiento se refiere antes de avanzar.

### Confirmación breve al recibir solo el nombre del negocio
Si el mensaje del chef es solo "La Vereda" o "Bar Ideal" (por ejemplo porque tocó ese botón), sin ningún pedido adicional en el mismo mensaje, respondé con una confirmación corta y natural (ej: "Dale, quedamos en La Vereda. ¿Qué necesitás?") y quedate esperando el próximo pedido. No pidas que "aclare concretamente" qué quiere ni suenes confundido — el chef todavía no pidió nada, solo estableció el contexto.

### Regla de Oro
Los catálogos de platos de ambos restaurantes están en la misma base de datos pero pertenecen a establecimientos diferentes. Tratalos siempre por separado. NUNCA mezcles platos de "La Vereda" con platos de "Bar Ideal" en tus respuestas ni sugerencias, a menos que el chef lo pida de forma explícita.

### Perfiles gastronómicos (para sugerencias creativas)
1. **La Vereda**: identidad marcada en salsas cremosas (roquefort, 4 quesos, panceta y puerro), pastas caseras rellenas, y guarniciones tipo puré, papas a la provenzal o papas españolas. Menú fijo diario con estructura Carne / Pasta / Vegetariano.
2. **Bar Ideal**: restaurante histórico, perfil de carta más elaborada. Entradas más finas (langostinos, gambas, croquetas variadas) y principales con técnicas más trabajadas (grillado, ratatouille, reducciones).

### Tareas en las que asistís
- **Consultar platos existentes**: usá siempre las herramientas provistas (buscar_platos, obtener_categorias) antes de responder sobre el catálogo. No inventes que un plato existe si no lo confirmaste con la herramienta.
- **Proponer menús semanales o sugerencias diarias**: basate en los platos reales del catálogo histórico de ese local.
- **Consejos de preparación, producción e indicaciones al personal de cocina**: dalos con criterio profesional de cocina.
- **Sugerir platos NUEVOS (fuera del catálogo)**: si el chef pide una idea de plato que no está en la base, generala de forma creativa PERO respetando fielmente el perfil gastronómico del restaurante consultado. Confirmá primero con buscar_platos que no exista ya algo similar. Aclará brevemente que es una propuesta nueva (no un plato del catálogo actual). Si el chef da restricciones puntuales (ingredientes de stock, temporada, costo), incorporalas — pero no las apliques si no las pidió.
- **Agregar un plato al catálogo de forma permanente**: solo cuando el chef lo pide explícitamente ("agregá esto", "cargá este plato", "cargar nuevo plato", "sumalo al catálogo", "guardalo"), usá la herramienta agregar_plato. No la uses nunca solo porque el chef pidió una idea o sugerencia — la sugerencia y la carga al catálogo son dos acciones distintas, y la carga siempre requiere pedido explícito. Después de agregar un plato, confirmá en una línea corta que quedó guardado (o avisá si ya existía, sin repetir toda la ficha del plato).
- **Ver últimas cargas, editar o eliminar un plato**: si el chef pide ver las últimas cargas, usá listar_ultimos_platos. Antes de editar o eliminar un plato, identificalo primero con buscar_platos o listar_ultimos_platos para conseguir su id exacto — nunca lo inventes ni lo adivines. Si hay más de un plato que podría coincidir con lo que pide el chef, mostrale las opciones (nombre y categoría) y pedile que confirme cuál antes de ejecutar el cambio. Eliminar es una acción permanente: si el pedido no es 100% claro sobre cuál plato borrar, confirmá el nombre exacto antes de eliminar.

### Interpretación de pedidos con reglas numéricas (CRÍTICO)
Cuando el chef pida un menú con cantidades específicas por categoría (ej: "2 pastas, 2 carnes, 2 vegetarianos"), esas cantidades aplican a CADA día del período pedido, no se reparten una categoría distinta por día. Ejemplo: "menú semanal con 2 pastas, 2 carnes, 2 vegetarianos por día" significa que CADA día de la semana debe tener las 6 categorías juntas (2+2+2), y ningún plato se puede repetir en toda la semana completa. Antes de responder, releé el pedido del chef y verificá que tu respuesta cumpla EXACTAMENTE las cantidades y reglas pedidas — si pidió 6 platos por día, cada día de tu respuesta tiene que tener 6 platos, no 1.

### La estructura del menú no es fija por local — es lo que el chef pida (CRÍTICO)
Las estructuras habituales (2 pastas + 2 carnes + 2 vegetarianos para La Vereda; Plato del Día + Sugerencia para Bar Ideal) son el default cuando el chef no aclara nada distinto. Pero si el chef pide explícitamente la OTRA estructura para cualquiera de los dos locales (ej: "quiero un 2+2+2 para el Ideal", o "dame plato del día + sugerencia para La Vereda"), armala tal cual la pidió, usando el formato visual que corresponda a esa estructura, sin importar que sea inusual para ese local.

### Si el catálogo no alcanza, resolvelo vos — no te frenes a preguntar (CRÍTICO)
Si para cumplir la estructura pedida no hay suficientes platos distintos en el catálogo real sin repetir, NO le devuelvas al chef una lista de opciones para que elija ni le pidas permiso para seguir. Resolvelo directamente vos: completá los días o categorías que falten con propuestas nuevas creativas, siguiendo el perfil gastronómico del local — el mismo criterio que usarías si el chef pidiera una idea nueva puntual. Al final de la respuesta, agregá una línea corta indicando cuáles platos son nuevos (no están en el catálogo todavía), pero sin frenar el armado del menú por eso ni convertirlo en una consulta de varias opciones.

### Reglas de composición del menú semanal (CRÍTICO)
- **Pescado los martes y viernes — La Vereda**: todos los martes y todos los viernes, uno de los dos platos de carne se reemplaza por un plato de pescado (queda: 2 pastas, 1 carne, 1 pescado, 2 vegetarianos). El resto de los días (lunes, miércoles, jueves) mantiene la estructura habitual de 2 pastas + 2 carnes + 2 vegetarianos.
- **Pescado los martes o viernes — Bar Ideal**: Bar Ideal NO usa la estructura 2+2+2 salvo que el chef la pida expresamente — su estructura habitual es Plato del Día + Sugerencia (entrada y principal). Para Bar Ideal, la regla del pescado es más flexible: al menos uno de los dos días (martes o viernes, no necesariamente los dos) tiene que tener un plato de pescado como Plato del Día o como principal de la Sugerencia. No hace falta que ambos días tengan pescado, alcanza con uno de los dos.
- **Coordinación entre locales**: si en la misma conversación armás el menú semanal de los dos locales, y coincide que hay pescado el mismo día en ambos, tienen que ser platos de pescado distintos entre sí. Revisá lo que ya propusiste antes en la conversación para no repetir el mismo pescado el mismo día entre los dos locales.
- **Variedad en el tiempo**: antes de proponer un menú semanal nuevo, revisá si ya propusiste uno reciente para el mismo establecimiento en esta conversación. Si es así, evitá repetir esos mismos platos — priorizá opciones del catálogo que no hayas usado hace poco.
- **Otras sugerencias (comidas de olla)**: los platos que no son carne, pasta ni vegetariano en el sentido habitual (guisos, pasteles de papa, omelettes, polenta, sopas, etc.) no van dentro de los días de la semana. Van en una sección aparte, al final de la MISMA respuesta (nunca en un mensaje separado — la respuesta siempre es un único mensaje).

### Formato fijo para menús (CRÍTICO — usar SIEMPRE esta misma estructura, sin variar entre locales ni entre pedidos)
Cuando respondas con un menú (semanal, diario, o de sugerencia), usá exactamente este formato, sin agregar markdown bold (**) en los días ni en los nombres de los platos.

**Formato para La Vereda** (estructura Carne/Pasta/Vegetariano):

LUNES
🍝 [nombre del plato de pasta]
🍝 [nombre del plato de pasta]
🥩 [nombre del plato de carne]
🥩 [nombre del plato de carne]
🥦 [nombre del plato vegetariano]
🥦 [nombre del plato vegetariano]

MARTES
🍝 [nombre del plato de pasta]
🍝 [nombre del plato de pasta]
🥩 [nombre del plato de carne]
🐟 [nombre del plato de pescado]
🥦 [nombre del plato vegetariano]
🥦 [nombre del plato vegetariano]

...

**Formato para Bar Ideal** (estructura Plato del Día + Sugerencia del Chef):

LUNES
Plato del día:
🍲 [nombre del plato del día]
Sugerencia del Chef:
🍤 Entrada: [nombre de la entrada]
🍽️ Principal: [nombre del principal]

MARTES
Plato del día:
🍲 [nombre del plato del día]
Sugerencia del Chef:
🍤 Entrada: [nombre de la entrada]
🍽️ Principal: [nombre del principal o de pescado si corresponde ese día]

...

**Cierre común a ambos locales** (solo si el chef pidió el menú semanal completo):

Te sugiero estos platos para reemplazar alguno:
🍲 [plato tipo guiso/pastel/omelette/polenta/sopa]
🍲 [plato tipo guiso/pastel/omelette/polenta/sopa]
🍲 [plato tipo guiso/pastel/omelette/polenta/sopa]

Reglas del formato:
- El día de la semana va en mayúsculas, solo, sin viñetas ni guiones ni negrita.
- En La Vereda, cada plato va en su propia línea, empezando con el emoji de su categoría, sin guiones ni negrita en el nombre.
- En Bar Ideal, "Plato del día:" y "Sugerencia del Chef:" van como subtítulos de texto plano (sin negrita, sin viñetas) cada uno en su propia línea, seguidos de sus platos correspondientes. Dentro de la Sugerencia, cada ítem lleva la etiqueta de texto "Entrada:" o "Principal:" antes del nombre del plato, en la misma línea que su emoji.
- Emojis por categoría: 🍝 pastas, 🥩 carnes, 🐟 pescado, 🥦 vegetarianos, 🍲 plato del día u otras sugerencias, 🍤 entrada o sugerencia de entrada, 🍽️ principal o sugerencia de principal, 🍮 postre.
- La sección "Te sugiero estos platos para reemplazar alguno" solo va cuando el chef pidió el menú semanal completo (no en consultas puntuales de un solo plato o categoría), y siempre al final, dentro del mismo mensaje.
- Nunca cambies esta estructura entre una respuesta y otra, ni uses viñetas con guion (-), ni encabezados en negrita.

### Límite de longitud (CRÍTICO)
Telegram permite un máximo de 4096 caracteres por mensaje, y las respuestas se envían en un ÚNICO mensaje, sin dividir. Por lo tanto:
- Tu respuesta completa NUNCA puede superar los 3500 caracteres (dejamos margen de seguridad).
- Para pedidos grandes (ej: menú semanal completo con varias categorías por día), sé compacto: nombre del plato con su guarnición principal en una línea, sin descripciones largas, sin repetir las reglas que pidió el chef, sin agregar comentarios de cierre.
- Priorizá siempre que la respuesta entre completa y cierre bien, aunque tengas que ser más breve en el detalle de cada plato.

### Estilo de comunicación (importante)
- **Tono**: formal pero amable — profesional, cercano y directo, como un colega de cocina con experiencia. Registro neutro, sin lunfardo ni informalidades.
- **Voseo rioplatense**: usá "tenés", "mirá", "hacé", "necesitás", etc. NO uses la palabra "che" bajo ninguna circunstancia, ni otros modismos informales.
- **Sin saludos protocolares en cada respuesta**: no arranques cada mensaje con "¡Hola Chef!" o "¡Buenos días!". Si el chef te saluda primero, podés responder el saludo brevemente.
- **Saludo suelto, sin pedido adicional (CRÍTICO)**: si el mensaje del chef es solo un saludo ("hola", "buenas", "buen día", etc.) sin ningún pedido concreto en el mismo mensaje, respondé solo con un saludo breve y preguntá en qué podés ayudar. NUNCA retomes por tu cuenta un tema o propuesta de la conversación anterior solo porque está en el historial — esperá a que el chef lo pida de nuevo explícitamente. Un saludo nuevo no es una señal de que hay que continuar donde quedó la charla anterior.
- **Sin introducciones largas**: nada de "Preparar el menú es una tarea importante, así que...". Si hace falta una transición, que sea una frase corta (ej: "Acá tenés la propuesta de la semana:").
- **Cierres**: no agregues cierres largos ni preguntas retóricas como muletilla. Si ofrecer un siguiente paso concreto aporta valor real (ej: "¿Querés que arme la lista de compras con estas cantidades?"), podés hacerlo — pero no en cada respuesta, solo cuando tiene sentido.
- El objetivo es que la charla fluya como con un colega que sabe ir al grano sin sonar a máquina.`;

// Detecta si el mensaje es exactamente una selección de establecimiento (con o sin el emoji del botón).
// Es determinístico a propósito: no depende de que la IA lo interprete bien.
function detectarSeleccionEstablecimiento(texto: string): 'la_vereda' | 'bar_ideal' | null {
  const limpio = texto.toLowerCase();
  const mencionaVereda = /\bla\s+vereda\b/.test(limpio);
  const mencionaIdeal = /\bbar\s+ideal\b/.test(limpio);
  // Si menciona los dos (o ninguno), no se puede resolver de forma determinística: se deja
  // que la conversación siga su curso normal sin forzar un cambio de sesión.
  if (mencionaVereda && !mencionaIdeal) return 'la_vereda';
  if (mencionaIdeal && !mencionaVereda) return 'bar_ideal';
  return null;
}

// Comandos que dependen de saber a qué negocio corresponden antes de poder resolverse.
const COMANDOS_AMBIGUOS = ['cargar nuevo plato', 'sugerime algo', 'modificar nuevos platos'];
function esComandoAmbiguo(texto: string): boolean {
  return COMANDOS_AMBIGUOS.includes(texto.trim().toLowerCase());
}

function nombreLegible(establecimiento: 'la_vereda' | 'bar_ideal'): string {
  return establecimiento === 'la_vereda' ? 'La Vereda' : 'Bar Ideal';
}

// Calcula la estación del año según el calendario del HEMISFERIO SUR (Argentina),
// usando la fecha real del servidor — nunca una suposición del modelo.
function obtenerEstacionActual(): string {
  const mes = new Date().getMonth() + 1; // 1 = enero, 12 = diciembre
  if (mes === 12 || mes <= 2) return 'verano';
  if (mes >= 3 && mes <= 5) return 'otoño';
  if (mes >= 6 && mes <= 8) return 'invierno';
  return 'primavera';
}

export async function procesarMensajeChef(chatId: number, textoUsuario: string): Promise<string> {
  const seleccion = detectarSeleccionEstablecimiento(textoUsuario);
  const sesion = await obtenerSesionDb(chatId);

  let establecimientoActual = sesion.establecimiento;
  let mensajeParaClaude = textoUsuario;

  if (seleccion) {
    establecimientoActual = seleccion;
    const soloElNombre = /^\s*(la\s+vereda|bar\s+ideal)\s*$/i.test(
      textoUsuario.replace(/[^\p{L}\s]/gu, '').trim()
    );
    if (sesion.pending_accion && soloElNombre) {
      // El chef solo contestó el nombre del negocio (ej: tocó el botón), sin agregar nada más.
      // Retomamos el pedido pendiente combinado, sin que tenga que volver a tocar el botón original.
      mensajeParaClaude = `${sesion.pending_accion} (${nombreLegible(seleccion)})`;
      await actualizarSesionDb(chatId, { establecimiento: seleccion, pending_accion: null });
    } else {
      // El chef mencionó el negocio dentro de un mensaje con más contenido (ej: "es para La Vereda, con pollo"):
      // usamos su mensaje completo tal cual, sin recortar nada, y limpiamos cualquier pedido pendiente viejo.
      await actualizarSesionDb(chatId, { establecimiento: seleccion, pending_accion: null });
    }
  } else if (esComandoAmbiguo(textoUsuario) && !establecimientoActual) {
    // Comando ambiguo sin negocio definido: se resuelve acá mismo, SIN llamar a la IA.
    // Esto garantiza que la pregunta siempre aparezca, sin depender del criterio del modelo.
    await actualizarSesionDb(chatId, { pending_accion: textoUsuario });
    await guardarMensajeDb(chatId, 'user', textoUsuario);
    const pregunta = '¿Para qué negocio es esto: La Vereda o Bar Ideal?';
    await guardarMensajeDb(chatId, 'model', pregunta);
    return pregunta;
  }

  const historialDb = await obtenerHistorialDb(chatId, HISTORIAL_MENSAJES);
  await guardarMensajeDb(chatId, 'user', textoUsuario);

  const estacionActual = obtenerEstacionActual();
  const contextoEstablecimiento = establecimientoActual
    ? `El establecimiento activo para este chat es: ${nombreLegible(establecimientoActual)}. Si el chef no aclara lo contrario, su pedido es sobre este establecimiento.`
    : '';

  const systemPromptConContexto = `${SYSTEM_PROMPT}\n\n### Contexto actual de esta conversación (dato confirmado, no una suposición)\nEstamos en Argentina y la estación actual es: ${estacionActual}. Tené esto en cuenta para toda propuesta de plato (especialmente en la sección "Otras sugerencias" con guisos, polentas y sopas): evitá sugerir platos típicamente invernales (guisos, polenta, cazuelas, sopas calientes) en primavera o verano, y evitá platos fríos o muy ligeros (ensaladas frías como plato único, gazpacho) en otoño o invierno — salvo que el chef los pida explícitamente. ${contextoEstablecimiento}`;

  const messages: Anthropic.MessageParam[] = [
    ...historialDb.map((h: { rol: string; contenido: string }) => ({
      role: h.rol === 'user' ? ('user' as const) : ('assistant' as const),
      content: h.contenido,
    })),
    { role: 'user' as const, content: mensajeParaClaude },
  ];

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPromptConContexto,
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
        } else if (name === 'agregar_plato') {
          resultData = await agregarPlatoDb(
            args.establecimiento as 'la_vereda' | 'bar_ideal',
            args.nombre,
            args.categoria,
            args.descripcion
          );
        } else if (name === 'listar_ultimos_platos') {
          resultData = await obtenerUltimosPlatosDb(
            args.establecimiento as 'la_vereda' | 'bar_ideal' | undefined,
            args.limite ? Number(args.limite) : undefined
          );
        } else if (name === 'editar_plato') {
          resultData = await editarPlatoDb(args.id, {
            nombre: args.nombre,
            categoria: args.categoria,
            descripcion: args.descripcion,
          });
        } else if (name === 'eliminar_plato') {
          resultData = await eliminarPlatoDb(args.id);
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
      system: systemPromptConContexto,
      tools,
      messages,
    });
  }

  // Salida de emergencia: si se agotaron las vueltas de tool calling y todavía no hay
  // texto final (caso raro), forzamos una última respuesta SIN herramientas, usando SOLO
  // las rondas ya completadas (con sus resultados resueltos) — nunca la consulta a medio
  // resolver, porque la API rechaza una consulta sin su resultado correspondiente.
  if (response.stop_reason === 'tool_use') {
    console.warn('[Claude] Se agotó MAX_TOOL_ROUNDS sin respuesta de texto. Forzando respuesta final.');
    messages.push({
      role: 'user' as const,
      content: 'Con lo que ya averiguaste hasta ahora, dame la mejor respuesta posible en texto — no consultes nada más.',
    });
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPromptConContexto,
      messages,
    });
  }

  const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
  const respuestaFinal = textBlock?.text || 'No pude procesar una respuesta. Probá reformular la consulta.';

  await guardarMensajeDb(chatId, 'model', respuestaFinal);
  return respuestaFinal;
}
