/**
 * Consome `media.derive_requested`: baixa a mídia persistida (Onda 0), gera o
 * derivado textual model-agnóstico (transcrição/visão/pdf) e grava em
 * messages.media_derived_text. Camada UNIVERSAL da Onda 3 — o texto alimenta
 * qualquer modelo de chat. Retry/backoff delegados ao drain (padrão do repo).
 */
import { generateText } from "ai";
import type pg from "pg";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { resolveOrgLlmConfig, type LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createPool } from "@/lib/agent-engine/db/pool";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { deriveVideoText } from "@/lib/messaging/media/video-derive";
import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const MEDIA_DERIVE_CONSUMER_KEY = "media_derive_v1";
const DRAIN_MAX_ATTEMPTS = 5; // espelho de lib/event-log/drain.ts

// Lista compartilhada com o drain do turno — ver lib/messaging/media/derivable.ts.

// ponytail: singleton lazy — o drain só nos dá o admin client; resolveOrgLlmConfig
// exige pg.Pool direto. Sem pool global no processo Next.js, então criamos um sob
// demanda (nunca no import). `pg.Pool` só conecta na primeira query — se
// SUPABASE_DB_URL faltar, o erro aparece ali (capturado pelo try/catch abaixo),
// não na construção.
let _pool: pg.Pool | null = null;
function derivePool(): pg.Pool {
  if (!_pool) _pool = createPool(process.env.SUPABASE_DB_URL ?? "");
  return _pool;
}

interface MessageRow {
  id: string;
  organization_id: string;
  type: string;
  media_mime: string | null;
  media_storage_path: string | null;
  media_derived_status: string | null;
}

export async function deriveMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_DERIVE_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select("id, organization_id, type, media_mime, media_storage_path, media_derived_status")
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageRow | null;
  if (!msg?.media_storage_path) return { consumer_key, status: "skipped", detail: "no media" };
  if (msg.media_derived_status === "ready") return { consumer_key, status: "skipped", detail: "already derived" };
  if (!TIPOS_DERIVAVEIS.has(msg.type)) return { consumer_key, status: "skipped", detail: `type ${msg.type}` };
  // Vídeo é opt-in (custo: ffmpeg + N chamadas de visão): só deriva se algum agente
  // publicado da org tem video_frames_enabled=true (flag da migration 0058).
  if (msg.type === "video") {
    const { data: flag } = await admin
      .from("ai_agent_versions")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("status", "published")
      .eq("video_frames_enabled", true)
      .limit(1)
      .maybeSingle();
    if (!flag) return { consumer_key, status: "skipped", detail: "video_frames_disabled" };
  }

  const markFailed = async () => {
    await admin.from("messages").update({ media_derived_status: "failed" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
  };

  try {
    const dl = await admin.storage.from("whatsapp-media").download(msg.media_storage_path);
    if (dl.error || !dl.data) throw new Error(`storage_download_failed: ${dl.error?.message ?? "no_data"}`);
    const buffer = Buffer.from(await dl.data.arrayBuffer());

    // Credencial BYOK da org p/ visão (imagem).
    const llmCfg: LlmEdgeConfig = {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      cacheTtl: "1h",
    };
    const llm = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id);

    // A transcrição é SEMPRE do Whisper (api.openai.com), então precisa de uma
    // chave OpenAI — não da chave do provedor de chat da org. O comentário
    // antigo já dizia isso ("senão exige credencial openai dedicada"), mas o
    // código passava `llm.apiKey` direto: numa org com Anthropic, a chave da
    // Anthropic era enviada para a OpenAI e voltava 401 em toda tentativa
    // (visto nesta VPS: media.derive_requested preso com transcription_401,
    // e o cliente ouvindo "não consigo ouvir áudio" com a chave certa no .env).
    let openaiKey: string | null = null;
    if (llm.provider === "openai") {
      openaiKey = llm.apiKey;
    } else {
      try {
        const oa = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id, {
          provider: "openai",
        });
        openaiKey = oa.apiKey;
      } catch {
        openaiKey = null; // sem credencial e sem OPENAI_API_KEY: áudio fica sem transcrição
      }
    }

    const deps = buildDeriveDeps(llm, openaiKey, row.organization_id);

    const text = await deriveMediaText(msg.type, buffer, msg.media_mime ?? "application/octet-stream", deps);
    await admin.from("messages")
      .update({ media_derived_text: text, media_derived_status: "ready" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (row.attempts >= DRAIN_MAX_ATTEMPTS - 1) {
      logger.error("[media-derive] failed permanently", { message_id: msg.id, detail });
      await markFailed();
    }
    return { consumer_key, status: "error", detail };
  }
}

function buildDeriveDeps(
  llm: { provider: string; apiKey: string; defaultModel: string | null },
  openaiKey: string | null,
  orgId: string,
): DeriveDeps {
  const registry = createDefaultRegistry();
  const visionCapable = modelCapabilities(llm.provider, llm.defaultModel ?? "").image;
  const describeImage: DeriveDeps["describeImage"] = async (buffer, mime) => {
    // ─── Falha VISÍVEL, não string vazia ────────────────────────────────────
    //
    // Antes daqui, modelo sem visão devolvia "" e pronto: o cliente mandava a
    // foto do produto ou o comprovante, o agente respondia como se nada tivesse
    // chegado, e não havia erro, log nem aviso em lugar nenhum. Para quem
    // instalou, o produto parecia estar ignorando o cliente de propósito.
    //
    // Agora o texto derivado DIZ que a mídia não pôde ser lida — o agente passa
    // a saber que recebeu algo que não consegue interpretar, em vez de achar
    // que a mensagem veio vazia — e um aviso abre na Central para o operador
    // poder agir (invariante 7 da doutrina do Sistema Vivo: todo laço se fecha).
    if (!visionCapable) {
      await avisarMidiaNaoLida(orgId, "imagem", `o modelo ${llm.defaultModel ?? "configurado"} não enxerga imagens`);
      return MARCADOR_NAO_LIDA;
    }
    const factory = registry[llm.provider];
    if (!factory) {
      await avisarMidiaNaoLida(orgId, "imagem", `o provedor ${llm.provider} não está disponível nesta instalação`);
      return MARCADOR_NAO_LIDA;
    }
    const res = await generateText({
      model: factory(llm.apiKey, llm.defaultModel ?? ""),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Descreva objetivamente esta imagem em 1-2 frases, em português, para um atendente de vendas entender o que o cliente enviou." },
            // AI SDK v7: file part com mediaType (o antigo image part é deprecated).
            { type: "file", data: buffer, mediaType: mime.split(";")[0]! },
          ],
        },
      ],
    });
    return res.text;
  };
  // Sem chave OpenAI não há como transcrever: devolver string vazia é honesto
  // (o derivado fica vazio e o marcador "[áudio]" continua valendo) e evita o
  // loop de 401 que retentava a cada drain.
  const transcriber: DeriveDeps["transcriber"] = openaiKey
    ? apiTranscriptionProvider({ apiKey: openaiKey })
    : {
        transcribe: async () => {
          // Mesma razão da visão: devolver "" fazia o agente responder ao áudio
          // como se ele não existisse. O aviso é o que dá ao operador a chance
          // de cadastrar a chave — sem ele, o sintoma é indistinguível de "o
          // agente é ruim".
          await avisarMidiaNaoLida(orgId, "áudio", "falta uma chave da OpenAI para transcrever");
          return MARCADOR_NAO_LIDA;
        },
      };
  return {
    transcriber,
    describeImage,
    extractPdf: extractPdfText,
    // Onda 3.1: vídeo → ffmpeg (áudio+frames) reusando transcrição e visão da org.
    deriveVideo: (buffer) => deriveVideoText(buffer, { transcriber, describeImage }),
  };
}

