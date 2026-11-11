// Prueba de punta a punta con Chrome real y cámara simulada:
//   cámara -> servidor -> 2 transmisores (uno entra tarde), más reconexión de la cámara.
// Levanta su propio servidor en puertos aparte, con datos temporales. Se ejecuta con: npm run prueba
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUERTO_HTTPS = 18443;
const PUERTO_PANEL = 18080;
const DATOS = fs.mkdtempSync(path.join(os.tmpdir(), "reparto-prueba-"));

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));
const resultados = [];

function comprobar(nombre, correcto, detalle = "") {
  resultados.push(correcto);
  console.log(`${correcto ? "OK   " : "FALLA"}  ${nombre}${detalle ? `  (${detalle})` : ""}`);
}

async function esperarHasta(condicion, limiteMs, pausaMs = 250) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    const valor = await condicion().catch(() => null);
    if (valor) return valor;
    await esperar(pausaMs);
  }
  return null;
}

async function medirTransmisor(pagina, milisegundos = 3000) {
  const medir = () =>
    pagina.evaluate(async () => {
      const video = document.getElementById("video");
      const reporte = await window.__transmisor.pc.getStats();
      let audio = 0;
      let bytesAudio = 0;
      let codec = "";
      let idCodec = "";
      reporte.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "audio") {
          audio = r.packetsReceived;
          bytesAudio = r.bytesReceived;
        }
        if (r.type === "inbound-rtp" && r.kind === "video") idCodec = r.codecId;
      });
      if (idCodec) codec = reporte.get(idCodec)?.mimeType ?? "";
      return {
        ancho: video.videoWidth,
        alto: video.videoHeight,
        tiempo: video.currentTime,
        cuadros: video.getVideoPlaybackQuality().totalVideoFrames,
        silenciado: video.muted,
        audio,
        bytesAudio,
        codec,
      };
    });
  const antes = await medir();
  await esperar(milisegundos);
  const despues = await medir();
  return {
    ...despues,
    cuadrosNuevos: despues.cuadros - antes.cuadros,
    audioNuevo: despues.audio - antes.audio,
    fps: (despues.cuadros - antes.cuadros) / (milisegundos / 1000),
  };
}

async function abrirTransmisor(contexto, enlace) {
  const pagina = await contexto.newPage();
  await pagina.goto(enlace);
  await pagina.click("#empezar");
  return pagina;
}

const servidor = spawn(process.execPath, ["src/servidor.js"], {
  cwd: RAIZ,
  env: { ...process.env, PUERTO_HTTPS: String(PUERTO_HTTPS), PUERTO_PANEL: String(PUERTO_PANEL), DATOS },
  stdio: ["ignore", "pipe", "pipe"],
});
let salidaServidor = "";
servidor.stdout.on("data", (d) => (salidaServidor += d));
servidor.stderr.on("data", (d) => (salidaServidor += d));

