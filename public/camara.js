import { api, avisarSalida, esperarRecoleccion, mantenerPantallaEncendida } from "/comun.js";

const LATIDO_MS = 2000;
const BOTON_MOSTRAR_MS = 4000;
const CONFIRMAR_DETENER_MS = 4000;
const CLAVE_ESPEJO = "camara.espejo";
const CALIDADES = {
  720: { ancho: 720, alto: 1280, maxBitrate: 3_000_000 },
  1080: { ancho: 1080, alto: 1920, maxBitrate: 5_000_000 },
};

const $ = (id) => document.getElementById(id);
const vista = $("vista");

// Espejo decidido desde la cámara principal: voltea la vista previa Y, por el latido,
// voltea también a todos los celulares que transmiten. Se recuerda en este celular.
let espejo = leerEspejo();

function leerEspejo() {
  try {
    return localStorage.getItem(CLAVE_ESPEJO) === "1";
  } catch {
    return false;
  }
}

function aplicarEspejo() {
  vista.style.transform = espejo ? "scaleX(-1)" : "";
  $("espejo").textContent = espejo ? "Espejo: sí" : "Espejo: no";
}

let flujo = null;
let pc = null;
let idCamara = null;
let reemplazada = false;
let reconectando = false;
let temporizadorLatido = null;
let temporizadorMostrar = null;
let temporizadorDetener = null;

function mostrarEstado(texto, tipo = "") {
  $("estado").textContent = texto;
  $("punto").className = `lampara ${tipo}`;
}

function mostrarError(texto) {
  $("error").textContent = texto;
  $("error").hidden = !texto;
}

function explicarErrorDeCamara(error) {
  if (error.name === "NotAllowedError") {
    return "El navegador no tiene permiso para usar la cámara. Actívalo en los ajustes del navegador y vuelve a intentarlo.";
  }
  if (error.name === "NotFoundError") return "No se encontró ninguna cámara en este dispositivo.";
  if (error.name === "NotReadableError") return "Otra app está usando la cámara. Ciérrala e inténtalo de nuevo.";
  return `No se pudo abrir la cámara: ${error.message}`;
}

function restriccionesVideo() {
  const { ancho, alto } = CALIDADES[$("calidad").value];
  const base = { facingMode: { ideal: $("lente").value }, frameRate: { ideal: 30, max: 30 } };

  // Celular en vertical: su sensor trabaja en horizontal y el navegador gira la imagen solo.
  // Pedirle 9:16 hace que recorte una franja del centro y te vea muy de cerca, así que se pide
  // la medida nativa del sensor, sin forzar la forma.
  if (matchMedia("(orientation: portrait)").matches) {
    return { ...base, width: { ideal: alto }, height: { ideal: ancho } };
  }

  // Webcam de PC (horizontal): se pide vertical como TikTok, recortando el centro, para que
  // la vista previa muestre exactamente lo que reciben los celulares.
  return { ...base, width: { ideal: ancho }, height: { ideal: alto }, aspectRatio: { ideal: 9 / 16 } };
}

// Medida del video tal como se ve (ya girado). La del sensor puede venir al revés en iPhone.
function medidaVisible() {
  const ajustes = flujo?.getVideoTracks()[0]?.getSettings() ?? {};
  return {
    ancho: vista.videoWidth || ajustes.width,
    alto: vista.videoHeight || ajustes.height,
    fps: Math.round(ajustes.frameRate ?? 0),
  };
}

function preferirH264(transceptor) {
  const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
  if (!codecs || !transceptor.setCodecPreferences) return;
  const h264 = codecs.filter((c) => /h264/i.test(c.mimeType));
  const resto = codecs.filter((c) => !/h264/i.test(c.mimeType));
  if (h264.length) transceptor.setCodecPreferences([...h264, ...resto]);
}

async function aplicarBitrate() {
  const emisor = pc?.getSenders().find((s) => s.track?.kind === "video");
  if (!emisor) return;
  const parametros = emisor.getParameters();
  if (!parametros.encodings?.length) return;
  parametros.encodings[0].maxBitrate = CALIDADES[$("calidad").value].maxBitrate;
  parametros.encodings[0].maxFramerate = 30;
  await emisor.setParameters(parametros).catch(() => {});
}

async function conectar() {
  pc?.close();
  pc = new RTCPeerConnection();
  window.__camara = { pc };

  for (const pista of flujo.getTracks()) {
    const transceptor = pc.addTransceiver(pista, { direction: "sendonly", streams: [flujo] });
    if (pista.kind === "video") preferirH264(transceptor);
  }

  await pc.setLocalDescription(await pc.createOffer());
  await esperarRecoleccion(pc);

  const { id, sdp } = await api("/api/camara", { sdp: pc.localDescription.sdp });
  // Si la persona tocó Detener mientras se conectaba, no dejamos la cámara registrada.
  if (!flujo) {
    await api("/api/salir", { id });
    return;
  }
  idCamara = id;
  await pc.setRemoteDescription({ type: "answer", sdp });
  await aplicarBitrate();
}

async function reconectar() {
  if (reconectando || reemplazada || !flujo) return;
  reconectando = true;
  mostrarEstado("Reconectando…", "espera");
  try {
    await conectar();
  } catch {
    // Se reintenta en el siguiente latido.
  } finally {
    reconectando = false;
  }
}

