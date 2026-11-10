// api/diagnostico.js — Vercel (Node 18+, sin dependencias)
// Dos modos: "detectar" (rápido, 1 fotograma) y "diagnosticar" (completo, varios fotogramas)
const MODELO = "gemini-3.8-flash";

const DETECTAR = `Eres AgroBot AI, un asistente que guía por voz a una persona que apunta la cámara de su celular.
Recibes UN fotograma. Responde SOLO con JSON válido:
{
  "es_limonero": boolean (hay un limonero o ramas/hojas/frutos de limón claramente visibles),
  "calidad_ok": boolean (la imagen está enfocada y se ven bien hojas o frutos),
  "visible": "lo que ves, máximo 12 palabras, en español natural (ej: Veo hojas verdes con manchas amarillas)",
  "guia": "una instrucción corta de máximo 12 palabras para mover la cámara (ej: Acércate un poco a las hojas). Si ya está bien: Perfecto, mantén la cámara quieta"
}
Si no hay un limonero, es_limonero va en false y la guía debe ayudar a encontrarlo. No inventes nada.`;

const DIAGNOSTICAR = `Eres AgroBot AI, un agrónomo experto en cítricos, especialmente limoneros.
Recibes varios fotogramas del mismo árbol. Analiza hojas, tallos, frutos y aspecto general.
Responde SOLO con JSON válido:
{
  "es_limonero": boolean,
  "diagnostico": "problema más probable (ej: deficiencia de hierro, minador de la hoja, cancro cítrico, estrés hídrico, sin problemas aparentes)",
  "confianza": número de 0 a 100,
  "causas_posibles": ["máximo 3"],
  "recomendaciones": ["máximo 3 acciones concretas y simples"],
  "necesita_mas_info": "si falta algo para estar seguro, qué debería mostrar el usuario. Si no hace falta, cadena vacía",
  "resumen_voz": "2 o 3 frases naturales para leer en voz alta: qué tiene el árbol, qué tan seguro estás y qué hacer primero. Sin listas ni símbolos."
}
Español natural y breve. No inventes: si dudas, baja la confianza y dilo.`;

async function pedir(key, cuerpo) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) }
  );
  return { status: r.status, ok: r.ok, data: await r.json() };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Falta GEMINI_API_KEY en Vercel" });

  try {
    const { modo, imagenes } = req.body || {};
    if (!Array.isArray(imagenes) || !imagenes.length)
      return res.status(400).json({ error: "Faltan las imágenes" });

    const rapido = modo === "detectar";
    const partes = imagenes.slice(0, 5).map((i) => ({
      inlineData: { mimeType: "image/jpeg", data: String(i).replace(/^data:image\/\w+;base64,/, "") },
    }));
    partes.push({ text: rapido ? "Analiza este fotograma." : "Estos fotogramas son del mismo árbol. Haz el diagnóstico." });

    const base = {
      systemInstruction: { parts: [{ text: rapido ? DETECTAR : DIAGNOSTICAR }] },
      contents: [{ parts: partes }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3,
        maxOutputTokens: rapido ? 1024 : 2048,
      },
    };

    // Primero con poco "pensamiento" para que responda rápido.
    // Si el modelo no acepta ese parámetro, reintenta sin él.
    let r = await pedir(key, {
      ...base,
      generationConfig: {
        ...base.generationConfig,
        thinkingConfig: { thinkingLevel: rapido ? "minimal" : "low" },
      },
    });
    if (r.status === 400) r = await pedir(key, base);

    if (!r.ok) return res.status(r.status).json({ error: r.data?.error?.message || "Error de la API" });

    const texto = r.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}";
    return res.status(200).json(JSON.parse(texto.replace(/```json|```/g, "").trim()));
  } catch (e) {
    return res.status(500).json({ error: "No se pudo analizar: " + e.message });
  }
}