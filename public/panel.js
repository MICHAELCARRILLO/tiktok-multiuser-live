const REFRESCO_MS = 1500;
const CLAVE_RED = "panel.red";
// Hosteado, el panel pide token; local no lo necesita (lo manda vacío y no molesta).
const token = new URLSearchParams(location.search).get("t") ?? "";

const $ = (id) => document.getElementById(id);

let enlaces = [];
let redElegida = leerRedGuardada();

function leerRedGuardada() {
  try {
    return localStorage.getItem(CLAVE_RED);
  } catch {
    return null;
  }
}

function guardarRed(ip) {
  try {
    localStorage.setItem(CLAVE_RED, ip);
  } catch {
    // Sin almacenamiento solo se pierde la preferencia.
  }
}

function enlaceActual() {
  return enlaces.find((e) => e.ip === redElegida) ?? enlaces[0];
}

// Hosteado en internet la guía cambia: no hay "mismo WiFi" ni aviso de certificado.
function ajustarTextosSegunModo() {
  const hosteado = enlaces.some((e) => e.ip === "internet");
  if (!hosteado) return;
  $("pcNombre").textContent = "Servidor";
  $("pcDetalle").textContent = "Repartiendo por internet";
  $("guiaPasos").innerHTML = `
    <li>Abre el enlace en cualquier lugar. Sale con <b>candado seguro</b>, sin avisos.</li>
    <li>En los que transmiten, toca <b>Empezar</b> e inicia el live de TikTok en <b>Gaming</b>.</li>
    <li>Vuelve a esta página y déjala abierta. Si abres otra app, el live mostrará esa app.</li>
    <li>El celular que filma abre el enlace de la <b>cámara</b> y toca <b>Iniciar</b>.</li>`;
}

function pintarEnlaces() {
  const enlace = enlaceActual();
  if (!enlace) return;
  $("qrCamara").src = enlace.qrCamara;
  $("qrTransmisor").src = enlace.qrTransmisor;
  $("pcDetalle").textContent = enlace.ip;
}

function lampara(elemento, tipo) {
  elemento.className = `lampara ${tipo}`;
}

function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`;
}

function crearDestino(transmisor) {
  const item = document.createElement("li");
  item.className = transmisor.conectado ? "recibiendo" : "";
  const fila = document.createElement("div");
  fila.className = "destino";
  const luz = document.createElement("span");
  lampara(luz, transmisor.conectado ? "senal" : "espera");
  const nombre = document.createElement("span");
  nombre.className = "nodo-nombre";
  nombre.textContent = transmisor.nombre;
  const detalle = document.createElement("span");
  detalle.className = "nodo-detalle";
  detalle.textContent = transmisor.conectado ? "Recibiendo" : "Conectando…";
  fila.append(luz, nombre, detalle);
  item.append(fila);
  return item;
}

function crearDestinoVacio() {
  const item = document.createElement("li");
  const aviso = document.createElement("p");
  aviso.className = "destino-vacio";
  aviso.textContent = "Ningún celular todavía. Escanea el código de celulares que transmiten.";
  item.append(aviso);
  return item;
}

function pintarEstado({ camara, transmisores }) {
  const camaraActiva = Boolean(camara?.conectada);
  const recibiendo = transmisores.filter((t) => t.conectado).length;
  const enSalida = camaraActiva && recibiendo > 0;

  lampara($("camaraLampara"), enSalida ? "aire" : camaraActiva ? "senal" : "");
  if (camaraActiva) {
    const { ancho, alto, fps } = camara.detalles ?? {};
    $("camaraDetalle").textContent = ancho ? `${ancho}×${alto}, ${fps} fps` : "Conectada";
    $("camaraTasa").textContent = `${(camara.tasaKbps / 1000).toFixed(1)} Mbps`;
  } else {
    $("camaraDetalle").textContent = "Sin conectar";
    $("camaraTasa").textContent = "";
  }

  $("cable1").classList.toggle("vivo", camaraActiva);
  $("cable2").classList.toggle("vivo", enSalida);
  $("destinos").classList.toggle("vivo", enSalida);
  $("destinos").replaceChildren(...(transmisores.length ? transmisores.map(crearDestino) : [crearDestinoVacio()]));

  if (enSalida) {
    lampara($("resumenLampara"), "aire");
    $("resumenTexto").textContent = `Enviando a ${plural(recibiendo, "celular", "celulares")}`;
  } else if (camaraActiva) {
    lampara($("resumenLampara"), "senal");
    $("resumenTexto").textContent = "Cámara lista, sin celulares";
  } else {
    lampara($("resumenLampara"), "");
    $("resumenTexto").textContent = "Esperando la cámara";
  }
}

function pintarRedes() {
  $("red").replaceChildren(
    ...enlaces.map((enlace) => {
      const opcion = document.createElement("option");
      opcion.value = enlace.ip;
      opcion.textContent = enlace.etiqueta;
      return opcion;
    }),
  );
  $("red").value = enlaceActual()?.ip ?? "";
}

function conectarCopiar(boton, obtenerTexto) {
  const original = boton.textContent;
  boton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(obtenerTexto());
      boton.textContent = "Enlace copiado";
    } catch {
      boton.textContent = "No se pudo copiar";
    }
    setTimeout(() => {
      boton.textContent = original;
    }, 1600);
  });
}

async function refrescar() {
  try {
    const respuesta = await fetch("/api/panel", { headers: { "x-token": token } });
    const datos = await respuesta.json();
    if (enlaces.length === 0) {
      enlaces = datos.enlaces;
      ajustarTextosSegunModo();
      pintarRedes();
      pintarEnlaces();
      $("webcam").href = datos.camaraLocal;
    }
    pintarEstado(datos);
  } catch {
    lampara($("resumenLampara"), "espera");
    $("resumenTexto").textContent = "El programa no responde. Ábrelo con iniciar.bat";
  }
}

$("red").addEventListener("change", (evento) => {
  redElegida = evento.target.value;
  guardarRed(redElegida);
  pintarEnlaces();
});
conectarCopiar($("copiarCamara"), () => enlaceActual()?.camara ?? "");
conectarCopiar($("copiarTransmisor"), () => enlaceActual()?.transmisor ?? "");

refrescar();
setInterval(refrescar, REFRESCO_MS);
