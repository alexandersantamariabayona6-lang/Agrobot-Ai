// api/diagnostico.js
// Función serverless de Vercel para AgroBot AI

export const config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: "6mb" } }
};

const MODELO = "gemini-2.5-flash";

const PROMPT = `Eres AgroBot AI, un agrónomo experto. Analiza la imagen de una planta, hoja, fruto o árbol (cualquier especie, no solo limonero).
Fíjate en: color y forma de las hojas, nervaduras, manchas, bordes quemados, plagas visibles, estado del fruto y del tallo.

Responde SOLO con un JSON válido, sin texto extra y sin markdown, con esta estructura exacta:
{
  "planta": "nombre de la planta o 'No identificada'",
  "estado": "Saludable" | "Atención" | "Enfermedad",
  "diagnostico": "explicación corta y clara de lo que ves (máx. 3 frases)",
  "posibles_causas": ["causa 1", "causa 2"],
  "recomendaciones": ["acción 1", "acción 2", "acción 3"],
  "confianza": "Alta" | "Media" | "Baja",
  "mensaje_voz": "resumen hablado en español natural, cálido y breve (máx. 3 frases), SIN emojis, SIN símbolos y SIN listas"
}

Si la imagen no muestra una planta, indícalo en "diagnostico" y pon estado "Atención" y confianza "Baja".
Escribe todo en español.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function llamarGemini(body) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    }
  );

  if (!r.ok) {
    let detalle = "";
    try {
      detalle = await r.text();
    } catch (_) {}
    const e = new Error(`Gemini respondió ${r.status}: ${detalle.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// Reintenta solo si hay saturación temporal
async function conReintentos(body) {
  let ultimoError;
  for (let intento = 0; intento < 3; intento++) {
    try {
      return await llamarGemini(body);
    } catch (e) {
      ultimoError = e;
      const temporal = [429, 500, 503, 504].includes(e.status);
      if (!temporal) throw e;
      await sleep(1000 * (intento + 1));
    }
  }
  throw ultimoError;
}

function limpiarJSON(texto) {
  const limpio = texto.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(limpio);
  } catch (_) {
    const ini = limpio.indexOf("{");
    const fin = limpio.lastIndexOf("}");
    if (ini !== -1 && fin !== -1) return JSON.parse(limpio.slice(ini, fin + 1));
    throw new Error("La respuesta de la IA no vino en formato JSON");
  }
}

// Quita emojis y símbolos para que la voz no los lea
function limpiarParaVoz(texto = "") {
  return texto
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[*_#`~>|]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Falta GEMINI_API_KEY en Vercel" });
  }

  try {
    // Acepta varios nombres de campo por si el front usa otro
    const entrada =
      req.body?.imagen || req.body?.image || req.body?.foto || req.body?.base64;

    if (!entrada) {
      return res.status(400).json({
        error: "No se recibió ninguna imagen",
        detalle: "Campos recibidos: " + Object.keys(req.body || {}).join(", ")
      });
    }

    let mimeType = "image/jpeg";
    let base64 = entrada;
    const m = /^data:(.+?);base64,(.*)$/.exec(entrada);
    if (m) {
      mimeType = m[1];
      base64 = m[2];
    }

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType, data: base64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
        responseMimeType: "application/json"
      }
    };

    const data = await conReintentos(body);

    const texto =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!texto) throw new Error("Respuesta vacía de la IA");

    const resultado = limpiarJSON(texto);
    resultado.mensaje_voz = limpiarParaVoz(
      resultado.mensaje_voz || resultado.diagnostico || ""
    );

    return res.status(200).json(resultado);
  } catch (e) {
    console.error("Error en diagnostico:", e);

    const saturado = [429, 500, 503, 504].includes(e.status);
    return res.status(saturado ? 503 : 500).json({
      error: saturado
        ? "Hay mucha demanda en este momento. Intenta de nuevo en unos segundos."
        : "No fue posible completar el análisis.",
      detalle: e.message
    });
  }
}