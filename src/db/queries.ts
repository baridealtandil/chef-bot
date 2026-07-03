import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
// Inicializar la conexión de forma perezosa
let sql: postgres.Sql;
function getSql() {
  if (!sql) {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL no configurada en las variables de entorno.');
    }
    sql = postgres(databaseUrl);
  }
  return sql;
}
export interface Plato {
  id: string;
  nombre: string;
  establecimiento: 'la_vereda' | 'bar_ideal';
  categoria: string;
  descripcion: string | null;
  plato_compartido: boolean;
  created_at: Date;
}
export interface Mensaje {
  id: string;
  chat_id: number;
  rol: 'user' | 'model';
  contenido: string;
  created_at: Date;
}
export async function buscarPlatosDb(
  establecimiento: 'la_vereda' | 'bar_ideal',
  query?: string,
  categoria?: string
): Promise<Plato[]> {
  const db = getSql();

  if (query && categoria) {
    return await db<Plato[]>`
      SELECT * FROM platos
      WHERE establecimiento = ${establecimiento}
        AND categoria = ${categoria}
        AND nombre ILIKE ${'%' + query + '%'}
      ORDER BY nombre ASC
    `;
  } else if (query) {
    return await db<Plato[]>`
      SELECT * FROM platos
      WHERE establecimiento = ${establecimiento}
        AND nombre ILIKE ${'%' + query + '%'}
      ORDER BY nombre ASC
    `;
  } else if (categoria) {
    return await db<Plato[]>`
      SELECT * FROM platos
      WHERE establecimiento = ${establecimiento}
        AND categoria = ${categoria}
      ORDER BY nombre ASC
    `;
  } else {
    return await db<Plato[]>`
      SELECT * FROM platos
      WHERE establecimiento = ${establecimiento}
      ORDER BY nombre ASC
    `;
  }
}
export async function obtenerCategoriasDb(establecimiento: 'la_vereda' | 'bar_ideal'): Promise<string[]> {
  const db = getSql();
  const rows = await db`
    SELECT DISTINCT categoria FROM platos
    WHERE establecimiento = ${establecimiento}
    ORDER BY categoria ASC
  `;
  return rows.map(r => r.categoria);
}
export async function agregarPlatoDb(
  establecimiento: 'la_vereda' | 'bar_ideal',
  nombre: string,
  categoria: string,
  descripcion?: string
): Promise<{ creado: boolean; plato?: Plato; motivo?: string }> {
  const db = getSql();

  const existentes = await db<Plato[]>`
    SELECT * FROM platos
    WHERE establecimiento = ${establecimiento}
      AND LOWER(nombre) = LOWER(${nombre})
  `;

  if (existentes.length > 0) {
    return {
      creado: false,
      motivo: 'Ya existe un plato con ese nombre en este establecimiento.',
      plato: existentes[0],
    };
  }

  const [nuevo] = await db<Plato[]>`
    INSERT INTO platos (establecimiento, nombre, categoria, descripcion)
    VALUES (${establecimiento}, ${nombre}, ${categoria}, ${descripcion ?? null})
    RETURNING *
  `;

  return { creado: true, plato: nuevo };
}
// Lista los platos más recientes (útil para revisar cargas nuevas o encontrar el id de algo agregado hace poco)
export async function obtenerUltimosPlatosDb(
  establecimiento?: 'la_vereda' | 'bar_ideal',
  limite = 10
): Promise<Plato[]> {
  const db = getSql();
  if (establecimiento) {
    return await db<Plato[]>`
      SELECT * FROM platos
      WHERE establecimiento = ${establecimiento}
      ORDER BY created_at DESC
      LIMIT ${limite}
    `;
  }
  return await db<Plato[]>`
    SELECT * FROM platos
    ORDER BY created_at DESC
    LIMIT ${limite}
  `;
}
// Edita un plato existente por id. Solo actualiza los campos que se pasan (los demás quedan igual)
export async function editarPlatoDb(
  id: string,
  cambios: { nombre?: string; categoria?: string; descripcion?: string }
): Promise<Plato | null> {
  const db = getSql();
  const [actualizado] = await db<Plato[]>`
    UPDATE platos
    SET
      nombre = COALESCE(${cambios.nombre ?? null}, nombre),
      categoria = COALESCE(${cambios.categoria ?? null}, categoria),
      descripcion = COALESCE(${cambios.descripcion ?? null}, descripcion)
    WHERE id = ${id}
    RETURNING *
  `;
  return actualizado ?? null;
}
// Elimina un plato del catálogo de forma permanente por id
export async function eliminarPlatoDb(id: string): Promise<Plato | null> {
  const db = getSql();
  const [eliminado] = await db<Plato[]>`
    DELETE FROM platos
    WHERE id = ${id}
    RETURNING *
  `;
  return eliminado ?? null;
}
export async function guardarMensajeDb(chatId: number, rol: 'user' | 'model', contenido: string): Promise<void> {
  const db = getSql();
  await db`
    INSERT INTO conversaciones (chat_id, rol, contenido)
    VALUES (${chatId}, ${rol}, ${contenido})
  `;
}
export async function obtenerHistorialDb(chatId: number, limit = 20): Promise<Mensaje[]> {
  const db = getSql();
  return await db<Mensaje[]>`
    SELECT rol, contenido
    FROM conversaciones
    WHERE chat_id = ${chatId}
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}