/**
 * O texto que substitui a string vazia quando a mídia não pôde ser lida.
 *
 * Não é cosmético: o agente recebe este texto como derivado da mensagem, então
 * ele passa a SABER que chegou algo que não conseguiu interpretar, em vez de
 * concluir que a mensagem veio vazia. A diferença aparece na resposta ao
 * cliente — "não consegui abrir sua foto, pode me dizer o que é?" no lugar de
 * um silêncio que parece descaso.
 */
export const MARCADOR_NAO_LIDA = "[o cliente enviou uma mídia que não consegui interpretar]";

/**
 * Abre UM aviso na Central por organização enquanto o problema durar.
 *
 * Um aviso por mensagem inundaria a Central numa operação com volume — e
 * Central inundada é Central que ninguém abre, que é como o alerta morre. A
 * condição de não-duplicar é a mesma que `budget_exceeded` já usa: enquanto
 * houver item aberto do mesmo kind, recusas novas não criam outro.
 *
 * Fire-and-forget: falhar ao avisar não pode derrubar a derivação da mídia.
 */
async function avisarMidiaNaoLida(
  organizationId: string,
  tipo: string,
  motivo: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "midia_nao_lida")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;

    await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "midia_nao_lida",
      severity: "warning",
      title: `O agente não conseguiu ler ${tipo} que o cliente enviou`,
      body:
        `Motivo: ${motivo}. Enquanto isso, o agente responde avisando que não conseguiu abrir o arquivo. ` +
        `Para resolver, ajuste o modelo desse ponto em Agente de IA → Provedores, ou cadastre a chave necessária em Credenciais.`,
    });
  } catch (err) {
    logger.warn("[media-derive] não consegui abrir o aviso de mídia não lida", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
