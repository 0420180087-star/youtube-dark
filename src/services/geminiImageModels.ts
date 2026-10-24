/**
 * Modelos de imagem do Gemini (família "Nano Banana") — FONTE ÚNICA para o app (navegador) e para o
 * runner do GitHub Actions. Os nomes mudam rápido; quando o Google desligar um modelo, basta
 * atualizar a lista aqui.
 *
 * Situação em out/2026 (https://ai.google.dev/gemini-api/docs/deprecations):
 *  • `imagen-3.*` e `gemini-2.0-flash-preview-image-generation` — JÁ DESLIGADOS (nov/2025);
 *  • `gemini-2.5-flash-image` — descontinuado (desligamento previsto a partir de 15/03/2027);
 *  • atuais: `gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3-pro-image`,
 *    `gemini-3.1-flash-lite-image`.
 * Modelos de imagem do Gemini NÃO têm plano gratuito na API: exigem projeto com faturamento ativo.
 *
 * Funções PURAS (sem React/Node/DOM): testadas em geminiImageModels.test.ts.
 */

export interface ImageModelSpec {
  id: string;
  /** Resolução pedida (maiúsculo: "1K"). Ausente = modelo que não aceita `imageSize`. */
  imageSize?: '1K';
}

/**
 * Thumbnail (o TEXTO é desenhado dentro da imagem): do melhor render de texto ao mais barato.
 * 1K em 16:9 = 1376×768, suficiente para a thumbnail final de 1280×720.
 */
export const THUMBNAIL_IMAGE_MODELS: readonly ImageModelSpec[] = [
  { id: 'gemini-nano-banana-2.1', imageSize: '1K' },
  { id: 'gemini-3.1-flash-image', imageSize: '1K' },
  { id: 'gemini-3-pro-image', imageSize: '1K' },
  { id: 'gemini-3.1-flash-lite-image', imageSize: '1K' },
  { id: 'gemini-2.5-flash-image' },
];

/**
 * Cenas do vídeo (sem texto): mantém o modelo que já era o primeiro e acrescenta os atuais como
 * reserva — antes o 2º da lista era um modelo já desligado.
 */
export const SCENE_IMAGE_MODEL_IDS: readonly string[] = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-nano-banana-2.1',
];

/**
 * Variantes de `imageConfig`, da mais completa à mais simples. Um 400 ("parâmetro não aceito")
 * faz o chamador tentar a próxima; a última (undefined) não manda imageConfig nenhum.
 */
export function imageConfigVariants(
  spec: ImageModelSpec,
  aspectRatio = '16:9'
): Array<Record<string, string> | undefined> {
  const variants: Array<Record<string, string> | undefined> = [];
  variants.push(spec.imageSize ? { aspectRatio, imageSize: spec.imageSize } : { aspectRatio });
  if (spec.imageSize) variants.push({ aspectRatio });
  variants.push(undefined);
  return variants;
}

// ---------------------------------------------------------------------------
// Leitura da resposta
// ---------------------------------------------------------------------------

interface InlineData {
  data?: string;
  mimeType?: string;
  mime_type?: string;
}
interface ResponsePart {
  thought?: boolean;
  inlineData?: InlineData;
  inline_data?: InlineData;
  text?: string;
}
interface ImageResponseLike {
  candidates?: Array<{ finishReason?: string; content?: { parts?: ResponsePart[] } }>;
  promptFeedback?: { blockReason?: string };
}

export interface GeneratedImage {
  data: string;
  mimeType: string;
}

/**
 * Devolve a imagem FINAL da resposta. Os modelos Gemini 3 "pensam" e podem devolver imagens
 * intermediárias marcadas com `thought: true` — elas são ignoradas e vale a ÚLTIMA imagem.
 */
export function pickGeneratedImage(response: unknown): GeneratedImage | null {
  const parts = (response as ImageResponseLike | null)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  let found: GeneratedImage | null = null;
  for (const part of parts) {
    if (part?.thought) continue;
    const inline = part?.inlineData ?? part?.inline_data;
    if (typeof inline?.data === 'string' && inline.data.length > 0) {
      found = { data: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png' };
    }
  }
  return found;
}

/** Explica por que a resposta veio sem imagem (bloqueio de segurança ou só texto). */
export function describeNoImage(response: unknown, modelId: string): string {
  const r = response as ImageResponseLike | null;
  const reason = r?.promptFeedback?.blockReason || r?.candidates?.[0]?.finishReason;
  if (reason && /SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(reason)) {
    return `a imagem foi bloqueada pelos filtros de segurança do Gemini (${reason}) em ${modelId}`;
  }
  return `${modelId} respondeu sem imagem (só texto)`;
}

// ---------------------------------------------------------------------------
// Diagnóstico de erros (em português, para o log e para a interface)
// ---------------------------------------------------------------------------

interface ErrorLike {
  status?: number;
  response?: { status?: number };
  message?: string;
}

const statusOf = (err: unknown): number | undefined => {
  const e = err as ErrorLike | null;
  return e?.status ?? e?.response?.status;
};

const messageOf = (err: unknown): string => String((err as ErrorLike | null)?.message ?? err ?? '');

/** Falha passageira (vale repetir o MESMO modelo uma vez): 5xx, timeout ou rede. */
export function isTransientImageError(err: unknown): boolean {
  const status = statusOf(err);
  if (status && status >= 500) return true;
  return /timeout|timed out|tempo esgotado|etimedout|econnreset|socket hang up|network/i.test(messageOf(err));
}

export function describeImageError(err: unknown): string {
  const status = statusOf(err);
  const msg = messageOf(err);
  const low = msg.toLowerCase();

  if (/limit:\s*0/.test(low)) {
    return 'esta chave não tem cota para modelos de imagem (limit: 0). Os modelos de imagem do Gemini (Nano Banana) não têm plano gratuito: ative o faturamento no projeto da chave, no Google AI Studio.';
  }
  if (status === 429 || /resource_exhausted|quota|cota/.test(low)) {
    return 'a cota de geração de imagem desta chave esgotou (ou o faturamento não está ativo — modelos de imagem do Gemini não têm plano gratuito). Aguarde a renovação da cota ou ative o faturamento no Google AI Studio.';
  }
  if (status === 404 || /not found|not_found|no longer available|is deprecated/.test(low)) {
    return 'modelo de imagem indisponível (descontinuado ou sem acesso para esta chave).';
  }
  if (status === 403 || /permission_denied|permission denied|api key not valid/.test(low)) {
    return 'a chave não tem permissão para este modelo de imagem.';
  }
  if (status === 400 || /invalid_argument/.test(low)) {
    return 'o modelo recusou os parâmetros da requisição de imagem.';
  }
  if (/safety|prohibited|bloquead|blocked/.test(low)) {
    return 'a imagem foi bloqueada pelos filtros de segurança do Gemini.';
  }
  if (/timeout|timed out|tempo esgotado|etimedout|econnreset/.test(low)) {
    return 'tempo esgotado ao gerar a imagem.';
  }
  if (status && status >= 500) return `erro temporário nos servidores do Gemini (HTTP ${status}).`;
  return msg || 'erro desconhecido ao gerar a imagem.';
}
