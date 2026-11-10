// api/diagnostico.js — Vercel (Node 18+, sin dependencias)
// Tres modos: "detectar" (rápido, 1 fotograma), "diagnosticar" (varios fotogramas) y "preguntar" (solo texto)
const MODELO = "gemini-3.8-flash";

const DETECTAR = `Eres AgroBot AI, un asistente que guía por voz a una persona que apunta la cámara de su celular hacia una planta.
Recibes UN fotograma. Responde SOLO con JSON válido:
{
  "hay_planta": boolean (hay una planta, árbol, hoja, flor o fruto claramente visible, de cualquier especie, en maceta, jardín, cultivo o foto en una pantalla),
  "calidad_ok": boolean (la imagen está enfocada y se ven bien hojas, tallo o fruto),
  "planta": "nombre común de la planta si lo reconoces, o cadena vacía",
  "visible": "lo que ves, máximo 12 palabras, en español natural (ej: Veo hojas verdes con nervaduras amarillas)",
  "guia": "instrucción corta de máximo 12 palabras para mover la cámara (ej: Acércate a una hoja). Si ya está bien: Perfecto, mantén la cámara quieta"
}
Si no hay ninguna planta, hay_planta va en false y la guía debe ayudar a encontrar una. No inventes nada.`;

const DIAGNOSTICAR = `Eres AgroBot AI, un agrónomo y fitopatólogo experto en toda clase de plantas: frutales, hortalizas, ornamentales, árboles y cultivos.
Recibes varios fotogramas de la misma planta. Identifica la especie y evalúa su salud con evidencia visual:
- Hojas: color, manchas (forma, borde, halo), bordes secos o quemados, enrollamiento, textura, agujeros, galerías.
- Nervaduras: venas verdes con tejido amarillo entre ellas (clorosis intervenal, típico de hierro, magnesio o zinc), amarillamiento uniforme (nitrógeno), venas amarillas o necrosis.
- Tallos y frutos: lesiones, cancros, pudriciones, deformaciones, exudados.
- Plagas visibles: insectos, mielecilla, hongos, telarañas, polvo blanco.
- Señales de agua: marchitez, hojas caídas o crujientes (falta), amarillamiento con base blanda (exceso).
Responde SOLO con JSON válido:
{
  "es_planta": boolean,
  "planta": "especie o nombre común más probable (di 'no estoy seguro' si dudas)",
  "estado": "sana" | "con problemas" | "dudoso",
  "diagnostico": "problema más probable en pocas palabras, o 'sin problemas aparentes'",
  "confianza": número de 0 a 100,
  "evidencia": ["máximo 3 cosas concretas que viste y apoyan el diagnóstico"],
  "causas_posibles": ["máximo 3"],
  "recomendaciones": ["máximo 3 acciones concretas y simples"],
  "necesita_mas_info": "qué debería mostrar o contestar el usuario para estar más seguro. Cadena vacía si no hace falta",
  "resumen_voz": "2 o 3 frases naturales para leer en voz alta: qué planta es, cómo está, qué tan seguro estás y qué hacer primero. Sin listas ni símbolos."
}
Español natural y breve. No inventes: si la imagen no alcanza, baja la confianza y dilo.`;

const PREGUNTAR = `Eres AgroBot AI, un agrónomo amable que conversa por voz con el usuario sobre la planta que acaba de diagnosticar.
Tienes los datos del diagnóstico y la conversación previa. Responde la pregunta apoyándote en ellos.
Responde SOLO con JSON: { "respuesta": "2 a 4 frases naturales para leer en voz alta, sin listas ni símbolos" }
Si el usuario te da información nueva (riego, sol, abono, clima), úsala para afinar tu opinión y di si cambia el diagnóstico.
Si falta información, haz UNA pregunta corta. Si la pregunta no tiene que ver con plantas, redirige con amabilidad. No inventes datos. Si el problema parece grave, sugiere consultar a un ingeniero agrónomo.`;

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
    const { modo, imagenes, pregunta, contexto, historial } = req.body || {};
    let sistema, partes, tokens, nivel;

    if (modo === "preguntar") {
      if (!pregunta) return res.status(400).json({ error: "Falta la pregunta" });
      const hist = (Array.isArray(historial) ? historial : [])
        .slice(-6)
        .map((h) => `${h.rol === "usuario" ? "Usuario" : "AgroBot"}: ${String(h.texto).slice(0, 400)}`)
        .join("\n");
      sistema = PREGUNTAR;
      partes = [{
        text: `Diagnóstico de la planta (datos):\n${JSON.stringify(contexto || {}).slice(0, 3000)}\n\nConversación previa:\n${hist || "(ninguna)"}\n\nPregunta del usuario: ${String(pregunta).slice(0, 500)}`,
      }];
      tokens = 1024; nivel = "minimal";
    } else {
      if (!Array.isArray(imagenes) || !imagenes.length)
        return res.status(400).json({ error: "Faltan las imágenes" });
      const rapido = modo === "detectar";
      sistema = rapido ? DETECTAR : DIAGNOSTICAR;
      partes = imagenes.slice(0, 5).map((i) => ({
        inlineData: { mimeType: "image/jpeg", data: String(i).replace(/^data:image\/\w+;base64,/, "") },
      }));
      partes.push({ text: rapido ? "Analiza este fotograma." : "Estos fotogramas son de la misma planta. Haz el diagnóstico." });
      tokens = rapido ? 1024 : 2048; nivel = rapido ? "minimal" : "low";
    }

    const base = {
      systemInstruction: { parts: [{ text: sistema }] },
      contents: [{ parts: partes }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: tokens },
    };

    // Primero con poco "pensamiento" para que responda rápido.
    // Si el modelo no acepta ese parámetro, reintenta sin él.
    let r = await pedir(key, {
      ...base,
      generationConfig: { ...base.generationConfig, thinkingConfig: { thinkingLevel: nivel } },
    });
    if (r.status === 400) r = await pedir(key, base);

    if (!r.ok) return res.status(r.status).json({ error: r.data?.error?.message || "Error de la API" });

    const texto = r.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}";
    return res.status(200).json(JSON.parse(texto.replace(/```json|```/g, "").trim()));
  } catch (e) {
    return res.status(500).json({ error: "No se pudo analizar: " + e.message });
  }
}