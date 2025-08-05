FROM node:20-bullseye-slim AS base

# Install mediasoup build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g turbo

FROM base AS pruner
WORKDIR /app

COPY . .

RUN turbo prune server --docker

FROM base AS runner
WORKDIR /app

# First install the dependencies (as they change less often)
COPY --from=pruner /app/out/json/ .
RUN npm ci 

# Build the project
COPY --from=pruner /app/out/full/ .
RUN turbo run build --force

CMD ["node", "apps/server/dist/main.js"]
