/**
 * O vocabulário da timeline — fonte ÚNICA, escrita e leitura.
 *
 * Esta é a terceira vez, nesta entrega, que duas listas de strings que
 * precisavam concordar viviam em arquivos diferentes: o LGPD dizia
 * `customer_redact` e o banco exigia `redact`; os workers filtravam pelo
 * vocabulário errado; e aqui a tela conhecia 13 rótulos com ponto
 * (`lead.stage_changed`) enquanto o banco grava 5 com underscore
 * (`stage_changed`). Interseção: ZERO. Toda linha que já existiu caiu no
 * fallback e mostrou o nome cru do tipo.
 *
 * O gate é o compilador: `ACTIVITY_LABELS` é `Record<ActivityType, string>`
 * EXAUSTIVO. Tipo novo sem rótulo não compila — não existe caminho para
 * divergir em silêncio de novo.
 *
 * Deliberadamente SEM check constraint no banco: um clone com tipo legado que
 * não conhecemos quebraria no `update.sh` (doutrina de migrations). O banco
 * aceita; quem escreve daqui é que fica preso ao vocabulário.
 */
export type ActivityType =
  | "stage_changed"
  | "note"
  | "ai_turn"
  | "send_vetoed"
  | "handoff_triggered"
  | "next_action_approved"
  | "next_action_dismissed"
  | "lead_edited"
  | "lead_cooled"
  | "lead_reactivated"
  | "reactivation_accepted"
  | "reactivation_dismissed"
  | "reactivation_expired";

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  stage_changed: "Mudou de estágio",
  note: "Anotação",
  ai_turn: "Atendimento da IA",
  send_vetoed: "Envio bloqueado",
  handoff_triggered: "Passou para humano",
  // A RECUSA é sinal, não ausência de sinal: "o humano viu e disse não" é o que
  // impede o agente de repropor o mesmo. Ignorar sem registro faz a IA insistir
  // no que já foi negado — por isso os dois lados geram atividade.
  next_action_approved: "Próxima ação aprovada",
  next_action_dismissed: "Próxima ação descartada",
  // Editar campo era INVISÍVEL na timeline: a IA deixava rastro e o humano não.
  // Não era "falta um emissor" — era meia continuidade vendida como
  // continuidade, e o dossiê teria mostrado só metade da vida do lead.
  lead_edited: "Dados do negócio alterados",
  // O NEGÓCIO ESFRIANDO É ACONTECIMENTO, não telemetria: é o sistema dizendo
  // "ninguém falou com esta pessoa dentro do prazo deste estágio". Sem linha na
  // timeline, o card mudaria de cor e o dossiê não teria explicação — e o
  // usuário concluiria que a timeline está incompleta, não que o negócio esfriou.
  lead_cooled: "Negócio esfriou",
  lead_reactivated: "Negócio voltou a andar",
  // As três decisões sobre a proposta de reativação. VENCER é uma delas: a
  // ausência de decisão humana é informação sobre o negócio, e a proposta some
  // do card justamente para não simular atenção — a timeline é onde isso fica
  // dito, senão o botão sumiria sem explicação.
  reactivation_accepted: "Retomada de contato aprovada",
  reactivation_dismissed: "Retomada de contato descartada",
  reactivation_expired: "Sugestão de retomada venceu sem decisão",
};

/** Quando o tipo é legado/desconhecido, a linha ainda é honesta — sem jargão. */
export const ACTIVITY_LABEL_FALLBACK = "Atividade registrada";

/**
 * Rótulo para exibir. Aceita `string` porque o banco tem histórico anterior a
 * este vocabulário — o que não se pode é ESCREVER fora dele.
 *
 * O fallback NÃO devolve o identificador cru: era exatamente isso que punha
 * "stage_changed" no rosto do usuário, e reintroduzir aqui seria trazer de
 * volta, pelo lado da leitura, o defeito que este arquivo existe para matar.
 * Nenhum teste pegaria: "stage_changed" não é uuid, então a asserção que caça
 * uuid na tela continuaria verde.
 */
