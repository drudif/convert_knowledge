/**
 * Client mínimo do convert-knowledge (browser / JS puro — ex.: vibe-hub).
 * A query é embedada no servidor, então a chave Gemini NÃO fica no browser.
 *
 *   import { createKnowledgeClient } from "./knowledge-client.js";
 *   const kb = createKnowledgeClient({ baseUrl: import.meta.env.VITE_KNOWLEDGE_URL, apiKey: import.meta.env.VITE_KNOWLEDGE_API_KEY });
 *   const { ragContext, sources } = await kb.search(question, { platform: "all" });
 */
export function createKnowledgeClient({ baseUrl, apiKey } = {}) {
  const base = (baseUrl || "http://localhost:8787").replace(/\/$/, "");
  const key = apiKey || "";

  async function search(query, opts = {}) {
    const res = await fetch(`${base}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, ...opts }),
    });
    if (!res.ok) throw new Error(`knowledge /search ${res.status}: ${await res.text()}`);
    return res.json();
  }

  function docUrl(downloadPath) {
    return `${base}${downloadPath}`;
  }

  return { baseUrl: base, search, docUrl };
}
