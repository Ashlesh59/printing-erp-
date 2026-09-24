# Dockerfile for DeskSolutions Control Center & Co-Pilot Server
FROM node:20-alpine

# Install build dependencies for native SQLite compilation and curl for container healthcheck
RUN apk add --no-cache python3 make g++ sqlite curl

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies cleanly
RUN npm ci --only=production

# Copy server code and public assets (respecting .dockerignore)
COPY . .

# Create persistent data volume directory structure
RUN mkdir -p /app/data /app/data/backups /app/data/uploads

# Expose HTTP and WebSocket port
EXPOSE 5000

# Declare persistent volume mount point
VOLUME ["/app/data"]

# Set default production environment variables
ENV NODE_ENV=production
ENV CONTROL_CENTER_HOST=0.0.0.0
ENV CONTROL_CENTER_PORT=5000
ENV PORT=5000
ENV DB_PATH=/app/data/cloud_control.db
ENV BACKUPS_DIR=/app/data/backups
ENV UPLOADS_DIR=/app/data/uploads

# Container healthcheck using liveness probe endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

# Start Control Center
CMD ["node", "server.js"]
