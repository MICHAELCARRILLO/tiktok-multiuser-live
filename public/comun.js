// Utilidades compartidas por las páginas de cámara y transmisor.
export const token = new URLSearchParams(location.search).get("t") ?? "";

export async function api(ruta, cuerpo = {}) {
  const respuesta = await fetch(ruta, {
    method: "POST",
    headers: { "content-type": "application/json", "x-token": token },
    body: JSON.stringify(cuerpo),
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(datos.error ?? `Error ${respuesta.status}`);
  return datos;
}

// Avisa al servidor al cerrar la página. "keepalive" deja terminar el envío.
export function avisarSalida(obtenerId) {
  addEventListener("pagehide", () => {
    const id = obtenerId();
    if (!id) return;
    fetch("/api/salir", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json", "x-token": token },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  });
}

// Espera a reunir las direcciones de red. Si tarda, sigue con las que ya tenga.
export function esperarRecoleccion(pc, limiteMs = 3000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolver) => {
    const terminar = () => {
      clearTimeout(limite);
      pc.removeEventListener("icegatheringstatechange", alCambiar);
      resolver();
    };
    const alCambiar = () => {
      if (pc.iceGatheringState === "complete") terminar();
    };
    const limite = setTimeout(terminar, limiteMs);
    pc.addEventListener("icegatheringstatechange", alCambiar);
  });
}

// Evita que el celular apague la pantalla. Si no hay soporte, no pasa nada grave:
// por eso las instrucciones piden desactivar el bloqueo automático.
export function mantenerPantallaEncendida() {
  let bloqueo = null;
  const pedir = async () => {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || bloqueo) return;
    try {
      bloqueo = await navigator.wakeLock.request("screen");
      bloqueo.addEventListener("release", () => {
        bloqueo = null;
      });
    } catch {
      // El navegador lo rechazó: seguimos sin bloqueo de pantalla.
    }
  };
  document.addEventListener("visibilitychange", pedir);
  pedir();
}

export async function pedirPantallaCompleta(video) {
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
      return true;
    }
    if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
      return true;
    }
  } catch {
    // Algunos navegadores lo rechazan; la página sigue funcionando sin ello.
  }
  return false;
}
