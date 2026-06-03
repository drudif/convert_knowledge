/**
 * embed.ts — embedding de queries via Gemini (mesmo modelo da ingestão).
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

const EMBED_MODEL = "gemini-embedding-001";

let _model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null;

function model() {
  if (_model) return _model;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY não configurada.");
  _model = new GoogleGenerativeAI(key).getGenerativeModel({ model: EMBED_MODEL });
  return _model;
}

export async function embedQuery(text: string): Promise<number[]> {
  const result = await model().embedContent(text);
  return result.embedding.values;
}
