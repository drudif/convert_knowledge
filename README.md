# convert-knowledge

Serviço central de conhecimento (RAG) compartilhado pelos projetos Convert
(`bb_cnvrt_v2`, `vibe-hub`/ad-analyser, `toads` e quaisquer projetos futuros).

**Fonte única da verdade** da base de conhecimento. Regras invioláveis:

- **RAG lê apenas `.md`.** Os PDFs **nunca** entram no índice de embeddings.
- **PDFs são só para download**, servidos em `GET /docs/:file`.
- Qualquer projeto se conecta por HTTP com uma API key — sem copiar a base.

## Estrutura

```
knowledge-base/        fonte única (.md indexados + .pdf para download)
  google/ meta/ tiktok/  + GERALA.md GERALB.md CTA.md (ocultos)
ingest/build-index.mjs aplica embeddings (Gemini gemini-embedding-001) -> data/rag-index.json
src/metadata.json      id, título, plataforma e flag `hidden` de cada documento
src/store.ts           carrega o índice + busca por cosseno
src/embed.ts           embedding da query
src/server.ts          API HTTP
client/                client reutilizável (.ts para Node/Next, .js para browser)
data/rag-index.json    índice gerado (commitado p/ deploy turnkey)
```

## Setup

```bash
pnpm install
cp .env.example .env      # preencha GEMINI_API_KEY
pnpm ingest               # gera data/rag-index.json (uma vez / quando a base mudar)
pnpm start                # sobe o serviço (PORT, padrão 8787)
```

## Contrato da API

Todas as rotas (exceto `/healthz`) exigem header `x-api-key` se `KNOWLEDGE_API_KEYS` estiver configurado.

### `POST /search`
```jsonc
// req
{ "query": "como fazer hooks no tiktok", "platform": "tiktok", "topK": 6, "includeHidden": true }
// res
{
  "ragContext": "[DOC:tiktok-creative-codes:3]\n...trecho...\n\n---\n\n[DOC:...]",
  "chunks": [{ "docId": "...", "title": "...", "platform": "tiktok", "page": 3, "text": "...", "score": 0.82, "hidden": false }],
  "sources": [{ "id": "...", "title": "...", "platform": "tiktok", "filename": "...pdf", "downloadPath": "/docs/...pdf" }]
}
```
- `platform`: `"google" | "meta" | "tiktok" | "all"` (filtra; docs `general` sempre entram).
- `includeHidden`: inclui GERALA/GERALB/CTA no grounding. Eles **nunca** aparecem em `sources` (citação oculta) — o app consumidor continua removendo `[DOC:...]` desses ids do texto final.
- Citação no formato `[DOC:id:página]`, igual ao que os 3 apps já usam.

### `GET /docs/:file`
Baixa o PDF original (restrito aos arquivos do `metadata.json`). Use `source.downloadPath` prefixado pela URL do serviço.

### `GET /documents`
Lista todos os documentos disponíveis (metadados).

### `GET /healthz`
`{ ok, model, dims, chunks, documents }` — público, para health-check do servidor.

### `POST /reindex`
Reconstrói o índice (header `x-api-key` = `ADMIN_API_KEY`). Recarrega em memória ao terminar.

## Conectar um projeto novo

1. Copie `client/knowledge-client.ts` (ou `.js` para browser) para o projeto.
2. Configure `KNOWLEDGE_URL` e `KNOWLEDGE_API_KEY` (a key deve estar em `KNOWLEDGE_API_KEYS` do serviço).
3. Adicione a origem do projeto em `ALLOWED_ORIGINS` do serviço (se chamar do browser).

```ts
const kb = createKnowledgeClient();
const { ragContext, sources } = await kb.search(pergunta, { platform: "tiktok" });
// injete ragContext no system prompt; renderize sources como links via kb.docUrl(s.downloadPath)
```
