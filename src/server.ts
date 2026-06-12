/**
 * server.ts — API HTTP do convert-knowledge.
 *
 * Rotas:
 *   GET  /healthz            -> status + stats do índice (público)
 *   POST /search             -> RAG: { query, platform?, topK?, includeHidden? } (x-api-key)
 *   GET  /docs/:file         -> download do PDF original (x-api-key)
 *   GET  /documents          -> lista de documentos disponíveis (x-api-key)
 *   POST /reindex            -> reconstrói o índice de embeddings (x-api-key admin)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import multer from "multer";
import { embedQuery } from "./embed.js";
import { docMetadata, indexStats, loadIndex, pdfFilenames, search, survey } from "./store.js";
import { addDoc, findById, setDisabled, type DocMeta } from "./metadata-store.js";
import { embedAndAddDocument } from "./indexer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const KB_DIR = path.join(ROOT, "knowledge-base");

// Carrega .env / .env.local sem dependência externa.
for (const envFile of [".env", ".env.local"]) {
  const envPath = path.join(ROOT, envFile);
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

const PORT = Number(process.env.PORT ?? 8787);
const API_KEYS = (process.env.KNOWLEDGE_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "";
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: ORIGINS.includes("*") ? true : ORIGINS }));

// Auth por API key. Se nenhuma chave estiver configurada, libera (apenas dev local).
function requireKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (API_KEYS.length === 0) return next();
  const key = req.header("x-api-key");
  if (key && API_KEYS.includes(key)) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.get("/healthz", (_req, res) => {
  try {
    res.json({ ok: true, ...indexStats() });
  } catch (e) {
    res.status(503).json({ ok: false, error: (e as Error).message });
  }
});

app.get("/documents", requireKey, (_req, res) => {
  res.json({ documents: docMetadata() });
});

app.post("/search", requireKey, async (req, res) => {
  const { query, platform = null, topK = 6, includeHidden = true, coverage, perDoc } = req.body ?? {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "campo 'query' (string) é obrigatório" });
  }
  try {
    const embedding = await embedQuery(query);
    let result;
    if (coverage === "survey") {
      // Cobertura ampla: top-N chunks de CADA doc da plataforma (todas as fontes).
      const effPerDoc = Math.max(1, Math.min(Number(perDoc) || 2, 5));
      result = survey(embedding, { platform, perDoc: effPerDoc, includeHidden });
    } else {
      const effectiveTopK = Math.max(1, Math.min(Number(topK) || 6, 20));
      result = search(embedding, { platform, topK: effectiveTopK, includeHidden });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Download de PDF. Restrito aos arquivos conhecidos no metadata (evita path traversal).
// pdfFilenames() é recomputado a cada request para refletir docs adicionados em runtime.
const pdfPathCache = new Map<string, string | null>();

function findPdf(filename: string): string | null {
  if (pdfPathCache.has(filename)) return pdfPathCache.get(filename)!;
  let found: string | null = null;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (found) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === filename) found = full;
    }
  };
  walk(KB_DIR);
  pdfPathCache.set(filename, found);
  return found;
}

// Download público: links de PDF clicados no browser não enviam x-api-key.
// Só serve PDFs de docs visíveis existentes no disco (ocultos não têm PDF → 404).
// Busca e metadados seguem protegidos (/search e /documents exigem chave).
app.get("/docs/:file", (req, res) => {
  const file = path.basename(req.params.file);
  if (!pdfFilenames().has(file)) return res.status(404).json({ error: "documento não encontrado" });
  const full = findPdf(file);
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: "arquivo indisponível" });
  res.download(full, file);
});

// ───────────────────────── Admin: gestão de documentos ─────────────────────
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ADMIN_KEY || req.header("x-api-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized (admin)" });
  }
  next();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const PLATFORMS = new Set(["google", "meta", "tiktok", "general"]);

// Upload de documento: .md (obrigatório, alimenta o RAG) + PDF (opcional, p/ download).
// Embeda incrementalmente (pode levar alguns segundos por documento).
app.post(
  "/documents",
  requireAdmin,
  upload.fields([{ name: "md", maxCount: 1 }, { name: "pdf", maxCount: 1 }]),
  async (req, res) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const mdFile = files?.md?.[0];
      const pdfFile = files?.pdf?.[0];
      const { title, platform, category, description, hidden, id: idIn } = (req.body ?? {}) as Record<string, string>;

      if (!mdFile) return res.status(400).json({ error: "arquivo .md é obrigatório (campo 'md')" });
      if (!title) return res.status(400).json({ error: "campo 'title' é obrigatório" });

      const plat = (PLATFORMS.has(platform) ? platform : "general") as DocMeta["platform"];
      const id = (idIn && slugify(idIn)) || slugify(title);
      if (!id) return res.status(400).json({ error: "não foi possível derivar um id válido do título" });
      if (findById(id)) return res.status(409).json({ error: `documento "${id}" já existe` });

      const dir = path.join(KB_DIR, plat);
      fs.mkdirSync(dir, { recursive: true });
      const mdName = `${id}.md`;
      fs.writeFileSync(path.join(dir, mdName), mdFile.buffer);

      const hasPdf = !!pdfFile;
      const pdfName = `${id}.pdf`;
      if (hasPdf) fs.writeFileSync(path.join(dir, pdfName), pdfFile!.buffer);

      const doc: DocMeta = {
        id,
        title,
        filename: pdfName,
        platform: plat,
        ...(hidden === "true" ? { hidden: true } : {}),
        ...(category ? { category } : {}),
        ...(description ? { description } : {}),
        hasPdf,
        addedAt: Date.now(),
      };
      addDoc(doc);
      pdfPathCache.clear();

      // Indexação incremental (chunk + embeddings) do .md recém-enviado.
      const chunks = await embedAndAddDocument(`${plat}/${mdName}`, mdFile.buffer.toString("utf-8"));
      res.json({ ok: true, doc, chunks });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  }
);

app.post("/documents/:id/disable", requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, doc: setDisabled(req.params.id, true) });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.post("/documents/:id/enable", requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, doc: setDisabled(req.params.id, false) });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.post("/reindex", (req, res) => {
  if (!ADMIN_KEY || req.header("x-api-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const child = spawn("node", ["ingest/build-index.mjs"], { cwd: ROOT, stdio: "inherit" });
  child.on("exit", (code) => {
    if (code === 0) {
      pdfPathCache.clear();
      loadIndex(true);
      console.log("[reindex] concluído, índice recarregado");
    } else {
      console.error(`[reindex] falhou (code ${code})`);
    }
  });
  res.json({ ok: true, message: "reindex iniciado" });
});

app.listen(PORT, () => {
  console.log(`convert-knowledge ouvindo em http://localhost:${PORT}`);
  try {
    const s = indexStats();
    console.log(`  índice: ${s.chunks} chunks · ${s.documents} docs · ${s.model}`);
  } catch {
    console.log("  ⚠ índice ainda não gerado — rode 'pnpm ingest'");
  }
});
