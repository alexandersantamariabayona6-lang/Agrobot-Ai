// api/diagnostico.js
// Backend de Agrobot AI (Vercel) usando gemini-2.5-flash

const MODELO = "gemini-2.5-flash";
const URL_API = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

const PROMPT_DIAGNOSTICO = `Eres Agrobot AI, un ingeniero agrónomo experto que ayuda a campesinos y cultivadores en Colombia.
Analiza la fotografía de una planta (hoja, fruto, tallo o árbol completo; cualquier especie).
Fíjate en el color y la forma de las hojas, las nervaduras, manchas, bordes secos, plagas visibles y el estado del fruto.

Responde SOLO en texto plano, en español, con EXACTAMENTE este formato de 5 líneas o bloques. No uses markdown, asteriscos, emojis ni símbolos decorativos:

PLANTA: nombre científico | nombre común
PROBLEMA: qué enfermedad, plaga o deficiencia parece tener, explicado en 2 o 3 frases sencillas. Si se ve sana, dilo.
RIESGO: Alto, Medio o Bajo. Luego, una frase corta que explique por qué.
QUÉ HACER:
- acción concreta 1
- acción concreta 2
- acción concreta 3
CONFIANZA: Alta, Media o Baja. Luego, una frase corta sobre qué tan seguro es el diagnóstico y qué foto ayudaría a confirmarlo.

Reglas:
- En la línea RIESGO escribe primero la palabra del nivel (Alto, Medio o Bajo).
- Si la imagen no muestra una planta, pon "PLANTA: No identificada", explica en PROBLEMA que no ves una planta, RIESGO: Bajo, y pide una foto más clara.
- Usa lenguaje simple, sin tecnicismos innecesarios.`;

const PROMPT_CHAT = `Eres Agrobot AI, un asistente agrícola amable y práctico. Conversas con una persona sobre la planta que acabas de diagnosticar.
Responde en español natural y cercano, en máximo 4 frases cortas.
No uses markdown, asteriscos, listas con símbolos ni emojis, porque tu respuesta se lee en voz alta.
Si la pregunta no tiene que ver con plantas o cultivos, redirige con amabilidad al tema de la planta.
Si hay riesgo real para la salud (por ejemplo, productos químicos), recomienda usar protección y consultar a un técnico agrónomo.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Llamada a Gemini con reintentos ----------

async function llamarGemini(body) {
  const r = await fetch(URL_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    let detalle = "";
    try {
      detalle = await r.text();
    } catch (_) {}
    const e = new Error(`Gemini ${r.status}: ${detalle.slice(0, 250)}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

async function conReintentos(body) {
  let ultimo;
  for (let i = 0; i < 3; i++) {
    try {
      return await llamarGemini(body);
    } catch (e) {
      ultimo = e;
      const temporal = [429, 500, 503, 504].includes(e.status);
      if (!temporal) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw ultimo;
}

function sacarTexto(data) {
  if (data?.promptFeedback?.blockReason) {
    throw new Error("La imagen fue bloqueada: " + data.promptFeedback.blockReason);
  }
  const partes = data?.candidates?.[0]?.content?.parts || [];
  const texto = partes.map((p) => p.text || "").join("").trim();
  if (!texto) throw new Error("Gemini no devolvió texto");
  return texto;
}

// Quita markdown y emojis para que el front y la voz lean limpio
function limpiar(texto) {
  return texto
    .replace(/```[a-z]*|```/gi, "")
    .replace(/\*\*|__|\*/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- interactionId sin estado ----------
// Vercel no guarda memoria entre llamadas, así que el "interactionId"
// lleva dentro el diagnóstico y la conversación (solo texto, sin la foto).

function crearId(estado) {
  return Buffer.from(JSON.stringify(estado), "utf8").toString("base64url");
}

function leerId(id) {
  try {
    const estado = JSON.parse(Buffer.from(String(id), "base64url").toString("utf8"));
    if (typeof estado.d !== "string" || !Array.isArray(estado.h)) throw new Error();
    return estado;
  } catch (_) {
    throw new Error("La sesión expiró. Toma una nueva foto de la planta.");
  }
}

// ---------- Acciones ----------

async function iniciar(imagen) {
  if (!imagen) throw new Error("No se recibió ninguna imagen");

  let mimeType = "image/jpeg";
  let base64 = imagen;
  const m = /^data:(.+?);base64,([\s\S]*)$/.exec(imagen);
  if (m) {
    mimeType = m[1];
    base64 = m[2];
  }

  const data = await conReintentos({
    contents: [
      {
        role: "user",
        parts: [
          { text: PROMPT_DIAGNOSTICO },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1500,
      thinkingConfig: { thinkingBudget: 0 }
    }
  });

  const respuesta = limpiar(sacarTexto(data));
  return {
    status: "completed",
    respuesta,
    interactionId: crearId({ d: respuesta, h: [] })
  };
}

async function preguntar(interactionId, pregunta) {
  if (!pregunta) throw new Error("Escribe una pregunta");
  const estado = leerId(interactionId);

  const contents = [];
  for (const [q, a] of estado.h) {
    contents.push({ role: "user", parts: [{ text: q }] });
    contents.push({ role: "model", parts: [{ text: a }] });
  }
  contents.push({ role: "user", parts: [{ text: String(pregunta).slice(0, 500) }] });

  const data = await conReintentos({
    systemInstruction: {
      parts: [
        {
          text:
            PROMPT_CHAT +
            "\n\nDiagnóstico de la planta que hiciste:\n" +
            estado.d
        }
      ]
    },
    contents,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 600,
      thinkingConfig: { thinkingBudget: 0 }
    }
  });

  const respuesta = limpiar(sacarTexto(data));

  // Guardamos solo las últimas 6 preguntas para que el id no crezca de más
  const h = [...estado.h, [String(pregunta).slice(0, 500), respuesta]].slice(-6);

  return {
    status: "completed",
    respuesta,
    interactionId: crearId({ d: estado.d, h })
  };
}

// ---------- Handler de Vercel ----------

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Falta la variable GEMINI_API_KEY en Vercel" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    body = body || {};

    if (body.accion === "iniciar") {
      return res.status(200).json(await iniciar(body.imagen));
    }

    if (body.accion === "preguntar") {
      return res.status(200).json(await preguntar(body.interactionId, body.pregunta));
    }

    if (body.accion === "estado") {
      // Las respuestas ya llegan completas, esto es solo por compatibilidad
      return res.status(200).json({
        status: "failed",
        error: "Este análisis ya no está disponible. Toma una nueva foto."
      });
    }

    return res.status(400).json({ error: "Acción no válida" });
  } catch (e) {
    console.error("Error en diagnostico:", e);

    const saturado = [429, 500, 503, 504].includes(e.status);
    const mensaje = saturado
      ? "Hay mucha demanda en este momento. Intenta de nuevo en unos segundos."
      : e.message || "No fue posible completar el análisis.";

    return res.status(saturado ? 503 : 500).json({ error: mensaje });
  }
};