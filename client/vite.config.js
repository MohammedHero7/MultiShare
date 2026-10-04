import { defineConfig } from 'vite';

const backend = `http://localhost:${process.env.PORT || 3001}`;

export default defineConfig({
  // Read VITE_DISCORD_CLIENT_ID from the shared .env in the project root.
  envDir: '../',
  server: {
    port: 5173,
    // Dev only: accept requests forwarded by the cloudflared tunnel.
    allowedHosts: true,
    proxy: {
      // Discord strips "/.proxy" before forwarding, so requests arrive as /api/...
      '/api': { target: backend, changeOrigin: true, ws: true },
      // When testing in a normal browser the prefix is still there.
      '/.proxy/api': {
        target: backend,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/\.proxy/, ''),
      },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
});
