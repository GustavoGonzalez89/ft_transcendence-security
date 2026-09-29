FROM node:20-alpine

WORKDIR /app

# Copy package.json first so Docker can cache the npm install layer.
# If only src/ changes, this layer is reused (faster rebuilds).
RUN apk add --no-cache openssl

COPY package.json ./
RUN npm install --omit=dev

# Generate Prisma Client from schema before copying app code
COPY prisma/ ./prisma/
RUN npx prisma generate

# Copy application code
COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/server.js"]
