const MODELO = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// Debe ser menor que maxDuration de vercel.json (60 s)
const TIEMPO_MAXIMO_MS = 50000;

const URL_GEMINI =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const INSTRUCCIONES = `
Eres Agrobot AI, asistente agrícola. Responde en español, con lenguaje simple y directo.

CUANDO RECIBAS UNA FOTO:
Analiza solo lo que se ve. Si no estás seguro, dilo. No inventes datos.
Responde CORTO, máximo 90 palabras, con exactamente este formato:

🌱 PLANTA: nombre o "No identificada".
🔎 PROBLEMA: qué podría tener, en una o dos frases.
⚠️ RIESGO: bajo, medio o alto, y por qué en una frase.
💡 QUÉ HACER: máximo 3 acciones, una línea cada una.
📌 CONFIANZA: una frase (el diagnóstico visual es orientativo).

Sin introducción ni cierre.

CUANDO EL USUARIO PREGUNTE:
Usa el diagnóstico anterior como contexto. Responde solo lo que pregunta,
en máximo 2 párrafos cortos. Si recomiendas un producto químico, menciona su
precaución principal. Sugiere un agrónomo solo si es necesario.
`;

function responder(res, status, datos) {
  return res.status(status).json(datos);
}

function textosDe(contenido) {
  return (Array.isArray(contenido) ? contenido : [])
    .filter(parte => parte && parte.type === "text" && parte.text)
    .map(parte => parte.text);
}

function obtenerTexto(interaccion) {
  if (interaccion.output_text) {
    return interaccion.output_text;
  }

  // Formato "outputs": [{ type: "text", text: "..." }]
  let textos = textosDe(interaccion.outputs);

  // Formato "steps": [{ type: "model_output", content: [...] }]
  if (!textos.length) {
    textos = (interaccion.steps || [])
      .filter(paso => paso.type === "model_output")
      .flatMap(paso => textosDe(paso.content));
  }

  return textos.join("\n").trim();
}

function armarResultado(interaccion) {
  const status = interaccion.status || "completed";

  if (status === "failed" || status === "cancelled") {
    throw new Error("Gemini no pudo completar el análisis.");
  }

  const respuesta = obtenerTexto(interaccion);

  // Respuesta directa: ya viene el texto, no hace falta esperar
  if (respuesta) {
    return {
      exito: true,
      status: "completed",
      interactionId: interaccion.id,
      respuesta: respuesta
    };
  }

  if (status === "completed") {
    console.error("Gemini terminó sin texto. Campos:", Object.keys(interaccion));
    throw new Error(
      "Gemini respondió sin texto (campos: " +
      Object.keys(interaccion).join(", ") + ")."
    );
  }

  // Respaldo: si aun no esta lista, el frontend consulta con limite de tiempo
  return {
    exito: true,
    status: status,
    interactionId: interaccion.id
  };
}

async function peticionGemini(ruta, opciones = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "No está configurada GEMINI_API_KEY en Vercel."
    );
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIEMPO_MAXIMO_MS);

  let respuesta;
  let datos;

  try {
    respuesta = await fetch(ruta, {
      ...opciones,
      signal: controlador.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        ...opciones.headers
      }
    });

    datos = await respuesta.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "Gemini tardó demasiado en responder. Intenta de nuevo."
      );
    }
    throw error;
  } finally {
    clearTimeout(temporizador);
  }

  if (!respuesta.ok) {
    console.error("Error de Gemini:", datos);

    throw new Error(
      datos.error?.message ||
      "Gemini no pudo procesar la solicitud."
    );
  }

  return datos;
}


// INICIAR UN DIAGNOSTICO

async function iniciarDiagnostico(body) {
  const imagen = body.imagen;

  if (typeof imagen !== "string") {
    throw new Error("No se recibió ninguna fotografía.");
  }

  const coincidencia = imagen.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/
  );

  if (!coincidencia) {
    throw new Error("El formato de la fotografía no es válido.");
  }

  if (imagen.length > 4 * 1024 * 1024) {
    throw new Error(
      "La fotografía es demasiado grande. Intenta tomar otra."
    );
  }

  const mimeType = "image/" + coincidencia[1];
  const base64 = coincidencia[2];

  const interaccion = await peticionGemini(URL_GEMINI, {
    method: "POST",
    body: JSON.stringify({
      model: MODELO,
      store: true,

      system_instruction: INSTRUCCIONES,

      generation_config: {
        thinking_level: "low",
        max_output_tokens: 900
      },

      input: [
        {
          type: "image",
          mime_type: mimeType,
          data: base64
        },
        {
          type: "text",
          text:
            "Analiza esta fotografía y realiza un diagnóstico agrícola " +
            "completo siguiendo tus instrucciones. Presenta el resultado " +
            "con títulos claros y recomendaciones prácticas."
        }
      ]
    })
  });

  if (!interaccion.id) {
    throw new Error(
      "Gemini no devolvió el identificador del análisis."
    );
  }

  return armarResultado(interaccion);
}


// CONSULTAR EL ESTADO DEL ANALISIS

async function consultarEstado(body) {
  const id = String(body.interactionId || "");

  if (!/^v1_[A-Za-z0-9_-]+$/.test(id) && !/^int_[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("El identificador del análisis no es válido.");
  }

  const interaccion = await peticionGemini(
    URL_GEMINI + "/" + encodeURIComponent(id),
    {
      method: "GET"
    }
  );

  const status = interaccion.status || "in_progress";

  if (status === "failed" || status === "cancelled") {
    return {
      exito: false,
      status: status,
      error: "Gemini no pudo completar el análisis."
    };
  }

  if (status !== "completed") {
    return {
      exito: true,
      status: status
    };
  }

  const respuesta = obtenerTexto(interaccion);

  return {
    exito: true,
    status: "completed",
    interactionId: interaccion.id,
    respuesta: respuesta
  };
}


// CONTINUAR LA CONVERSACION

async function preguntar(body) {
  const id = String(body.interactionId || "");
  const pregunta = String(body.pregunta || "").trim();

  if (!/^v1_[A-Za-z0-9_-]+$/.test(id) && !/^int_[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("No existe un diagnóstico válido para conversar.");
  }

  if (!pregunta) {
    throw new Error("Escribe una pregunta.");
  }

  if (pregunta.length > 2000) {
    throw new Error("La pregunta es demasiado larga.");
  }

  const interaccion = await peticionGemini(URL_GEMINI, {
    method: "POST",
    body: JSON.stringify({
      model: MODELO,
      store: true,

      previous_interaction_id: id,

      system_instruction: INSTRUCCIONES,

      generation_config: {
        thinking_level: "low",
        max_output_tokens: 700
      },

      input: pregunta
    })
  });

  if (!interaccion.id) {
    throw new Error(
      "Gemini no devolvió el identificador de la conversación."
    );
  }

  return armarResultado(interaccion);
}


// CONTROLADOR PRINCIPAL

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return responder(res, 405, {
      exito: false,
      error: "Método no permitido."
    });
  }

  try {
    const body = req.body || {};

    let resultado;

    switch (body.accion) {
      case "iniciar":
        resultado = await iniciarDiagnostico(body);
        break;

      case "estado":
        resultado = await consultarEstado(body);
        break;

      case "preguntar":
        resultado = await preguntar(body);
        break;

      default:
        return responder(res, 400, {
          exito: false,
          error: "Acción no válida."
        });
    }

    return responder(res, 200, resultado);

  } catch (error) {
    console.error("Error en Agrobot AI:", error);

    return responder(res, 500, {
      exito: false,
      error: error.message || "Error interno del servidor."
    });
  }
};