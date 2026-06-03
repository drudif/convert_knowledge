/**
 * Client mínimo do convert-knowledge (Node / Next.js / qualquer TS).
 * Copie este arquivo para o projeto consumidor e configure as env vars.
 *
 *   const kb = createKnowledgeClient();
 *   const { ragContext, sources } = await kb.search("hooks de tiktok", { platform: "tiktok" });
 */
export interface KnowledgeSource {
  id: string;
  title: string;
  platform: string;
  filename: string;
  downloadPath: string; // prefixe com KNOWLEDGE_URL para baixar o PDF
}

export interface KnowledgeHit {
  docId: string;
  title: string;
  platform: string;
  page: number | null;
  source: string;
  text: string;
  score: number;
  hidden: boolean;
}

export interface KnowledgeResult {
  ragContext: string;
  chunks: KnowledgeHit[];
  sources: KnowledgeSource[];
}

export interface SearchOpts {
  platform?: "google" | "meta" | "tiktok" | "all" | null;
  topK?: number;
  includeHidden?: boolean;
}

export function createKnowledgeClient(opts?: { baseUrl?: string; apiKey?: string }) {
  const baseUrl = (opts?.baseUrl ?? process.env.KNOWLEDGE_URL ?? "http://localhost:8787").replace(/\/$/, "");
  const apiKey = opts?.apiKey ?? process.env.KNOWLEDGE_API_KEY ?? "";

  async function search(query: string, searchOpts: SearchOpts = {}): Promise<KnowledgeResult> {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, ...searchOpts }),
    });
    if (!res.ok) throw new Error(`knowledge /search ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // URL absoluta para download de um PDF a partir de um source.downloadPath.
  function docUrl(downloadPath: string): string {
    return `${baseUrl}${downloadPath}`;
  }

  return { baseUrl, search, docUrl };
}
