const MODELO = "gemini-3.8-flash";

const INSTRUCCIONES = `
Eres Agrobot AI, un asistente experto en agricultura.

Analiza imágenes de plantas para identificar:
- Enfermedades.
- Plagas.
- Síntomas visibles.
- Posibles causas.
- Tratamientos recomendados.
- Medidas de prevención.

Responde siempre en español, de forma clara, breve y práctica.

No inventes diagnósticos. Si no tienes suficiente información,
indica que se necesita una revisión adicional.
Nunca afirmes que un diagnóstico visual es 100% seguro.
`;

function responder(res, status, data) {
  return res.status(status).json(data);
}

function obtenerImagenes(body) {
  if (!Array.isArray(body.imagenes)) return [];

  return body.imagenes
    .filter(imagen =>
      typeof imagen === "string" &&
      /^data:image\/(jpeg|jpg|png|webp);base64,/.test(imagen)
    )
    .slice(0, 2);
}

function convertirImagen(imagen) {
  const coincidencia = imagen.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/
  );

  if (!coincidencia) {
    throw new Error("Formato de imagen inválido.");
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
    throw new Error("Falta configurar GEMINI_API_KEY en Vercel.");
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    MODELO +
    ":generateContent?key=" +
    apiKey;

  const controlador = new AbortController();

  const temporizador = setTimeout(() => {
    controlador.abort();
  }, 45000);

  try {
    const respuesta = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: INSTRUCCIONES }]
        },
        contents: [{
          role: "user",
          parts: contenido
        }],
        generationConfig: {
          maxOutputTokens: 900,
          thinkingConfig: {
            thinkingLevel: "low"
          }
        }
      }),
      signal: controlador.signal
    });

    const datos = await respuesta.json();

    if (!respuesta.ok) {
      throw new Error(
        datos.error?.message || "Error al consultar Gemini."
      );
    }

    const texto = datos.candidates?.[0]?.content?.parts
      ?.map(parte => parte.text || "")
      .join("\n")
      .trim();

    if (!texto) {
      throw new Error("Gemini no generó una respuesta.");
    }

    return texto;

  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "Gemini tardó demasiado. Intenta nuevamente."
      );
    }

    throw error;

  } finally {
    clearTimeout(temporizador);
  }
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
          error: "Debes enviar una imagen válida."
        });
      }

      for (const imagen of imagenes) {
        if (imagen.length > 7 * 1024 * 1024) {
          return responder(res, 413, {
            error: "La imagen es demasiado grande."
          });
        }

        contenido.push(convertirImagen(imagen));
      }

      contenido.push({
        text: modo === "detectar"
          ? "Identifica la planta y describe brevemente su estado."
          : "Realiza un diagnóstico de la planta. Identifica síntomas, posibles enfermedades o plagas, causas, nivel de riesgo y recomendaciones de tratamiento y prevención."
      });

    } else if (modo === "preguntar") {
      const pregunta = String(body.pregunta || "").trim();

      if (!pregunta || pregunta.length > 2000) {
        return responder(res, 400, {
          error: "La pregunta está vacía o es demasiado larga."
        });
      }

      contenido.push({ text: pregunta });

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
    console.error("Error Agrobot AI:", error);

    return responder(res, error.name === "AbortError" ? 504 : 500, {
      exito: false,
      error: error.message || "Error interno del servidor."
    });
  }
};