# Deploy — servidor único (convert-knowledge + 3 apps)

Os 3 apps consomem a base **só** pelo serviço `convert-knowledge`. Regras de ouro:
RAG indexa apenas `.md`; PDFs só para download via `/docs/:file`.

## Topologia

| Subdomínio | Projeto | Porta | Exposição |
|---|---|---|---|
| `knowledge.example.com` | convert-knowledge | 8787 | pública (browser do hub + downloads de PDF) |
| `bb.example.com` | bb_cnvrt_v2 | 3001 | pública |
| `toads.example.com` | toads | 3002 | pública |
| `hub.example.com` | vibe-hub | — (estático) | pública |

`bb` e `toads` chamam o `/search` **server-to-server** por `http://localhost:8787`
(não saem do servidor). Só o **hub** (browser) chama o serviço pela URL pública —
por isso o CORS do serviço libera apenas a origem do hub.

A URL de **download** de PDF é sempre a **pública** (`KNOWLEDGE_PUBLIC_URL`), porque
o link é clicado no browser do usuário — daí a separação entre `KNOWLEDGE_URL`
(busca interna) e `KNOWLEDGE_PUBLIC_URL` (downloads) em bb e toads.

## Variáveis de ambiente

**convert-knowledge** (`.env`)
```
GEMINI_API_KEY=...
PORT=8787
KNOWLEDGE_API_KEYS=<chave-forte>          # exigida em /search, /docs, /documents
ADMIN_API_KEY=<chave-admin>               # exigida em /reindex
ALLOWED_ORIGINS=https://hub.example.com   # só o hub chama do browser
```

**bb_cnvrt_v2** (`.env`)
```
KNOWLEDGE_URL=http://localhost:8787
KNOWLEDGE_PUBLIC_URL=https://knowledge.example.com
KNOWLEDGE_API_KEY=<a mesma de KNOWLEDGE_API_KEYS>
PORT=3001
# (+ as vars já existentes: GEMINI_API_KEY, JWT_SECRET, DATABASE_URL/DB_PATH, etc.)
```

**toads** (`.env.local`)
```
KNOWLEDGE_URL=http://localhost:8787
KNOWLEDGE_PUBLIC_URL=https://knowledge.example.com
KNOWLEDGE_API_KEY=<a mesma de KNOWLEDGE_API_KEYS>
# (+ GEMINI_API_KEY, AUTH_USERS, AUTH_SECRET)
```

**vibe-hub** (`.env`, assado no build do Vite)
```
VITE_KNOWLEDGE_URL=https://knowledge.example.com
VITE_KNOWLEDGE_API_KEY=<a mesma de KNOWLEDGE_API_KEYS>
VITE_GEMINI_API_KEY=...   # geração ainda é no browser (fora do escopo desta migração)
```

## Passos

```bash
# 1) convert-knowledge
cd /srv/convert-knowledge && pnpm install && pnpm ingest   # gera data/rag-index.json

# 2) bb_cnvrt_v2
cd /srv/bb_cnvrt_v2 && pnpm install && pnpm build

# 3) toads
cd /srv/toads && pnpm install && pnpm build

# 4) vibe-hub (estático)
cd /srv/vibe-hub && pnpm install && pnpm build
sudo mkdir -p /var/www/vibe-hub && sudo cp -r dist /var/www/vibe-hub/

# 5) processos Node (knowledge + bb + toads)
pm2 start /srv/convert-knowledge/deploy/ecosystem.config.cjs
pm2 save && pm2 startup

# 6) reverse-proxy
sudo cp /srv/convert-knowledge/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Atualizar a base

```bash
cd /srv/convert-knowledge
git pull                       # se a base mudou no repo
pnpm ingest                    # reindexa só os .md
pm2 restart convert-knowledge  # recarrega o índice em memória
# ou, sem restart: curl -X POST https://knowledge.example.com/reindex -H "x-api-key: <ADMIN_API_KEY>"
```

## Conectar um app novo (futuro)

1. Copie `client/knowledge-client.ts` (ou `.js` p/ browser).
2. Defina `KNOWLEDGE_URL`/`KNOWLEDGE_PUBLIC_URL` (server) ou `VITE_KNOWLEDGE_URL` (browser) + a API key.
3. Se chamar do browser, acrescente a origem em `ALLOWED_ORIGINS` do serviço.
