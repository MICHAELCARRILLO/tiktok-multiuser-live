// Recibe el video de UNA cámara y copia sus paquetes a cada transmisor.
// No vuelve a comprimir el video: por eso casi no consume CPU.
import { randomUUID } from "node:crypto";
import {
  RTCPeerConnection,
  useH264,
  useNACK,
  useOPUS,
  usePLI,
  useSdesMid,
  useTransportWideCC,
  useTWCC,
} from "werift";

const ESPERA_RECOLECCION_MS = 5000;
const INTERVALO_MINIMO_CLAVE_MS = 1000;
const INTERVALO_TASA_MS = 2000;

// En red local todo es directo. Hosteado en un VPS, el video (UDP) necesita dos cosas:
//  - un rango de puertos FIJO que coincida con el mapeo de Docker (1:1), y
//  - anunciar la IP pública del VPS como candidato, porque adentro del contenedor
//    werift solo ve su IP interna (172.x), que el celular no puede alcanzar.
const IP_PUBLICA = process.env.IP_PUBLICA;
const ICE_PUERTO_MIN = Number(process.env.ICE_PUERTO_MIN ?? 0);
const ICE_PUERTO_MAX = Number(process.env.ICE_PUERTO_MAX ?? 0);

function iceComun() {
  const config = { iceServers: [], iceUseIpv6: false };
  if (IP_PUBLICA) config.iceAdditionalHostAddresses = [IP_PUBLICA];
  if (ICE_PUERTO_MIN && ICE_PUERTO_MAX) config.icePortRange = [ICE_PUERTO_MIN, ICE_PUERTO_MAX];
  return config;
}

function configuracionCamara() {
  return {
    codecs: {
      video: [useH264({ rtcpFeedback: [useNACK(), usePLI(), useTWCC()] })],
      audio: [useOPUS()],
    },
    headerExtensions: {
      video: [useSdesMid(), useTransportWideCC()],
      audio: [useSdesMid()],
    },
    ...iceComun(),
  };
}

function configuracionTransmisor() {
  return {
    codecs: {
      video: [useH264({ rtcpFeedback: [useNACK(), usePLI()] })],
      audio: [useOPUS()],
    },
    headerExtensions: {
      video: [useSdesMid()],
      audio: [useSdesMid()],
    },
    ...iceComun(),
  };
}

// El navegador arranca suponiendo 300 kbps y baja la resolución para caber ahí.
// Le indicamos tasas realistas para una red local solo en la línea de H264 de la respuesta.
function fijarTasasDeVideo(sdp) {
  const pistaH264 = sdp.match(/a=rtpmap:(\d+) H264\/90000/i);
  if (!pistaH264) return sdp;
  const tasas = "x-google-start-bitrate=2000;x-google-min-bitrate=1000;x-google-max-bitrate=5000";
  return sdp.replace(new RegExp(`a=fmtp:${pistaH264[1]} ([^\\r\\n]*)`), `a=fmtp:${pistaH264[1]} $1;${tasas}`);
}

function esperarRecoleccion(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolver) => {
    const limite = setTimeout(resolver, ESPERA_RECOLECCION_MS);
    pc.iceGatheringStateChange.subscribe((estado) => {
      if (estado === "complete") {
        clearTimeout(limite);
        resolver();
      }
    });
  });
}

