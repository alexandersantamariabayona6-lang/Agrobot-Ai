const MODELO = "gemini-3.8-flash";

const INSTRUCCIONES = `
Eres Agrobot AI, un asistente especializado en agricultura.

Tu función es ayudar a agricultores a identificar problemas en sus cultivos
y brindar recomendaciones prácticas.

Debes:
- Identificar posibles enfermedades en las plantas.
- Reconocer plagas y daños visibles.
- Analizar síntomas como manchas, hojas amarillas y marchitamiento.
- Recomendar posibles tratamientos.
- Dar recomendaciones preventivas.
- Explicar tus respuestas en español sencillo.

IMPORTANTE:
No afirmes que un diagnóstico es 100% seguro solamente con una fotografía.
Si no tienes suficiente información, indícalo claramente.
No inventes enfermedades ni tratamientos.
Recomienda consultar a un profesional agrícola cuando sea necesario.
`;

function responder(res, status, data) {
  return res.status(status).json(data);
}

function obtenerImagenes(body) {
  if (!Array.isArray(body.imagenes)) {
    return [];
  }

  return body.imagenes
    .filter(imagen =>
      typeof imagen === "string" &&
      /^data:image\/(jpeg|jpg|png|webp);base64,/.test(imagen)
    )
    .slice(0, 4);
}

function convertirImagen(imagen) {
  const coincidencia = imagen.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/
  );

  if (!coincidencia) {
    throw new Error("Formato de imagen no válido.");
  }

  return {
    inline_data: {
      mime_type: "image/" + coincidencia[1],
      data: coincidencia[2]
    }
  };
}

async function consultarGemini(contenido) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("No está configurada la variable GEMINI_API_KEY.");
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    MODELO +
    ":generateContent?key=" +
    apiKey;

  const respuesta = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [
          {
            text: INSTRUCCIONES
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts: contenido
        }
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 1500
      }
    })
  });

  const datos = await respuesta.json();

  if (!respuesta.ok) {
    const mensaje =
      datos.error?.message ||
      "No fue posible consultar el servicio de inteligencia artificial.";

    const error = new Error(mensaje);
    error.status = respuesta.status;
    throw error;
  }

  const texto = datos.candidates?.[0]?.content?.parts
    ?.map(parte => parte.text || "")
    .join("\n")
    .trim();

  if (!texto) {
    throw new Error("La inteligencia artificial no generó una respuesta.");
  }

  return texto;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return responder(res, 405, {
      error: "Método no permitido."
    });
  }

  try {
    const body = req.body || {};
    const modo = body.modo;

    let contenido = [];

    if (modo === "diagnosticar" || modo === "detectar") {
      const imagenes = obtenerImagenes(body);

      if (imagenes.length === 0) {
        return responder(res, 400, {
          error: "Debes enviar al menos una imagen válida."
        });
      }

      for (const imagen of imagenes) {
        if (imagen.length > 7 * 1024 * 1024) {
          return responder(res, 413, {
            error: "Una de las imágenes es demasiado grande."
          });
        }

        contenido.push(convertirImagen(imagen));
      }

      const instruccion = modo === "detectar"
        ? "Observa la imagen e identifica qué planta o cultivo aparece. Describe brevemente su estado visible y posibles problemas."
        : "Realiza un diagnóstico agrícola de las imágenes proporcionadas. Identifica la planta si es posible, describe los síntomas visibles, posibles enfermedades o plagas, causas probables, nivel de riesgo y recomendaciones de tratamiento y prevención. Aclara qué tan seguro es el diagnóstico.";

      contenido.push({
        text: instruccion
      });

    } else if (modo === "preguntar") {
      const pregunta = String(body.pregunta || "").trim();

      if (!pregunta) {
        return responder(res, 400, {
          error: "Debes escribir una pregunta."
        });
      }

      if (pregunta.length > 2000) {
        return responder(res, 400, {
          error: "La pregunta es demasiado larga."
        });
      }

      contenido.push({
        text: pregunta
      });

    } else {
      return responder(res, 400, {
        error: "Modo de operación no válido."
      });
    }

    const resultado = await consultarGemini(contenido);

    return responder(res, 200, {
      exito: true,
      respuesta: resultado
    });

  } catch (error) {
    console.error("Error en Agrobot AI:", error);

    return responder(res, error.status || 500, {
      exito: false,
      error: error.message || "Error interno del servidor."
    });
  }
};