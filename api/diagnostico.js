// api/diagnostico.js — función serverless de Vercel (Node 18+, sin dependencias)
const MODELO = "gemini-2.5-flash";

const INSTRUCCIONES = `Eres AgroBot AI, un agrónomo experto en cítricos, especialmente limoneros.
Recibes un fotograma de la cámara en vivo. Analiza hojas, tallos, frutos, suelo y el aspecto general del árbol.
Responde SOLO con un JSON válido con estas claves:
{
  "es_limonero": boolean,
  "visible": "qué se alcanza a ver, en una frase",
  "diagnostico": "problema más probable (ej: deficiencia de hierro, minador de la hoja, cancro cítrico, estrés hídrico, sin problemas aparentes)",
  "confianza": número de 0 a 100,
  "causas_posibles": ["máximo 3 causas"],
  "recomendaciones": ["máximo 3 acciones concretas y simples"],
  "necesita_mas_info": "si la imagen es borrosa o no basta, qué debe mostrar el usuario (ej: acercar la cámara a una hoja, mostrar el envés, mostrar el fruto). Si no hace falta, cadena vacía"
}
Reglas: español natural y breve. Si no es un limonero o no hay planta a la vista, pon es_limonero en false y explica en "necesita_mas_info". No inventes: si dudas, baja la confianza. Aclara que es una orientación y no reemplaza a un ingeniero agrónomo solo cuando la confianza sea menor a 60.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Falta GEMINI_API_KEY en Vercel" });

  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: "Falta la imagen" });

    const base64 = image.replace(/^data:image\/\w+;base64,/, "");

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: INSTRUCCIONES }] },
          contents: [
            {
              parts: [
                { inlineData: { mimeType: "image/jpeg", data: base64 } },
                { text: "Analiza este fotograma." },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
        }),
      }
    );

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Error de la API" });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const limpio = texto.replace(/```json|```/g, "").trim();
    return res.status(200).json(JSON.parse(limpio));
  } catch (e) {
    return res.status(500).json({ error: "No se pudo analizar: " + e.message });
  }
}