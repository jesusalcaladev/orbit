FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package.json pnpm-lock.yaml* ./
RUN npm install --frozen-lockfile

# Copy source code
COPY . .

# Build the package
RUN npm run build

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm install --frozen-lockfile --production

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/cache/src ./packages/cache/src
COPY --from=builder /orbit /orbit

# Set environment variables for KV-cache plugin
ENV ORBIT_CACHE_HEADER=x-orbit-cache
ENV ORBIT_CACHE_DEFAULT_TTL=300

# Default command
CMD ["node", "-e",
  "const { createKvCachePlugin } = require('@orbit/cache'); \
   const { createMemoryCacheStore } = require('@orbit/cache'); \
   const cache = createKvCachePlugin({ store: createMemoryCacheStore() }); \
   console.log('KV-cache plugin loaded successfully'); \
   console.log('Plugin name:', cache.name); \
   console.log('Has invalidate:', typeof cache.invalidate === 'function');"]
]

# Optional: Development mode
# CMD ["npm", "run", "dev"]

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('@orbit/core').createOrbit().execute({ query: 'true' })" || exit 1