const MODELO = "gemini-3.8-flash";

const URL_GEMINI =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const INSTRUCCIONES = `
Eres Agrobot AI, un asistente agrícola inteligente.

Tu objetivo es ayudar a agricultores a comprender el estado de sus
cultivos mediante fotografías y conversaciones.

Cuando recibas una fotografía:
1. Identifica la planta si es posible.
2. Examina las hojas, tallos, flores y frutos visibles.
3. Identifica posibles enfermedades o plagas.
4. Describe los síntomas observados.
5. Explica las posibles causas.
6. Indica el nivel de riesgo: bajo, medio o alto.
7. Recomienda tratamientos y medidas preventivas.

Cuando converses con el usuario:
- Recuerda el diagnóstico anterior.
- Responde teniendo en cuenta la planta analizada.
- Explica los tratamientos de manera sencilla.
- Responde siempre en español.
- Evita respuestas excesivamente técnicas.
- No inventes información.

IMPORTANTE:
Un diagnóstico visual no es una confirmación definitiva.
Si la fotografía no permite identificar el problema, dilo claramente.
No recomiendes productos químicos sin explicar precauciones.
Recomienda consultar a un agrónomo cuando sea necesario.
`;

function responder(res, status, datos) {
  return res.status(status).json(datos);
}

function obtenerTexto(interaccion) {
  if (interaccion.output_text) {
    return interaccion.output_text;
  }

  const pasos = interaccion.steps || [];

  const resultados = pasos
    .filter(paso => paso.type === "model_output")
    .flatMap(paso => paso.content || [])
    .filter(parte => parte.type === "text" && parte.text)
    .map(parte => parte.text);

  return resultados.join("\n").trim();
}

async function peticionGemini(ruta, opciones = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "No está configurada GEMINI_API_KEY en Vercel."
    );
  }

  const respuesta = await fetch(ruta, {
    ...opciones,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      ...opciones.headers
    }
  });

  const datos = await respuesta.json();

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
      background: true,
      store: true,

      system_instruction: INSTRUCCIONES,

      generation_config: {
        max_output_tokens: 1800
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

  return {
    exito: true,
    interactionId: interaccion.id,
    status: interaccion.status || "in_progress"
  };
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
      background: true,
      store: true,

      previous_interaction_id: id,

      system_instruction: INSTRUCCIONES,

      generation_config: {
        max_output_tokens: 1200
      },

      input: pregunta
    })
  });

  if (!interaccion.id) {
    throw new Error(
      "Gemini no devolvió el identificador de la conversación."
    );
  }

  return {
    exito: true,
    interactionId: interaccion.id,
    status: interaccion.status || "in_progress"
  };
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