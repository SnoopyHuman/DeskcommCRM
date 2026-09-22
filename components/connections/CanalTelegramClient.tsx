"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Conectar um bot do Telegram.
 *
 * ─── Por que não há um passo 2 de "cole o webhook" ──────────────────────────
 *
 * No canal parceiro, o CRM fala com o provedor, mas o provedor só fala de
 * volta se o operador colar URL e segredo manualmente num painel externo. No
 * Telegram não existe esse painel: o próprio CRM registra o webhook na Bot
 * API assim que o token é validado (`setWebhook`). Por isso esta tela não tem
 * `ParaColar` nem segredo nenhum — só um aviso de que já está tudo ligado.
 */

interface Estado {
  label: string;
  connected: boolean;
  channel_session_id: string | null;
  bot_username: string | null;
  display_name: string | null;
  status: string | null;
  has_token: boolean;
  endpoint: string;
  webhook_url: string | null;
}

interface Conectado {
  connected: true;
  bot_username: string | null;
  display_name: string | null;
  webhook_url: string;
}

export function CanalTelegramClient() {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [token, setToken] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [recemConectado, setRecemConectado] = useState<Conectado | null>(null);

  const carregar = async () => {
    try {
      const r = await apiClient.get<{ data: Estado }>("/api/v1/channels/telegram");
      setEstado(r.data);
    } catch {
      // Falha de leitura não deve travar a tela: o formulário continua servindo.
      setEstado(null);
    }
  };

  useEffect(() => {
    void carregar();
  }, []);

  const conectar = async () => {
    setSalvando(true);
    try {
      const r = await apiClient.post<{ data: Conectado }>("/api/v1/channels/telegram", {
        token,
      });
      setRecemConectado(r.data);
      // O token sai da memória da tela assim que é gravado: ele não volta num
      // GET, e deixá-lo no input só cria uma cópia a mais de um segredo.
      setToken("");
      toast.success(t("Bot conectado."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(false);
    }
  };

  const conectado = estado?.connected ?? false;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{t("Conectar por")} Telegram</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Um bot do Telegram conectado a este CRM. As mensagens do bot entram e saem pelo Inbox.",
              )}
            </p>
          </div>
          {conectado ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

        {conectado && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">
              {estado?.display_name ?? estado?.bot_username ?? t("Bot conectado")}
            </p>
            <p className="text-xs text-muted-foreground">
              {estado?.bot_username ? `@${estado.bot_username}` : t("sem usuário informado")} ·{" "}
              {estado?.status ?? "—"}
            </p>
          </div>
        )}

        {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="telegram-token">{t("Token do bot")}</Label>
            <Input
              id="telegram-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                estado?.has_token ? t("gravado — preencha para trocar") : "123456789:ABC-..."
              }
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("Crie um bot com @BotFather no Telegram e cole o token aqui.")}
            </p>
          </div>

          <div>
            <Button onClick={conectar} disabled={salvando || !token}>
              {salvando ? t("Verificando…") : conectado ? t("Reconectar") : t("Conectar")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("O token é testado contra o Telegram antes de ser gravado.")}
            </p>
          </div>
        </div>
      </Card>

      {recemConectado && (
        <Card className="flex flex-col gap-3 border-warning/40 bg-warning-bg p-4">
          <div>
            <h3 className="text-sm font-semibold">{t("Bot conectado")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("O Telegram já está mandando mensagens para o CRM. Não é preciso configurar mais nada.")}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("URL do webhook registrada")}
            </span>
            <code className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
              {recemConectado.webhook_url}
            </code>
          </div>
        </Card>
      )}
    </div>
  );
}
