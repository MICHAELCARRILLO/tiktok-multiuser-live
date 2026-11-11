import {
  api,
  avisarSalida,
  esperarRecoleccion,
  mantenerPantallaEncendida,
  pedirPantallaCompleta,
} from "/comun.js";

const LATIDO_MS = 2000;
const INFO_VISIBLE_MS = 4000;

const $ = (id) => document.getElementById(id);
const video = $("video");

// El espejo lo decide la cámara principal: aquí solo se obedece lo que llega en el latido.
let espejo = false;

function aplicarEspejo(valor) {
  if (valor === espejo) return;
  espejo = valor;
  video.style.transform = espejo ? "scaleX(-1)" : "";
}

let pc = null;
let idTransmisor = null;
let generacionConectada = null;
let conectando = false;
let temporizadorInfo = null;
let temporizadorLatido = null;

// Avisa a la PC que deje de mandar video a la conexión anterior; si no, la PC
// seguiría enviándole video unos segundos y el panel la contaría dos veces.
function soltarRegistro() {
  if (!idTransmisor) return;
  api("/api/salir", { id: idTransmisor }).catch(() => {});
  idTransmisor = null;
}

function cerrarConexion() {
  pc?.close();
  pc = null;
  soltarRegistro();
  generacionConectada = null;
  video.srcObject = null;
}

async function conectar() {
  if (conectando) return;
  conectando = true;
  try {
    pc?.close();
    soltarRegistro();
    const conexion = new RTCPeerConnection();
    pc = conexion;
    window.__transmisor = { pc: conexion };

    const flujo = new MediaStream();
    conexion.ontrack = ({ track }) => {
      flujo.addTrack(track);
      video.srcObject = flujo;
      video.play().catch(() => {});
    };

    const oferta = await api("/api/transmisor");
    idTransmisor = oferta.id;
    generacionConectada = oferta.generacion;

    await conexion.setRemoteDescription({ type: "offer", sdp: oferta.sdp });
    await conexion.setLocalDescription(await conexion.createAnswer());
    await esperarRecoleccion(conexion);
    await api("/api/transmisor/respuesta", { id: oferta.id, sdp: conexion.localDescription.sdp });
  } finally {
    conectando = false;
  }
}

async function latir() {
  try {
    const estado = await api("/api/latido", { id: idTransmisor });

    if (!estado.camaraActiva) {
      if (pc) cerrarConexion();
      $("espera").hidden = false;
      return;
    }
    $("espera").hidden = true;
    aplicarEspejo(Boolean(estado.espejoCamara));

    const caida = pc?.connectionState === "failed" || pc?.connectionState === "closed";
    if (!pc || !estado.conocido || caida || estado.generacion !== generacionConectada) {
      await conectar();
    }
  } catch {
    // La PC no responde: el video queda en su último cuadro y se reintenta en el siguiente latido.
  }
}

const ESTADOS = {
  connected: { texto: "Recibiendo la cámara", lampara: "senal" },
  connecting: { texto: "Conectando", lampara: "espera" },
  new: { texto: "Conectando", lampara: "espera" },
  disconnected: { texto: "Reconectando", lampara: "espera" },
};

function mostrarInfo() {
  const estado = ESTADOS[pc?.connectionState] ?? { texto: "Sin cámara", lampara: "" };
  const tamano = video.videoWidth ? `, ${video.videoWidth}×${video.videoHeight}` : "";
  $("infoLampara").className = `lampara ${estado.lampara}`;
  $("infoTexto").textContent = `${estado.texto}${tamano}`;
  $("info").hidden = false;
  clearTimeout(temporizadorInfo);
  temporizadorInfo = setTimeout(() => {
    $("info").hidden = true;
  }, INFO_VISIBLE_MS);
}

$("empezar").addEventListener("click", () => {
  $("portada").hidden = true;
  // El sonido solo se puede activar después de un toque del usuario.
  video.muted = false;
  video.play().catch(() => {});
  mantenerPantallaEncendida();
  pedirPantallaCompleta(video);
  clearInterval(temporizadorLatido);
  temporizadorLatido = setInterval(latir, LATIDO_MS);
  latir();
});

$("completa").addEventListener("click", () => pedirPantallaCompleta(video));

$("detener").addEventListener("click", () => {
  clearInterval(temporizadorLatido);
  clearTimeout(temporizadorInfo);
  cerrarConexion();
  $("info").hidden = true;
  $("espera").hidden = true;
  $("portada").hidden = false;
});

$("lienzo").addEventListener("click", mostrarInfo);
avisarSalida(() => idTransmisor);
