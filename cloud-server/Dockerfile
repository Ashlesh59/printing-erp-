# Dockerfile for DeskSolutions Control Center & Co-Pilot Server
FROM node:20-alpine

# Install build dependencies for native SQLite (if compiling on Linux)
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy server code and public assets
COPY . .

# Expose HTTP and WebSocket port
EXPOSE 5000

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=5000

# Start Control Center
CMD ["node", "server.js"]
