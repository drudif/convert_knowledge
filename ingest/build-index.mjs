/**
 * build-index.mjs — Pipeline de ingestão do convert-knowledge.
 *
 * Lê TODOS os .md de knowledge-base/ (recursivamente), gera embeddings via Gemini
 * e salva data/rag-index.json. Os PDFs NUNCA são lidos para RAG — existem apenas
 * para download (servidos pelo serviço em GET /docs/:file).
 *
 * Uso: pnpm ingest   (requer GEMINI_API_KEY em .env ou .env.local)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("❌ GEMINI_API_KEY não encontrada. Adicione ao .env");
  process.exit(1);
}

const KB_DIR = path.join(ROOT, "knowledge-base");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "rag-index.json");

const EMBED_MODEL = "gemini-embedding-001";
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MIN_CHUNK_LEN = 80;

const genai = new GoogleGenerativeAI(API_KEY);
const embModel = genai.getGenerativeModel({ model: EMBED_MODEL });

function walkMarkdown(dir, baseDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full, baseDir));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(path.relative(baseDir, full));
  }
  return out;
}

// Remove front matter YAML (---\n...\n---) para não poluir os embeddings.
function stripFrontMatter(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\s*\n/, "");
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

// Tenta extrair "Página N" do trecho (os .md vêm de PDFs com marcadores ## Página N).
function extractPage(text) {
  const m = text.match(/P[áa]gina\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function embedChunk(text, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await embModel.embedContent(text);
      return result.embedding.values;
    } catch (e) {
      if (e.message?.includes("429") && attempt < retries - 1) {
        const wait = 40000 + attempt * 10000;
        console.warn(`     ⏳ Rate limit, aguardando ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = walkMarkdown(KB_DIR, KB_DIR).sort();
  console.log(`📚 ${files.length} arquivos .md encontrados (PDFs ignorados — só download)\n`);

  const index = [];
  const perFile = {};
  const fileHashes = {};

  for (const relPath of files) {
    const full = path.join(KB_DIR, relPath);
    const raw = fs.readFileSync(full, "utf-8");
    fileHashes[relPath] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    const clean = stripFrontMatter(raw).replace(/\s+/g, " ").trim();
    const chunks = chunkText(clean);
    let kept = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.trim().length < MIN_CHUNK_LEN) continue;
      try {
        const embedding = await embedChunk(chunk);
        index.push({ source: relPath, chunk: i, page: extractPage(chunk), text: chunk, embedding });
        kept++;
        await new Promise((r) => setTimeout(r, 650));
      } catch (e) {
        console.warn(`     ⚠ Erro no chunk ${i} de ${relPath}: ${e.message}`);
      }
    }
    perFile[relPath] = kept;
    console.log(`  → ${relPath.padEnd(70)} ${kept} chunks`);
  }

  const dims = index[0]?.embedding?.length ?? 0;
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ model: EMBED_MODEL, dims, builtFiles: perFile, fileHashes, chunks: index })
  );
  console.log(`\n✅ Índice salvo: ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`   ${index.length} chunks · ${dims} dims · ${files.length} documentos`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
