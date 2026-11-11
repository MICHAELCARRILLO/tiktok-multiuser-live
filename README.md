# Reparto de cámara

Manda una sola cámara a varios celulares a la vez. Cada celular muestra el video a pantalla completa y TikTok transmite esa pantalla en su modo **Gaming**. Así una misma toma sale en varias cuentas al mismo tiempo.

```
Celular cámara ─> servidor ─┬─> celular 1 ─> live de la cuenta 1
                            ├─> celular 2 ─> live de la cuenta 2
                            └─> celular 3 ─> live de la cuenta 3
```

El servidor copia el video sin volver a comprimirlo, así que casi no consume CPU. Cada celular sube su propio live a TikTok.

Hay **dos formas** de usarlo:

- **Local (misma WiFi):** corre en tu PC con `iniciar.bat`. Todos los celulares deben estar en tu red.
- **Hosteado (internet):** corre en un servidor con dominio y HTTPS. Los celulares entran desde **cualquier lugar** (ideal si alguien transmite desde otra ciudad).

---

## Opción A — Local (tu WiFi)

1. Haz doble clic en `iniciar.bat`. Se abre una ventana negra, que debe quedar abierta, y el panel en Edge.
2. Conecta todos los celulares al **mismo WiFi** que la PC.
3. **Celular cámara:** escanea el QR 1 y toca **Iniciar cámara**.
4. **Cada celular que transmite:** escanea el QR 2 y toca **Empezar**.
5. En esos celulares, abre TikTok, entra a **LIVE > Gaming para dispositivos móviles** e inicia el live.
6. Vuelve a la página del navegador y déjala abierta.

**La primera vez**, cada celular avisará que la conexión no es privada, porque el certificado lo creó tu PC. Toca **Mostrar detalles** (o Avanzado) y luego **visitar este sitio**.

> **Webcam de la PC:** usa Edge, porque algunos Chrome tienen una política que bloquea WebRTC (`WebRtcIPHandling`).

---

## Opción B — Hosteado en internet (VPS)

Necesitas: un servidor con IP pública, un dominio apuntando a él y un proxy con HTTPS (se recomienda [Caddy](https://caddyserver.com), que saca el certificado solo). Requiere Docker.

1. **DNS:** crea un registro `A` de tu subdominio (p. ej. `live.tudominio.com`) hacia la IP del servidor.
2. **Firewall:** abre el rango UDP `40000-40030` (el video) además del 80/443.
3. **Configura:** copia `.env.example` a `.env` y pon tu dominio e IP.
   ```bash
   cp .env.example .env
   # edita .env
   ```
4. **Levanta la app:**
   ```bash
   docker compose up -d --build
   ```
5. **Proxy con HTTPS** (ejemplo de Caddy): apunta tu dominio al puerto interno.
   ```
   live.tudominio.com {
       reverse_proxy 127.0.0.1:8099
   }
   ```
6. Abre el panel en `https://live.tudominio.com/?t=TOKEN`. El token se crea solo al primer arranque; lo verás en los logs:
   ```bash
   docker logs tiktok-live
   ```

El panel te da los enlaces y QR de **cámara** y **transmisor**, ya con tu dominio y HTTPS real (sin advertencias).

> **Latencia:** el video viaja hasta el servidor y de vuelta. Si el servidor está lejos (otro continente), notarás ~0.5 s de retraso. Para menos retraso, usa un servidor cerca de ti.

---

## Durante el live

- **Espejo:** en la página de la **cámara**, el botón **Espejo** voltea la imagen (y voltea a todos los transmisores a la vez). Útil si tu cámara frontal sale al revés.
- **Calidad:** elige 720p (menos datos) o 1080p en la página de la cámara.
- **Pantalla limpia** (si el mismo celular filma y transmite): en la cámara oculta los controles. Para recuperarlos, toca la pantalla y luego **Mostrar controles**.
- **Detener la cámara:** toca **Detener cámara** dos veces.
- **En el transmisor:** toca la pantalla para ver el estado y los botones de pantalla completa y **Detener**.

## Consejos

- Desactiva el bloqueo automático de pantalla y deja los celulares enchufados.
- Activa **No molestar**: una notificación también saldría en el live.
- No salgas de la página: si abres otra app, el live mostrará esa app.
- **iPhone:** si se ven las barras del navegador, ocúltalas desde el menú de la dirección.

## Cuánto gasta de datos

Por cada stream (720p ≈ 3 Mbps): ~22 MB por minuto, ~1.3 GB por hora. La cámara sube uno; cada transmisor baja uno.

## Qué no hace

- No junta los comentarios de las cuentas ni inicia los lives por ti.
- No oculta que las cuentas están relacionadas. Si TikTok las relaciona, una restricción podría afectar a todas. Haz las primeras pruebas con cuentas secundarias.

## Comprobar que todo funciona

```bash
npm install
npm run prueba
```

La prueba usa Edge con una cámara simulada. No reemplaza una prueba con celulares reales.

## Licencia

MIT. Úsalo y modifícalo libremente.
