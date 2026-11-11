// Servidor local:
//  - Panel para la PC en http://127.0.0.1:PUERTO_PANEL (solo esta PC).
//  - Páginas de cámara y transmisor en https://IP:PUERTO_HTTPS (red local; piden token).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { generate as generarCertificado } from "selfsigned";
import { crearRepartidor } from "./reparto.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARPETA_PUBLICA = path.join(RAIZ, "public");
const CARPETA_DATOS = process.env.DATOS ?? path.join(RAIZ, "data");
const PUERTO_HTTPS = Number(process.env.PUERTO_HTTPS ?? 8443);
const PUERTO_PANEL = Number(process.env.PUERTO_PANEL ?? 8080);
// Si está URL_PUBLICA, la app corre hosteada en un VPS detrás de Caddy (HTTPS real):
// un solo servidor HTTP plano, y el panel se protege con el token en vez de "solo esta PC".
const URL_PUBLICA = process.env.URL_PUBLICA;
const PUERTO_APP = Number(process.env.PUERTO_APP ?? 8099);
const LIMITE_CUERPO_BYTES = 1024 * 1024;
const LIMITE_INACTIVIDAD_MS = 15000;

const PAGINAS = {
  "/": "panel.html",
  "/camara": "camara.html",
  "/transmisor": "transmisor.html",
};

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const ARCHIVOS_PUBLICOS = new Set(["comun.css", "comun.js", "camara.js", "transmisor.js", "panel.js"]);

// La fuente viene instalada con la app: así se ve igual aunque un celular no tenga internet.
const ARCHIVO_FUENTE = path.join(
  RAIZ,
  "node_modules",
  "@fontsource-variable",
  "archivo",
  "files",
  "archivo-latin-wdth-normal.woff2",
);

function registrar(mensaje) {
  console.log(`[${new Date().toLocaleTimeString("es-PE")}] ${mensaje}`);
}

function direccionesLocales() {
  const direcciones = [];
  for (const [nombre, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const interfaz of interfaces ?? []) {
      if (interfaz.family !== "IPv4" || interfaz.internal) continue;
      direcciones.push({ ip: interfaz.address, ...clasificarDireccion(interfaz.address, nombre) });
    }
  }
  return direcciones.sort((a, b) => a.prioridad - b.prioridad);
}

function clasificarDireccion(ip, nombre) {
  if (/virtualbox|vmware|vethernet|wsl|hyper-v/i.test(nombre) || ip.startsWith("192.168.56.")) {
    return { etiqueta: `${ip} — adaptador virtual`, prioridad: 3 };
  }
  const [a, b] = ip.split(".").map(Number);
  if (a === 100 && b >= 64 && b <= 127) {
    return { etiqueta: `${ip} — Tailscale (sin probar)`, prioridad: 2 };
  }
  if (ip.startsWith("192.168.") || a === 10 || (a === 172 && b >= 16 && b <= 31)) {
    return { etiqueta: `${ip} — WiFi / red de casa`, prioridad: 1 };
  }
  return { etiqueta: ip, prioridad: 2 };
}

function cargarToken() {
  const archivo = path.join(CARPETA_DATOS, "config.json");
  if (fs.existsSync(archivo)) return JSON.parse(fs.readFileSync(archivo, "utf8")).token;
  const token = randomBytes(16).toString("hex");
  fs.writeFileSync(archivo, JSON.stringify({ token }, null, 2));
  return token;
}

async function cargarCertificado(ips) {
  const archivoCert = path.join(CARPETA_DATOS, "certificado.pem");
  const archivoClave = path.join(CARPETA_DATOS, "clave.pem");
  const archivoIps = path.join(CARPETA_DATOS, "certificado-ips.json");
  const firma = JSON.stringify([...ips].sort());

  const vigente =
    fs.existsSync(archivoCert) &&
    fs.existsSync(archivoClave) &&
    fs.existsSync(archivoIps) &&
    fs.readFileSync(archivoIps, "utf8") === firma;
  if (vigente) {
    return { cert: fs.readFileSync(archivoCert), key: fs.readFileSync(archivoClave) };
  }

  registrar("Generando certificado local…");
  const vence = new Date();
  vence.setFullYear(vence.getFullYear() + 2);
  const resultado = await generarCertificado([{ name: "commonName", value: "tiktok-multiuser-live" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: vence,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [{ type: 2, value: "localhost" }, ...ips.map((ip) => ({ type: 7, ip }))],
      },
    ],
  });
  fs.writeFileSync(archivoCert, resultado.cert);
  fs.writeFileSync(archivoClave, resultado.private);
  fs.writeFileSync(archivoIps, firma);
  return { cert: resultado.cert, key: resultado.private };
}

