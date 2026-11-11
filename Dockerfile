# Imagen para correr el reparto de cámara hosteado en el VPS.
FROM node:24-slim

# Herramientas por si alguna dependencia necesita compilarse.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Primero solo el manifiesto, para aprovechar la caché de capas.
COPY package.json ./
RUN npm install --omit=dev

# Luego el resto del código.
COPY src ./src
COPY public ./public

ENV DATOS=/datos
CMD ["node", "src/servidor.js"]
