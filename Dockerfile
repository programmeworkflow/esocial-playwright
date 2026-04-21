FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

# Install only production deps first for better caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
