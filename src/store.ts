/**
 * store.ts — carrega o índice de embeddings em memória, resolve metadados dos
 * documentos e faz busca por similaridade de cosseno. Também expõe mutação do
 * índice (append/remove de chunks) para ingestão incremental em runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listDocs,
  docByMdBasename,
  findById,
  pdfFilenames as metaPdfFilenames,
  type DocMeta,
} from "./metadata-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INDEX_FILE = path.join(ROOT, "data", "rag-index.json");

export type { DocMeta };

export interface RawChunk {
  source: string;
  chunk: number;
  page: number | null;
  text: string;
  embedding: number[];
}

interface IndexFile {
  model: string;
  dims: number;
  builtFiles: Record<string, number>;
  chunks: RawChunk[];
}

export interface SearchHit {
  docId: string;
  title: string;
  platform: string;
  page: number | null;
  chunk: number;
  source: string;
  text: string;
  score: number;
  hidden: boolean;
}

export interface SearchResult {
  ragContext: string;
  chunks: SearchHit[];
  sources: { id: string; title: string; platform: string; filename: string; downloadPath: string | null }[];
}

function resolveDoc(source: string): DocMeta {
  const base = path.basename(source).replace(/\.md$/i, "").toLowerCase();
  return (
    docByMdBasename(base) ?? {
      id: base,
      title: path.basename(source).replace(/\.md$/i, ""),
      filename: `${path.basename(source).replace(/\.md$/i, "")}.pdf`,
      platform: "general",
    }
  );
}

let _index: IndexFile | null = null;

export function loadIndex(force = false): IndexFile {
  if (_index && !force) return _index;
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error(`Índice não encontrado em ${INDEX_FILE}. Rode "pnpm ingest" primeiro.`);
  }
  _index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")) as IndexFile;
  return _index;
}

function saveIndex() {
  const idx = loadIndex();
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, INDEX_FILE); // troca atômica
}

/** Adiciona os chunks de um documento ao índice (ingestão incremental) e persiste. */
export function appendChunks(source: string, chunks: RawChunk[]): void {
  const idx = loadIndex();
  // remove eventuais chunks pré-existentes da mesma fonte antes de inserir
  idx.chunks = idx.chunks.filter((c) => c.source !== source);
  idx.chunks.push(...chunks);
  idx.builtFiles[source] = chunks.length;
  if (!idx.dims && chunks[0]) idx.dims = chunks[0].embedding.length;
  saveIndex();
}

/** Remove todos os chunks de uma fonte do índice e persiste. */
export function removeChunksBySource(source: string): void {
  const idx = loadIndex();
  idx.chunks = idx.chunks.filter((c) => c.source !== source);
  delete idx.builtFiles[source];
  saveIndex();
}

export function indexStats() {
  const idx = loadIndex();
  return { model: idx.model, dims: idx.dims, chunks: idx.chunks.length, documents: Object.keys(idx.builtFiles).length };
}

export function docMetadata() {
  return listDocs();
}

export function pdfFilenames(): Set<string> {
  return metaPdfFilenames();
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function search(
  queryEmbedding: number[],
  opts: { platform?: string | null; topK?: number; includeHidden?: boolean } = {}
): SearchResult {
  const { platform = null, topK = 6, includeHidden = true } = opts;
  const idx = loadIndex();

  const scored: SearchHit[] = [];
  for (const c of idx.chunks) {
    const doc = resolveDoc(c.source);
    if (doc.disabled) continue; // desativado: fora do RAG por completo
    if (platform && platform !== "all" && doc.platform !== platform && doc.platform !== "general") continue;
    if (!includeHidden && doc.hidden) continue;
    scored.push({
      docId: doc.id,
      title: doc.title,
      platform: doc.platform,
      page: c.page,
      chunk: c.chunk,
      source: c.source,
      text: c.text,
      score: cosine(queryEmbedding, c.embedding),
      hidden: !!doc.hidden,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, topK);

  const ragContext = hits
    .map((h) => `[DOC:${h.docId}:${h.page ?? h.chunk}]\n${h.text}`)
    .join("\n\n---\n\n");

  // sources: documentos únicos e NÃO ocultos (para citação visível ao usuário).
  const seen = new Set<string>();
  const sources = [] as SearchResult["sources"];
  for (const h of hits) {
    if (h.hidden || seen.has(h.docId)) continue;
    seen.add(h.docId);
    const meta = findById(h.docId)!;
    sources.push({
      id: meta.id,
      title: meta.title,
      platform: meta.platform,
      filename: meta.filename,
      downloadPath: meta.hasPdf === false ? null : `/docs/${encodeURIComponent(meta.filename)}`,
    });
  }

  return { ragContext, chunks: hits, sources };
}
