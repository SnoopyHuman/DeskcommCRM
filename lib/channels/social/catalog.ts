/** Networks offered by the partner. Inbox support is deliberately narrower than OAuth. */
export const SOCIAL_NETWORKS = [
  { id: "instagram", label: "Instagram", inbox: true },
  { id: "facebook", label: "Facebook", inbox: true },
  { id: "linkedin", label: "LinkedIn", inbox: false },
  { id: "twitter", label: "X", inbox: false },
  { id: "tiktok", label: "TikTok", inbox: false },
  { id: "youtube", label: "YouTube", inbox: false },
  { id: "threads", label: "Threads", inbox: false },
  { id: "reddit", label: "Reddit", inbox: false },
  { id: "pinterest", label: "Pinterest", inbox: false },
  { id: "bluesky", label: "Bluesky", inbox: false },
  { id: "googlebusiness", label: "Google Business", inbox: false },
  // "telegram" NÃO entra aqui: era uma entrada `inbox: false` nunca
  // conectada a nada (nenhum outro arquivo a referenciava) — e o Telegram
  // ganhou canal NATIVO próprio (Bot API, não intermediado pelo Zernio),
  // com `telegram` já ocupando o vocabulário de `ChannelProvider`. Manter os
  // dois — o id morto aqui e o provider vivo em `lib/channels/types.ts` —
  // seria a mesma string significando duas coisas diferentes, e é
  // exatamente essa ambiguidade que `rede-social-sem-canal-no-banco-nao-
  // vira-500.test.ts` acusou ao testar `CANAIS_DE_CONVERSA`.
  { id: "snapchat", label: "Snapchat", inbox: false },
  { id: "discord", label: "Discord", inbox: false },
  { id: "slack", label: "Slack", inbox: false },
] as const;
export type SocialPlatform = (typeof SOCIAL_NETWORKS)[number]["id"];
export const SOCIAL_PROVIDER_LABEL = "Zernio";
export const SOCIAL_PROVIDER = "zernio_social" as const;
export const inboxSupported = (platform: string): boolean =>
  SOCIAL_NETWORKS.some((network) => network.id === platform && network.inbox);
export function socialMessageId(account: string, id: string): string {
  return `social:${account}:${id}`;
}
