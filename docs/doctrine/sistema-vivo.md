# Doutrina do Sistema Vivo — DeskcommCRM

> Lei de arquitetura. Todo desenvolvimento neste repo obedece a isto — não é aspiração, é critério de aceite (ver o item "Living System Checklist" no Definition of Done, `CLAUDE.md`).

---

## O princípio-raiz

O DeskcommCRM é um **sistema vivo**, não um CRUD com telas. Ele existe para uma única missão:

> Chegou uma demanda — um lead interessado ou um usuário com um problema — e o sistema é **responsável pela linha do tempo inteira dessa demanda até a resolução ou o encerramento declarado pelo próprio lead.**

Nada pode morrer no sistema por falta de resolução, resposta, ou porque ninguém viu que havia algo ali precisando de atenção. Toda peça é um tentáculo orquestrado para não deixar nenhuma informação do lead escapar e nenhuma necessidade dele passar sem visibilidade na tela.

Onde a IA termina, começa uma continuidade contextualizada para o humano. Onde o humano termina, há um input estruturado para a IA retomar com contexto. Onde ambos param, há histórico legível do que foi feito.

---

## Os 5 invariantes (verificáveis)

Cada invariante é uma pergunta que uma feature responde **antes do merge**. Se não responde, ainda não está viva.

### 1. Regra das 2 conexões — nada é ilha
Toda peça da arquitetura tem no mínimo **uma aresta de entrada e uma de saída** no grafo do sistema. A peça de origem é um polvo: distribui para áreas. Uma feature que só recebe (ou só emite) e não alimenta nada está morta por definição.

- **Anti-exemplo:** "sistema de atendentes" como CRUD de usuários. **Vivo:** atendente = atribuição + carga/capacidade + métricas + relatório + log de atividade + destino de handoff da IA.
- **Verificação:** a peça aparece no mapa (`docs/architecture/`) com ≥2 arestas reais (não decorativas).

### 2. Continuidade IA↔humano nas duas direções
- **IA → humano:** quando a IA para (handoff, veto de gate, incerteza), o humano recebe **contexto pronto para continuar** — um resumo do que aconteceu e por quê, não a conversa crua.
- **Humano → IA:** quando o humano para (responde, atribui, agenda), fica um **input estruturado** que a IA lê para retomar com contexto.
- **Verificação:** existe o payload/registro de continuidade nas duas direções, não só o roteamento.

### 3. Log universal e visível
Toda mutação relevante — mexida em lead, agente, follow-up agendado, atribuição de atendente, mudança de estágio — gera **atividade**. E não só no banco (`event_log` / `api_audit_log` / `crm_lead_activities`): aparece **na tela** como timeline/insight. Log invisível é log morto.

- **Verificação:** a mutação emite atividade E há um lugar na UI onde ela é lida como parte da linha do tempo.

### 4. Nenhuma demanda sem próximo passo — follow-up é o anti-morte
Follow-up não é uma feature de agendamento; é o **mecanismo que mantém o lead/usuário vivo** até a demanda ser resolvida ou o próprio lead declarar encerrada. O invariante operacional: **nenhuma demanda aberta sem um próximo passo definido e visível.**

- **Verificação:** para toda demanda aberta existe (a) um próximo passo, ou (b) uma resolução/encerramento registrado. Uma demanda sem nenhum dos dois é um vazamento — o sistema falhou na missão.

### 5. Informação com propósito
Todo dado exibido responde "**por que estou vendo isto e o que faço a seguir**". Traz insight/direção, não só estado. Um número na tela que não muda uma decisão é ruído.

- **Verificação:** cada elemento de dado tem um "e daí?" — leva a uma ação, uma priorização, ou um alerta.

---

## Living System Checklist

Cole isto (ou responda mentalmente) em **toda feature/refactor** antes de declarar pronto. É um item do Definition of Done (`CLAUDE.md`).

```
Living System Checklist — <nome da feature>
[ ] Quem me alimenta?  (aresta de entrada — fonte real, não inventada)
[ ] Quem eu alimento?  (aresta de saída — a peça é um polvo, distribui)
[ ] Que atividade/log eu emito?  (event_log / audit / crm_lead_activities)
[ ] Onde eu apareço na tela?  (timeline/insight — não só no banco)
[ ] Qual meu mecanismo anti-morte?  (próximo passo garantido, ou N/A justificado)
[ ] Qual a continuidade IA↔humano?  (payload de handoff nas duas direções, se aplicável)
[ ] Atualizei o mapa vivo?  (docs/architecture/*.json + re-render archify se a arquitetura mudou)
```

