FROM node:22-alpine

WORKDIR /app

# Install deps first (better layer caching — only re-runs npm ci if package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the backend source
COPY . .

# Matches: const PORT = process.env.PORT || 3001; in server.js
EXPOSE 3001

CMD ["node", "src/server.js"]
