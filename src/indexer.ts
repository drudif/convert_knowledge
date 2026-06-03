/**
 * indexer.ts — ingestão INCREMENTAL de um documento em runtime.
 * Faz chunk + embedding de um único .md e adiciona ao índice, sem re-embedar
 * a base inteira (diferente de ingest/build-index.mjs, que reconstrói tudo).
 * Mantém os mesmos parâmetros de chunk/embedding da ingestão completa.
 */
import { embedQuery } from "./embed.js";
import { appendChunks, removeChunksBySource, type RawChunk } from "./store.js";

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