async function latir() {
  if (!flujo || reemplazada) return;
  const medida = { ...medidaVisible(), espejo };
  try {
    const respuesta = await api("/api/latido", { id: idCamara, detalles: medida });

    if (!respuesta.conocido && respuesta.camaraActiva) {
      detenerPorReemplazo();
      return;
    }
    if (!respuesta.conocido || pc?.connectionState === "failed" || pc?.connectionState === "closed") {
      await reconectar();
      return;
    }

    if (pc?.connectionState === "connected") {
      const n = respuesta.transmisores;
      if (n > 0) {
        mostrarEstado(`Enviando a ${n} ${n === 1 ? "celular" : "celulares"}, ${medida.ancho}×${medida.alto}`, "aire");
      } else {
        mostrarEstado("Lista, esperando celulares", "senal");
      }
      mostrarError("");
    } else {
      mostrarEstado("Conectando…", "espera");
    }
  } catch {
    mostrarEstado("Sin conexión con la PC, reintentando", "espera");
  }
}

function soltarCamara() {
  clearInterval(temporizadorLatido);
  pc?.close();
  pc = null;
  flujo?.getTracks().forEach((p) => p.stop());
  flujo = null;
  idCamara = null;
  vista.srcObject = null;
  mostrarEstado("Cámara detenida");
  mostrarControles();
  $("iniciar").hidden = false;
  $("iniciar").disabled = false;
  $("espejo").hidden = true;
  $("acciones").hidden = true;
  $("detener").hidden = true;
  $("pista").hidden = true;
  $("microfono").textContent = "Silenciar micrófono";
}

function detenerPorReemplazo() {
  reemplazada = true;
  soltarCamara();
  mostrarError("Otra cámara tomó el control. Pulsa Iniciar cámara para volver a usar esta.");
}

async function detener() {
  const id = idCamara;
  soltarCamara();
  mostrarError("");
  if (id) await api("/api/salir", { id }).catch(() => {});
}

function mostrarControles() {
  clearTimeout(temporizadorMostrar);
  $("mostrar").hidden = true;
  $("controles").hidden = false;
}

async function iniciar() {
  reemplazada = false;
  mostrarError("");
  $("iniciar").disabled = true;

  if (!navigator.mediaDevices?.getUserMedia) {
    mostrarError("Este navegador no permite usar la cámara en esta dirección. Abre el enlace del QR con https.");
    $("iniciar").disabled = false;
    return;
  }

  mostrarEstado("Abriendo cámara…", "espera");
  try {
    flujo = await navigator.mediaDevices.getUserMedia({
      video: restriccionesVideo(),
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    mostrarEstado("Cámara apagada");
    mostrarError(explicarErrorDeCamara(error));
    $("iniciar").disabled = false;
    return;
  }

  vista.srcObject = flujo;
  mantenerPantallaEncendida();

  try {
    await conectar();
  } catch (error) {
    mostrarError(`No se pudo conectar con la PC: ${error.message}. Se seguirá intentando.`);
  }

  $("iniciar").hidden = true;
  $("espejo").hidden = false;
  $("acciones").hidden = false;
  $("detener").hidden = false;
  $("pista").hidden = false;
  clearInterval(temporizadorLatido);
  temporizadorLatido = setInterval(latir, LATIDO_MS);
  latir();
}

// El iPhone no deja abrir la misma cámara dos veces: primero se suelta la actual.
async function cambiarVideo() {
  if (!flujo) return;
  const emisor = pc?.getSenders().find((s) => s.track?.kind === "video");
  const anterior = flujo.getVideoTracks()[0];
  anterior?.stop();
  try {
    const nuevo = await navigator.mediaDevices.getUserMedia({ video: restriccionesVideo() });
    const pista = nuevo.getVideoTracks()[0];
    flujo.removeTrack(anterior);
    flujo.addTrack(pista);
    await emisor?.replaceTrack(pista);
    await aplicarBitrate();
    vista.srcObject = flujo;
    mostrarError("");
  } catch (error) {
    mostrarError(explicarErrorDeCamara(error));
  }
}

$("iniciar").addEventListener("click", iniciar);
$("lente").addEventListener("change", cambiarVideo);
$("calidad").addEventListener("change", cambiarVideo);

$("espejo").addEventListener("click", () => {
  espejo = !espejo;
  try {
    localStorage.setItem(CLAVE_ESPEJO, espejo ? "1" : "0");
  } catch {
    // Sin almacenamiento solo se pierde la preferencia al recargar.
  }
  aplicarEspejo();
  latir(); // avisa de inmediato a los transmisores, sin esperar el siguiente latido
});

$("microfono").addEventListener("click", () => {
  const pista = flujo?.getAudioTracks()[0];
  if (!pista) return;
  pista.enabled = !pista.enabled;
  $("microfono").textContent = pista.enabled ? "Silenciar micrófono" : "Activar micrófono";
});

$("limpia").addEventListener("click", () => {
  $("controles").hidden = true;
});

// En pantalla limpia, un toque muestra un botón pequeño que se oculta solo.
$("lienzo").addEventListener("click", () => {
  if (!$("controles").hidden) return;
  $("mostrar").hidden = false;
  clearTimeout(temporizadorMostrar);
  temporizadorMostrar = setTimeout(() => {
    $("mostrar").hidden = true;
  }, BOTON_MOSTRAR_MS);
});
$("mostrar").addEventListener("click", mostrarControles);

// Detener corta el video de todos los lives: pide un segundo toque para evitar accidentes.
$("detener").addEventListener("click", () => {
  const boton = $("detener");
  if (!boton.dataset.confirmando) {
    boton.dataset.confirmando = "1";
    boton.textContent = "Toca otra vez para detener";
    temporizadorDetener = setTimeout(() => {
      delete boton.dataset.confirmando;
      boton.textContent = "Detener cámara";
    }, CONFIRMAR_DETENER_MS);
    return;
  }
  clearTimeout(temporizadorDetener);
  delete boton.dataset.confirmando;
  boton.textContent = "Detener cámara";
  detener();
});

aplicarEspejo();
avisarSalida(() => idCamara);
