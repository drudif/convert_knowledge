/**
 * indexer.ts — ingestão INCREMENTAL de um documento em runtime.
 * Faz chunk + embedding de um único .md e adiciona ao índice, sem re-embedar
 * a base inteira (diferente de ingest/build-index.mjs, que reconstrói tudo).
 * Mantém os mesmos parâmetros de chunk/embedding da ingestão completa.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embedQuery } from "./embed.js";
import {
  appendChunks,
  removeChunksBySource,
  listIndexedSources,
  getFileHashes,
  saveFileHashes,
  type RawChunk,
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.resolve(__dirname, "..", "knowledge-base");

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MIN_CHUNK_LEN = 80;

function stripFrontMatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\s*\n/, "");
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

function extractPage(text: string): number | null {
  const m = text.match(/P[áa]gina\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function embedWithRetry(text: string, retries = 5): Promise<number[]> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await embedQuery(text);
    } catch (e: any) {
      if (e?.message?.includes("429") && attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 40000 + attempt * 10000));
      } else {
        throw e;
      }
    }
  }
  throw new Error("embedWithRetry: esgotou as tentativas");
}

/**
 * Embeda um .md e adiciona seus chunks ao índice. `source` é o caminho relativo
 * a knowledge-base/ (ex.: "tiktok/meu-doc.md"). Retorna o nº de chunks indexados.
 */
export async function embedAndAddDocument(source: string, rawText: string): Promise<number> {
  const clean = stripFrontMatter(rawText).replace(/\s+/g, " ").trim();
  const chunks = chunkText(clean);
  const built: RawChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.trim().length < MIN_CHUNK_LEN) continue;
    const embedding = await embedWithRetry(chunk);
    built.push({ source, chunk: i, page: extractPage(chunk), text: chunk, embedding });
    await new Promise((r) => setTimeout(r, 650)); // respeita rate limit
  }
  appendChunks(source, built);
  return built.length;
}

export function removeDocument(source: string): void {
  removeChunksBySource(source);
}

function walkMarkdown(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full, base));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(path.relative(base, full));
  }
  return out;
}

function hashFile(full: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}

/**
 * Reconcilia o índice com os .md de knowledge-base/ de forma INCREMENTAL:
 *  - reembeda apenas os arquivos novos ou alterados (comparação por hash sha256);
 *  - remove do índice os arquivos que não existem mais no disco;
 *  - no primeiro encontro de um arquivo já indexado sem hash registrado, apenas
 *    registra o baseline (não reembeda — o índice atual já corresponde ao .md).
 * Reembedar exige GEMINI_API_KEY; o baseline e a remoção não.
 */
export async function reconcileIndex(): Promise<{ updated: string[]; removed: string[]; baseline: number }> {
  const updated: string[] = [];
  const removed: string[] = [];
  let baseline = 0;
  if (!fs.existsSync(KB_DIR)) return { updated, removed, baseline };

  const hashes = getFileHashes();
  const indexed = new Set(listIndexedSources());
  const mdFiles = walkMarkdown(KB_DIR, KB_DIR);
  const present = new Set(mdFiles);

  for (const source of mdFiles) {
    const full = path.join(KB_DIR, source);
    const h = hashFile(full);
    if (hashes[source] === h) continue; // inalterado
    if (hashes[source] === undefined && indexed.has(source)) {
      hashes[source] = h; // baseline: já indexado, só registra o hash
      baseline++;
      continue;
    }
    // novo ou alterado → reembeda (embedAndAddDocument faz upsert dos chunks)
    const raw = fs.readFileSync(full, "utf-8");
    await embedAndAddDocument(source, raw);
    hashes[source] = h;
    updated.push(source);
  }

  // arquivos removidos do disco mas ainda presentes no índice
  for (const source of indexed) {
    if (!present.has(source)) {
      removeChunksBySource(source);
      delete hashes[source];
      removed.push(source);
    }
  }

  saveFileHashes(hashes);
  return { updated, removed, baseline };
}