Uma feature que responde "nenhum" a *quem eu alimento* ou *onde apareço na tela* é uma ilha. Desilhe antes do merge, ou registre explicitamente por que é uma exceção legítima.

---

## O mapa vivo é parte do sistema

A doutrina só é navegável e monitorável se materializada visualmente. Dois artefatos mantêm o sistema legível:

- **archify** (`docs/architecture/`) — diagramas curados de sistema, turno do agente e flywheel. **Fonte da verdade = os `.json`.** Mudou a arquitetura? Atualize o JSON e re-renderize (ver `docs/architecture/README.md`). Uma peça nova entra no mapa **com ≥2 arestas** antes do merge.
- **graphify** (`graphify-out/`) — grafo determinístico do repo inteiro (nós, comunidades, arestas). Use `graphify query "<pergunta>"` para achar ilhas e orientar antes de ler fontes.

Regra: **mudança de arquitetura não fecha sem o mapa refletir.** O diagrama desatualizado é uma ilha de informação — viola o invariante 3.

---

## Estado atual — o que já está vivo (auditoria 2026-07-24)

Primeira passada ancorada no grafo (`graphify`) + `docs/architecture/`. A doutrina já é majoritariamente vivida:

**Vivo (confirmado no grafo):**
- `event_log` + `lib/event-log/dispatcher.ts` — nada acontece sem evento; trigger nunca faz HTTP.
- `lib/audit/index.ts` `audit()` — mutação → `api_audit_log` append-only.
- Atendentes com status/carga/capacidade/horário/disponibilidade + **Performance por Atendente** (ganhos, perdidos, conversas, 1ª resposta média).
- **IA como assignee de 1ª classe** (`assignee_kind user|ai`) + Modo de Roteamento — handoff IA→humano existe.
- Flywheel de auto-aprimoramento com gate humano; `createFollowupTurnHandler` (follow-up conduzido pelo agente).
- 7 gates before-send com veto instrutivo de volta ao modelo (continuidade IA→modelo).

**Verificado em código (2026-07-24):**
1. ✅ **Timeline de `crm_lead_activities` renderizada** — VIVO. `components/inbox/CRMSidePanel.tsx` busca `crm_lead_activities` e renderiza como feed no inbox (API `app/api/v1/contacts/[id]/timeline/route.ts`). *Nuance:* o feed vive no inbox, não no card do pipeline — desilhar o card seria o próximo passo se o operador trabalhar direto do Kanban. (invariante 3)
2. ✅ **Payload de continuidade IA→humano** — VIVO. `buildHandoffSummary()` (`lib/agent-engine/agent/human-handoff.ts:252`) monta resumo contextual (rolling summary + compromissos + objeções + próxima ação) e vai ao inbox do humano, nunca a log. (invariante 2)
3. ⚠️ **Follow-up como invariante de lead — ILHA PARCIAL (gap confirmado).** O mecanismo anti-morte é forte no *engine* (`schedule-followup.ts`, `followup-turn.ts`, `cron/scheduler.ts`, `edge/crm/session-watchdog.ts`, re-entrada determinística), mas **todo o domínio vive só em `lib/agent-engine/**` e `workers/**` — zero UI.** Não há tela agregada onde o humano veja leads com follow-up pendente / em risco de morrer. Invariante 4 satisfeito para a IA, **invisível para o humano.** É o desilhamento prioritário: um painel/insight de "demandas em voo e em risco" fecha a alça de saída do engine de follow-up para o olho humano. (invariantes 4 + 5)

> Auditoria linha-a-linha via `graphify` + leitura de fontes. C1 é o backlog de desilhamento real; C2/C3 confirmados vivos.

---

## Enforcement — como a doutrina se perpetua

| Camada | Artefato | Garante |
|---|---|---|
| Mentalidade | Skill `sistema-vivo` (`.claude/skills/`) | Injeta o checklist em toda feature/refactor |
| Gate de sessão | Item "Living System Checklist" no DoD (`CLAUDE.md`) | Nenhuma task fecha sem responder o checklist |
| Contexto persistente | Memória de projeto | Sessões futuras carregam a doutrina |
| Mapa vivo | archify + graphify | Peça nova aparece com ≥2 arestas |

**Rung futuro (opcional, não construído):** enforcement mecânico via CI/hook — ex.: teste que exige que toda tabela tenant-aware nova declare sua estratégia de activity log. Gates de *mentalidade* vivem melhor em skill+DoD (hábito) do que em hook frágil (ruído). Adicionar só se a doutrina começar a vazar na prática.