export function crearRepartidor({ registrar = () => {} } = {}) {
  let camara = null;
  let generacion = 0;
  const transmisores = new Map();

  function pedirImagenCompleta() {
    if (!camara?.receptorVideo || camara.ssrcVideo === undefined) return;
    const ahora = Date.now();
    const restante = camara.ultimaClave + INTERVALO_MINIMO_CLAVE_MS - ahora;
    if (restante > 0) {
      // No se descarta: un celular que espera esta imagen se quedaría congelado.
      if (!camara.clavePendiente) {
        const solicitante = camara;
        solicitante.clavePendiente = setTimeout(() => {
          solicitante.clavePendiente = null;
          if (camara === solicitante) pedirImagenCompleta();
        }, restante);
      }
      return;
    }
    camara.ultimaClave = ahora;
    camara.receptorVideo.sendRtcpPLI(camara.ssrcVideo).catch(() => {});
  }

  function reenviar(tipo, paquete) {
    for (const transmisor of transmisores.values()) {
      if (!transmisor.conectado) continue;
      transmisor[tipo].sendRtp(paquete).catch(() => {});
    }
  }

  async function cerrarCamaraActual() {
    if (!camara) return;
    const anterior = camara;
    camara = null;
    clearInterval(anterior.temporizadorTasa);
    await anterior.pc.close().catch(() => {});
  }

  async function conectarCamara(ofertaSdp) {
    await cerrarCamaraActual();

    const pc = new RTCPeerConnection(configuracionCamara());
    const nueva = {
      id: randomUUID(),
      pc,
      conectada: false,
      ultimoLatido: Date.now(),
      ultimaClave: 0,
      receptorVideo: null,
      ssrcVideo: undefined,
      bytesVideo: 0,
      tasaKbps: 0,
      detalles: {},
      temporizadorTasa: null,
    };

    nueva.temporizadorTasa = setInterval(() => {
      nueva.tasaKbps = Math.round((nueva.bytesVideo * 8) / INTERVALO_TASA_MS);
      nueva.bytesVideo = 0;
    }, INTERVALO_TASA_MS);

    pc.onTrack.subscribe((pista) => {
      if (pista.kind === "video") {
        const transceptor = pc.getTransceivers().find((t) => t.receiver.track === pista || t.kind === "video");
        nueva.receptorVideo = transceptor?.receiver ?? null;
      }
      pista.onReceiveRtp.subscribe((paquete) => {
        if (camara !== nueva) return;
        if (pista.kind === "video") {
          nueva.bytesVideo += paquete.payload.length;
          nueva.ssrcVideo = paquete.header.ssrc;
          if (nueva.pedirClaveAlIniciar) {
            nueva.pedirClaveAlIniciar = false;
            pedirImagenCompleta();
          }
        }
        reenviar(pista.kind, paquete);
      });
    });

    pc.connectionStateChange.subscribe((estado) => {
      if (camara !== nueva) return;
      nueva.conectada = estado === "connected";
      registrar(`cámara: ${estado}`);
      if (estado === "failed" || estado === "closed") retirarCamara(nueva.id);
    });

    nueva.pedirClaveAlIniciar = true;
    camara = nueva;
    generacion += 1;

    await pc.setRemoteDescription({ type: "offer", sdp: ofertaSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await esperarRecoleccion(pc);

    return { id: nueva.id, sdp: fijarTasasDeVideo(pc.localDescription.sdp), generacion };
  }

  function retirarCamara(id) {
    if (!camara || camara.id !== id) return;
    registrar("cámara retirada");
    cerrarCamaraActual();
    generacion += 1;
  }

  async function crearTransmisor(nombre) {
    const pc = new RTCPeerConnection(configuracionTransmisor());
    const video = pc.addTransceiver("video", { direction: "sendonly" });
    const audio = pc.addTransceiver("audio", { direction: "sendonly" });
    const transmisor = {
      id: randomUUID(),
      nombre,
      pc,
      video: video.sender,
      audio: audio.sender,
      conectado: false,
      ultimoLatido: Date.now(),
      detalles: {},
    };

    video.sender.onPictureLossIndication.subscribe(pedirImagenCompleta);
    pc.connectionStateChange.subscribe((estado) => {
      transmisor.conectado = estado === "connected";
      registrar(`${nombre}: ${estado}`);
      if (estado === "connected") pedirImagenCompleta();
      if (estado === "failed" || estado === "closed") retirarTransmisor(transmisor.id);
    });

    transmisores.set(transmisor.id, transmisor);
    await pc.setLocalDescription(await pc.createOffer());
    await esperarRecoleccion(pc);

    return { id: transmisor.id, sdp: pc.localDescription.sdp, generacion };
  }

  async function aceptarRespuesta(id, respuestaSdp) {
    const transmisor = transmisores.get(id);
    if (!transmisor) return false;
    await transmisor.pc.setRemoteDescription({ type: "answer", sdp: respuestaSdp });
    return true;
  }

  function retirarTransmisor(id) {
    const transmisor = transmisores.get(id);
    if (!transmisor) return;
    transmisores.delete(id);
    transmisor.conectado = false;
    transmisor.pc.close().catch(() => {});
  }

  // Devuelve false si el servidor ya no conoce ese id (por ejemplo, tras reiniciarse).
  function latido(id, detalles = {}) {
    const destino = camara?.id === id ? camara : transmisores.get(id);
    if (!destino) return false;
    destino.ultimoLatido = Date.now();
    destino.detalles = detalles;
    return true;
  }

  function retirar(id) {
    if (camara?.id === id) retirarCamara(id);
    else retirarTransmisor(id);
  }

  function retirarInactivos(limiteMs) {
    const corte = Date.now() - limiteMs;
    if (camara && camara.ultimoLatido < corte) retirarCamara(camara.id);
    for (const transmisor of [...transmisores.values()]) {
      if (transmisor.ultimoLatido < corte) retirarTransmisor(transmisor.id);
    }
  }

  function estado() {
    return {
      generacion,
      camara: camara
        ? {
            conectada: camara.conectada,
            tasaKbps: camara.tasaKbps,
            detalles: camara.detalles,
          }
        : null,
      transmisores: [...transmisores.values()].map((t) => ({
        id: t.id,
        nombre: t.nombre,
        conectado: t.conectado,
        detalles: t.detalles,
      })),
    };
  }

  return {
    conectarCamara,
    crearTransmisor,
    aceptarRespuesta,
    latido,
    retirar,
    retirarInactivos,
    estado,
  };
}
