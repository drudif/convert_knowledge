/**
 * metadata-store.ts — registro mutável dos documentos (antes era um import
 * estático de metadata.json). Carrega de disco e persiste de forma atômica,
 * permitindo adicionar documentos e marcar/desmarcar "disabled" em runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_FILE = path.join(__dirname, "metadata.json");

export interface DocMeta {
  id: string;
  title: string;
  filename: string; // nome do PDF (base do id + .pdf), usado p/ download e mapeamento
  platform: "google" | "meta" | "tiktok" | "general";
  hidden?: boolean; // interno: alimenta o RAG mas não é citado (GERALA/B/CTA)
  disabled?: boolean; // desativado: removido totalmente do RAG e da biblioteca (reversível)
  category?: string;
  description?: string;
  hasPdf?: boolean; // se há PDF para download (docs adicionados podem não ter)
  addedAt?: number; // timestamp; presente nos docs criados pelo painel
}

let _docs: DocMeta[] = JSON.parse(fs.readFileSync(META_FILE, "utf-8")).docs;

function rebuildIndexes() {
  byBasename.clear();
  for (const d of _docs) {
    byBasename.set(d.filename.replace(/\.pdf$/i, "").toLowerCase(), d);
  }
}

// Lookup: basename do arquivo (sem extensão, minúsculo) -> metadado.
const byBasename = new Map<string, DocMeta>();
rebuildIndexes();

function persist() {
  const tmp = `${META_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ docs: _docs }, null, 2));
  fs.renameSync(tmp, META_FILE); // troca atômica
}

export function listDocs(): DocMeta[] {
  return _docs;
}

export function findById(id: string): DocMeta | undefined {
  return _docs.find((d) => d.id === id);
}

export function docByMdBasename(base: string): DocMeta | undefined {
  return byBasename.get(base.toLowerCase());
}

export function pdfFilenames(): Set<string> {
  return new Set(_docs.filter((d) => d.hasPdf !== false).map((d) => d.filename));
}

export function addDoc(doc: DocMeta): void {
  if (findById(doc.id)) throw new Error(`Documento "${doc.id}" já existe`);
  _docs.push(doc);
  rebuildIndexes();
  persist();
}

export function setDisabled(id: string, disabled: boolean): DocMeta {
  const doc = findById(id);
  if (!doc) throw new Error(`Documento "${id}" não encontrado`);
  doc.disabled = disabled;
  persist();
  return doc;
}