function responderJson(res, codigo, datos) {
  res.writeHead(codigo, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(datos));
}

function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    let total = 0;
    const partes = [];
    req.on("data", (parte) => {
      total += parte.length;
      if (total > LIMITE_CUERPO_BYTES) {
        rechazar(new Error("cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on("end", () => {
      try {
        resolver(total ? JSON.parse(Buffer.concat(partes).toString("utf8")) : {});
      } catch {
        rechazar(new Error("JSON inválido"));
      }
    });
    req.on("error", rechazar);
  });
}

function servirArchivo(res, archivo) {
  const ruta = path.join(CARPETA_PUBLICA, archivo);
  fs.readFile(ruta, (error, contenido) => {
    if (error) {
      res.writeHead(404).end("No encontrado");
      return;
    }
    res.writeHead(200, {
      "content-type": TIPOS[path.extname(archivo)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(contenido);
  });
}

async function iniciar() {
  fs.mkdirSync(CARPETA_DATOS, { recursive: true });
  const token = cargarToken();
  const direcciones = URL_PUBLICA ? [] : direccionesLocales();
  const repartidor = crearRepartidor({ registrar });
  let contadorTransmisores = 0;

  setInterval(() => repartidor.retirarInactivos(LIMITE_INACTIVIDAD_MS), 3000);

  async function qrDe(texto) {
    return QRCode.toDataURL(texto, { margin: 1, width: 240 });
  }

  async function datosPanel() {
    // Hosteado: un solo enlace por internet (el dominio público).
    if (URL_PUBLICA) {
      const camara = `${URL_PUBLICA}/camara?t=${token}`;
      const transmisor = `${URL_PUBLICA}/transmisor?t=${token}`;
      const enlace = {
        ip: "internet",
        etiqueta: `${new URL(URL_PUBLICA).host} — Internet (desde cualquier lugar)`,
        camara,
        transmisor,
        qrCamara: await qrDe(camara),
        qrTransmisor: await qrDe(transmisor),
      };
      return { enlaces: [enlace], camaraLocal: `/camara?t=${token}` };
    }

    // Local: un enlace por cada red de la PC.
    const enlaces = await Promise.all(
      direcciones.map(async ({ ip, etiqueta }) => {
        const base = `https://${ip}:${PUERTO_HTTPS}`;
        const camara = `${base}/camara?t=${token}`;
        const transmisor = `${base}/transmisor?t=${token}`;
        return { ip, etiqueta, camara, transmisor, qrCamara: await qrDe(camara), qrTransmisor: await qrDe(transmisor) };
      }),
    );
    return { enlaces, camaraLocal: `/camara?t=${token}` };
  }

  async function atenderApi(req, res, ruta) {
    if (req.method !== "POST") return responderJson(res, 405, { error: "Método no permitido" });
    if (req.headers["x-token"] !== token) return responderJson(res, 401, { error: "Enlace no válido" });
    const cuerpo = await leerCuerpo(req);

    if (ruta === "/api/camara") {
      if (typeof cuerpo.sdp !== "string") return responderJson(res, 400, { error: "Falta la oferta" });
      return responderJson(res, 200, await repartidor.conectarCamara(cuerpo.sdp));
    }
    if (ruta === "/api/transmisor") {
      contadorTransmisores += 1;
      return responderJson(res, 200, await repartidor.crearTransmisor(`Transmisor ${contadorTransmisores}`));
    }
    if (ruta === "/api/transmisor/respuesta") {
      const aceptada = await repartidor.aceptarRespuesta(cuerpo.id, cuerpo.sdp);
      return responderJson(res, aceptada ? 200 : 404, { aceptada });
    }
    if (ruta === "/api/latido") {
      const conocido = typeof cuerpo.id === "string" && repartidor.latido(cuerpo.id, cuerpo.detalles);
      const { generacion, camara, transmisores } = repartidor.estado();
      return responderJson(res, 200, {
        conocido,
        generacion,
        camaraActiva: Boolean(camara?.conectada),
        transmisores: transmisores.filter((t) => t.conectado).length,
        // La cámara manda su preferencia de espejo; los transmisores la obedecen.
        espejoCamara: Boolean(camara?.detalles?.espejo),
      });
    }
    if (ruta === "/api/salir") {
      repartidor.retirar(cuerpo.id);
      return responderJson(res, 200, {});
    }
    return responderJson(res, 404, { error: "Ruta no encontrada" });
  }

  function crearManejador({ esPanel, hosteado = false }) {
    return async (req, res) => {
      try {
        const url = new URL(req.url, "http://local");
        const ruta = url.pathname;

        if (esPanel && ruta === "/api/panel") {
          if (hosteado) {
            // En internet el panel se protege con el token (no hay "solo esta PC").
            if (req.headers["x-token"] !== token) return responderJson(res, 401, { error: "Enlace no válido" });
          } else {
            // Local: evita que una web externa lea el panel apuntando un dominio a 127.0.0.1.
            const anfitrion = (req.headers.host ?? "").split(":")[0];
            if (anfitrion !== "127.0.0.1" && anfitrion !== "localhost") {
              res.writeHead(403).end("Prohibido");
              return;
            }
          }
          return responderJson(res, 200, { ...(await datosPanel()), ...repartidor.estado() });
        }

        if (ruta.startsWith("/api/")) return await atenderApi(req, res, ruta);

        const pagina = PAGINAS[ruta];
        if (pagina) {
          const esPaginaPanel = ruta === "/";
          if (esPaginaPanel && !esPanel) {
            res.writeHead(404).end("No encontrado");
            return;
          }
          // Cámara y transmisor siempre piden token. El panel solo cuando está hosteado.
          const requiereToken = !esPaginaPanel || hosteado;
          if (requiereToken && url.searchParams.get("t") !== token) {
            res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
            res.end("Enlace no válido. Vuelve a escanear el QR del panel.");
            return;
          }
          return servirArchivo(res, pagina);
        }

        if (ruta === "/fuentes/archivo.woff2") {
          res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=604800" });
          fs.createReadStream(ARCHIVO_FUENTE).pipe(res);
          return;
        }

        const archivo = ruta.slice(1);
        if (ARCHIVOS_PUBLICOS.has(archivo)) return servirArchivo(res, archivo);

        res.writeHead(404).end("No encontrado");
      } catch (error) {
        registrar(`Error en ${req.url?.split("?")[0]}: ${error.message}`);
        if (!res.headersSent) responderJson(res, 500, { error: "Error interno" });
        else res.end();
      }
    };
  }

  const alFallarEscucha = (error) => {
    console.error(`No se pudo abrir el puerto (${error.code}). ¿Ya hay otra ventana del programa abierta?`);
    process.exit(1);
  };

  if (URL_PUBLICA) {
    // Hosteado: un solo servidor HTTP plano. Caddy pone el HTTPS real por delante.
    http
      .createServer(crearManejador({ esPanel: true, hosteado: true }))
      .on("error", alFallarEscucha)
      .listen(PUERTO_APP, "0.0.0.0");
    console.log("");
    console.log("  Reparto de cámara HOSTEADO en marcha");
    console.log(`  App interna en http://0.0.0.0:${PUERTO_APP} (Caddy pone el HTTPS)`);
    console.log(`  Panel:      ${URL_PUBLICA}/?t=${token}`);
    console.log(`  Cámara:     ${URL_PUBLICA}/camara?t=${token}`);
    console.log(`  Transmisor: ${URL_PUBLICA}/transmisor?t=${token}`);
    console.log("");
    return;
  }

  const credenciales = await cargarCertificado(direcciones.map((d) => d.ip));
  https
    .createServer(credenciales, crearManejador({ esPanel: false }))
    .on("error", alFallarEscucha)
    .listen(PUERTO_HTTPS, "0.0.0.0");
  http
    .createServer(crearManejador({ esPanel: true }))
    .on("error", alFallarEscucha)
    .listen(PUERTO_PANEL, "127.0.0.1");

  console.log("");
  console.log("  Reparto de cámara en marcha");
  console.log(`  Panel en esta PC:  http://127.0.0.1:${PUERTO_PANEL}`);
  console.log("  No cierres esta ventana mientras dure el live.");
  console.log("");
}

// Un error suelto de una conexión no debe tumbar los demás lives.
process.on("uncaughtException", (error) => registrar(`Error no controlado: ${error.stack ?? error}`));
process.on("unhandledRejection", (error) => registrar(`Promesa rechazada: ${error?.stack ?? error}`));

iniciar().catch((error) => {
  console.error("No se pudo iniciar:", error);
  process.exit(1);
});
