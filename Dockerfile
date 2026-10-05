# The watch party as one container: the built activity plus the server that serves
# it. Render builds this automatically (see render.yaml); any Docker host works too.

FROM node:24-bookworm-slim

# yt-dlp for YouTube. The standalone Linux build brings its own Python, and it uses
# the Node in this image to get past YouTube's JavaScript checks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci

COPY . .

# The Discord app id is built into the activity. Render passes the service's
# environment variables to the build as arguments, so it arrives here.
ARG VITE_DISCORD_CLIENT_ID
RUN npm run build

ENV NODE_ENV=production
# Render sets PORT itself; 3001 is the fallback elsewhere.
EXPOSE 3001

# Update yt-dlp on every start: YouTube changes often and old versions stop working.
CMD ["sh", "-c", "yt-dlp -U >/dev/null 2>&1; exec node server/src/index.js"]
