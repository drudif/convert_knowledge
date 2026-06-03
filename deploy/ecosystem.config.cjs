/**
 * PM2 — roda os 3 serviços Node do servidor único.
 * (O vibe-hub é estático: builde e sirva pelo Caddy, não entra aqui.)
 *
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * Ajuste os caminhos `cwd` e os segredos. Os segredos também podem ficar no .env
 * de cada projeto — neste arquivo eles são injetados como env do processo.
 */
const KNOWLEDGE_KEY = "TROQUE_ESTA_CHAVE"; // mesma em KNOWLEDGE_API_KEYS e nos clientes
const KNOWLEDGE_PUBLIC = "https://knowledge.example.com";

module.exports = {
  apps: [
    {
      name: "convert-knowledge",
      cwd: "/srv/convert-knowledge",
      script: "pnpm",
      args: "start",
      env: {
        PORT: "8787",
        // GEMINI_API_KEY: deixe no .env do projeto
        KNOWLEDGE_API_KEYS: KNOWLEDGE_KEY,
        ADMIN_API_KEY: "TROQUE_ADMIN",
        // Só o browser do hub precisa de CORS; bb/toads chamam server-to-server.
        ALLOWED_ORIGINS: "https://hub.example.com",
      },
    },
    {
      name: "bb",
      cwd: "/srv/bb_cnvrt_v2",
      script: "pnpm",
      args: "start",
      env: {
        PORT: "3001",
        KNOWLEDGE_URL: "http://localhost:8787", // busca interna (sem sair do servidor)
        KNOWLEDGE_PUBLIC_URL: KNOWLEDGE_PUBLIC, // links de download (browser)
        KNOWLEDGE_API_KEY: KNOWLEDGE_KEY,
      },
    },
    {
      name: "toads",
      cwd: "/srv/toads",
      script: "pnpm",
      args: "start -- -p 3002",
      env: {
        KNOWLEDGE_URL: "http://localhost:8787",
        KNOWLEDGE_PUBLIC_URL: KNOWLEDGE_PUBLIC,
        KNOWLEDGE_API_KEY: KNOWLEDGE_KEY,
      },
    },
  ],
};