let navegador;
try {
  const panelListo = await esperarHasta(async () => {
    const r = await fetch(`http://127.0.0.1:${PUERTO_PANEL}/api/panel`);
    return r.ok ? r.json() : null;
  }, 30000);
  comprobar("El servidor arranca y responde el panel", Boolean(panelListo));
  if (!panelListo) throw new Error(`El servidor no arrancó:\n${salidaServidor}`);

  const lan = panelListo.enlaces.find((e) => e.etiqueta.includes("WiFi")) ?? panelListo.enlaces[0];
  console.log(`      Red de prueba: ${lan.ip}`);

  const sinToken = await fetch(`http://127.0.0.1:${PUERTO_PANEL}/api/latido`, { method: "POST", body: "{}" });
  comprobar("La API rechaza peticiones sin token", sinToken.status === 401, `HTTP ${sinToken.status}`);

  navegador = await chromium.launch({
    // Edge: en esta PC, Chrome tiene una política que bloquea WebRTC por UDP (WebRtcIPHandling).
    channel: "msedge",
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const contextoCamara = await navegador.newContext({ ignoreHTTPSErrors: true, permissions: ["camera", "microphone"] });
  const contextoCelulares = await navegador.newContext({ ignoreHTTPSErrors: true });

  const camara = await contextoCamara.newPage();
  await camara.goto(lan.camara);
  await camara.click("#iniciar");

  const estadoServidor = () => fetch(`http://127.0.0.1:${PUERTO_PANEL}/api/panel`).then((r) => r.json());

  camara.on("console", (m) => console.log(`      [consola cámara] ${m.text()}`));
  camara.on("pageerror", (e) => console.log(`      [error cámara] ${e.message}`));

  const camaraConectada = await esperarHasta(async () => (await estadoServidor()).camara?.conectada, 20000);
  comprobar("La cámara se conecta a la PC", Boolean(camaraConectada));
  if (!camaraConectada) {
    const diagnostico = await camara.evaluate(async () => ({
      estado: document.getElementById("estado").textContent,
      error: document.getElementById("error").textContent,
      conexion: window.__camara?.pc.connectionState,
      ice: window.__camara?.pc.iceConnectionState,
      recoleccion: window.__camara?.pc.iceGatheringState,
      local: window.__camara?.pc.localDescription?.sdp,
      remoto: window.__camara?.pc.remoteDescription?.sdp,
      transporte: window.__camara ? [...(await window.__camara.pc.getStats()).values()].filter((r) => ["transport", "candidate-pair", "local-candidate", "remote-candidate"].includes(r.type)).map((r) => ({ tipo: r.type, estado: r.state ?? r.iceState ?? r.dtlsState, dtls: r.dtlsState, ip: r.address, puerto: r.port, candidato: r.candidateType, enviados: r.requestsSent, recibidos: r.responsesReceived })) : null,
    }));
    console.log("      Diagnóstico de la cámara:", JSON.stringify(diagnostico, null, 2));
    console.log("      Registro del servidor:\n" + salidaServidor);
    throw new Error("La cámara no se conectó");
  }

  const celular1 = await abrirTransmisor(contextoCelulares, lan.transmisor);
  const primerCuadro = await esperarHasta(() => celular1.evaluate(() => document.getElementById("video").videoWidth > 0), 20000);
  comprobar("El transmisor 1 recibe imagen", Boolean(primerCuadro));

  await esperar(6000);
  const celular2 = await abrirTransmisor(contextoCelulares, lan.transmisor);
  const inicioTarde = Date.now();
  const llegadaTarde = await esperarHasta(() => celular2.evaluate(() => document.getElementById("video").videoWidth > 0), 20000);
  comprobar("El transmisor 2 entra tarde y recibe imagen", Boolean(llegadaTarde), `${((Date.now() - inicioTarde) / 1000).toFixed(1)} s`);

  await esperar(4000);
  for (const [nombre, pagina] of [["1", celular1], ["2", celular2]]) {
    const m = await medirTransmisor(pagina);
    comprobar(`Transmisor ${nombre}: el video avanza`, m.cuadrosNuevos > 10, `${m.ancho}×${m.alto}, ${m.fps.toFixed(1)} fps, ${m.codec}`);
    comprobar(`Transmisor ${nombre}: llega audio con sonido activado`, m.audioNuevo > 20 && !m.silenciado, `${m.audioNuevo} paquetes nuevos`);
  }

  const envio = await camara.evaluate(async () => {
    const reporte = await window.__camara.pc.getStats();
    let disponible = 0;
    let salida = {};
    reporte.forEach((r) => {
      if (r.type === "candidate-pair" && r.nominated && r.availableOutgoingBitrate) disponible = r.availableOutgoingBitrate;
      if (r.type === "outbound-rtp" && r.kind === "video") salida = r;
    });
    const pista = window.__camara.pc.getSenders().find((s) => s.track?.kind === "video")?.track;
    return {
      disponible,
      objetivo: salida.targetBitrate ?? 0,
      ancho: salida.frameWidth,
      alto: salida.frameHeight,
      limitacion: salida.qualityLimitationReason,
      captura: pista?.getSettings(),
    };
  });
  const estado = await estadoServidor();
  console.log(
    `      Cámara: captura ${envio.captura?.width}×${envio.captura?.height}, envía ${envio.ancho}×${envio.alto}, ` +
      `límite: ${envio.limitacion}, objetivo ${(envio.objetivo / 1e6).toFixed(2)} Mbps, recibido ${estado.camara?.tasaKbps} kbps`,
  );
  comprobar("El ancho de banda estimado no cae del mínimo de 1 Mbps", envio.disponible >= 1_000_000, `${(envio.disponible / 1e6).toFixed(2)} Mbps`);
  comprobar("La cámara envía la resolución completa", envio.ancho === envio.captura?.width, `${envio.ancho}×${envio.alto}`);
  comprobar(
    "El panel lista 2 transmisores conectados",
    estado.transmisores.filter((t) => t.conectado).length === 2,
  );

  // Reconexión: la cámara se cae y vuelve; los transmisores deben recuperarse solos.
  const cuadrosAntes = await celular1.evaluate(() => document.getElementById("video").getVideoPlaybackQuality().totalVideoFrames);
  await camara.reload();
  await camara.click("#iniciar");
  await esperarHasta(async () => (await estadoServidor()).camara?.conectada, 20000);
  const recuperado = await esperarHasta(
    () =>
      celular1.evaluate((previos) => {
        const video = document.getElementById("video");
        const q = video.getVideoPlaybackQuality().totalVideoFrames;
        return video.videoWidth > 0 && window.__transmisor.pc.connectionState === "connected" && (q > 10 || q > previos);
      }, cuadrosAntes),
    25000,
  );
  comprobar("Los transmisores se recuperan si la cámara se reconecta", Boolean(recuperado));
  await esperar(4000);
  const trasReconectar = await medirTransmisor(celular2);
  comprobar("Tras reconectar, el video sigue avanzando", trasReconectar.cuadrosNuevos > 10, `${trasReconectar.fps.toFixed(1)} fps`);
  // Sin registros fantasma: los celulares que se reconectan no se cuentan dos veces.
  const tras = (await estadoServidor()).transmisores.length;
  comprobar("Tras reconectar, el panel cuenta solo 2 celulares", tras === 2, `${tras} en el panel`);

  // Webcam de la PC: entra por el panel local y toma el control sin pelear con la otra cámara.
  await celular1.evaluate(() => {
    window.__conexionAnterior = window.__transmisor.pc;
  });
  const webcam = await contextoCamara.newPage();
  await webcam.goto(`http://127.0.0.1:${PUERTO_PANEL}${panelListo.camaraLocal}`);
  await webcam.click("#iniciar");
  const avisoReemplazo = await esperarHasta(
    () => camara.evaluate(() => document.getElementById("error").textContent.includes("Otra cámara")),
    15000,
  );
  comprobar("La cámara anterior cede el control y avisa", Boolean(avisoReemplazo));
  const cambio = await esperarHasta(
    () =>
      celular1.evaluate(
        () =>
          window.__transmisor.pc !== window.__conexionAnterior &&
          window.__transmisor.pc.connectionState === "connected" &&
          document.getElementById("video").videoWidth > 0,
      ),
    20000,
  );
  comprobar("Los transmisores pasan a la nueva cámara", Boolean(cambio));
  await esperar(4000);
  const conWebcam = await medirTransmisor(celular1);
  comprobar("Con la webcam local el video avanza", conWebcam.cuadrosNuevos > 10, `${conWebcam.fps.toFixed(1)} fps`);
  const sigueMisma = await esperarHasta(
    () => webcam.evaluate(() => document.getElementById("error").hidden && window.__camara.pc.connectionState === "connected"),
    5000,
  );
  comprobar("Las dos cámaras no se quitan el control entre sí", Boolean(sigueMisma));

  // Salida: al cerrar un celular, el panel deja de listarlo.
  await celular2.close({ runBeforeUnload: true });
  const salio = await esperarHasta(async () => (await estadoServidor()).transmisores.length === 1, 20000);
  comprobar("El panel quita el celular que se cierra", Boolean(salio));

  // Pantalla limpia: se oculta, un toque ofrece el botón y este devuelve los controles.
  await webcam.click("#limpia");
  const controlesOcultos = await webcam.locator("#controles").isHidden();
  await webcam.click("#lienzo");
  await webcam.click("#mostrar");
  const controlesVisibles = await webcam.locator("#controles").isVisible();
  comprobar("Se puede salir de pantalla limpia con un toque", controlesOcultos && controlesVisibles);

  // Detener transmisor: sale del panel y vuelve a la portada.
  await celular1.click("#lienzo");
  await celular1.click("#detener");
  const transmisorFuera = await esperarHasta(async () => (await estadoServidor()).transmisores.length === 0, 10000);
  const portadaVisible = await celular1.locator("#portada").isVisible();
  comprobar("El transmisor se detiene y vuelve a la portada", Boolean(transmisorFuera) && portadaVisible);

  // Detener cámara: el primer toque solo pide confirmar; el segundo la detiene y permite reiniciar.
  await webcam.click("#detener");
  await esperar(500);
  const sigueActiva = Boolean((await estadoServidor()).camara?.conectada);
  await webcam.click("#detener");
  const camaraFuera = await esperarHasta(async () => (await estadoServidor()).camara === null, 10000);
  const pistasApagadas = await webcam.evaluate(() => document.getElementById("vista").srcObject === null);
  comprobar("Detener cámara pide confirmar y luego la detiene", sigueActiva && Boolean(camaraFuera) && pistasApagadas);
  await webcam.click("#iniciar");
  const volvio = await esperarHasta(async () => (await estadoServidor()).camara?.conectada, 15000);
  comprobar("La cámara se puede volver a iniciar tras detenerla", Boolean(volvio));
} catch (error) {
  comprobar("La prueba terminó sin errores", false, error.message);
} finally {
  await navegador?.close().catch(() => {});
  servidor.kill();
  fs.rmSync(DATOS, { recursive: true, force: true });
}

const errores = salidaServidor.split("\n").filter((l) => /Error|rechazada/i.test(l));
if (errores.length) {
  console.log("\nErrores en el registro del servidor:");
  console.log(errores.slice(0, 15).join("\n"));
}
const fallas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - fallas}/${resultados.length} comprobaciones correctas`);
process.exit(fallas ? 1 : 0);