export function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type as ActivityType] ?? ACTIVITY_LABEL_FALLBACK;
}

/** Como o marcador do ator é desenhado (BRIEFING §5: forma, nunca cor). */
export type ActivityActorShape = "filled" | "ring" | "dashed";

/**
 * TRÊS desenhos, os mesmos do card: preenchido = gente, anel = agente,
 * tracejado = nem um nem outro.
 *
 * A forma carrega a leitura GROSSA (foi gente / foi agente / não foi nenhum dos
 * dois); a distinção fina entre "Automação" e "Autor não registrado" já está no
 * TEXTO, que fica ao lado. Um quarto desenho obrigaria o usuário a decorar um
 * alfabeto no kanban e outro na timeline, para dizer o que a palavra já diz.
 */
export function actorShape(actorKind: string | null): ActivityActorShape {
  if (actorKind === "user" || actorKind === "contact") return "filled";
  if (actorKind === "ai") return "ring";
  return "dashed";
}

/**
 * QUEM agiu, com nome quando se sabe o nome.
 *
 * "Agente" e "Você/time" respondem o TIPO de ator; numa org com três agentes e
 * cinco atendentes, isso não responde a pergunta que o humano faz olhando a
 * timeline, que é "quem fez isso?". O genérico vira último recurso — e continua
 * existindo porque nome pode faltar (agente apagado, usuário sem full_name).
 */
export function actorName(
  actorKind: string | null,
  nomes: { agente?: string | null; usuario?: string | null } = {},
): string {
  if (actorKind === "ai" && nomes.agente) return nomes.agente;
  if ((actorKind === "user" || actorKind === "contact") && nomes.usuario) return nomes.usuario;
  return actorLabel(actorKind);
}

/**
 * Quem agiu, em uma palavra — vai ao lado do rótulo na linha.
 *
 * SEMPRE devolve texto, porque `actorShape` sempre desenha: marcador sem
 * legenda é ruído que o leitor não consegue decifrar. As duas funções têm de
 * concordar, inclusive no caso desconhecido.
 */
export function actorLabel(actorKind: string | null): string {
  switch (actorKind) {
    case "user":
      return "Você/time";
    case "ai":
      return "Agente";
    case "contact":
      return "Cliente";
    case "rule":
      return "Automação";
    case "system":
      return "Sistema";
    default:
      return "Autor não registrado";
  }
}

/** Como os campos do lead se chamam para quem lê — nunca o nome da coluna. */
const NOME_DO_CAMPO: Record<string, string> = {
  title: "o título",
  description: "a descrição",
  value_cents: "o valor",
  currency: "a moeda",
  owner_user_id: "o responsável",
  owner_agent_id: "o agente responsável",
  expected_close_date: "a data prevista de fechamento",
  tags: "as tags",
  custom_fields: "os campos personalizados",
  lost_reason: "o motivo da perda",
};

/**
 * "o título e o valor" — a lista de campos alterados, legível.
 *
 * ⚠️ NOMES, NUNCA VALORES. Esta função existe para dizer O QUE mudou sem dizer
 * PARA QUÊ. Acrescentar o conteúdo aqui vazaria PII para uma linha que aparece
 * na tela, em captura e em exportação — e a tentação é real, porque "mostrar o
 * valor" parece só deixar a timeline mais informativa. Quem precisa do valor
 * tem o `api_audit_log`, sob controle de acesso.
 *
 * Campo desconhecido cai no próprio nome em vez de sumir: uma coluna nova
 * apareceria na timeline como `expected_close_date`, feio mas honesto — some
 * seria pior, porque a frase diria menos do que aconteceu.
 */
export function listaLegivel(campos: string[]): string {
  const nomes = campos.map((c) => NOME_DO_CAMPO[c] ?? c);
  if (nomes.length === 0) return "nada";
  if (nomes.length === 1) return nomes[0]!;
  return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]!}`;
}
