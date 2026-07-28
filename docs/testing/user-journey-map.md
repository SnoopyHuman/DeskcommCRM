# Mapa de Jornadas & Testes E2E — Experiência do usuário em VPS fresca

> Fonte da verdade do QA de produto do DeskcommCRM open-source. Cada caso aqui é
> exercitado **pelo frontend real** (Playwright), com contas de teste reais e
> recursos reais (banco fresco do `baseline.sql`, WAHA local, receiver de webhook
> real). Curl/API só como diagnóstico, nunca como prova de UX.
>
> Persona: **usuário leigo** que rodou o `install.sh` numa VPS e abriu o navegador.
> Ambiente de referência: banco 100% zerado + `bootstrap-owner.ts` (o que o kit faz).

## Convenções

- `[P0]` primeira impressão — bug aqui é vergonha pública; prioridade máxima.
- `[P1]` rotina diária do operador/atendente.
- `[P2]` exploração/edge.
- Resultado: `PASS` / `FAIL(bug#)` / `WARN` (funciona mas UX ruim).
- Evidência: screenshot/trace em `.superpowers/evidence/vps-qa/`.

---

## J1 — Onboarding do primeiro usuário `[P0]`

Contexto do código: sem signup público (`app/(public)/login`); primeiro usuário nasce
do `scripts/bootstrap-owner.ts` (install.sh). Wizard: welcome → whatsapp → (nuvemshop
se `NUVEMSHOP_ENABLED`) → setup-ai → invite-team → done. Gate: `organizations.onboarded_at`.
MFA obrigatório pra admin logo após o wizard (`MfaEnrollGate`).

| # | Caso | Expectativa |
|---|------|-------------|
| J1.1 | Login com credenciais do bootstrap | entra e é redirecionado pro `/onboarding` (org sem `onboarded_at`) |
| J1.2 | Login com senha errada | mensagem clara "Email ou senha incorretos", sem stack |
| J1.3 | Welcome: termos não aceitos | botão avança desabilitado |
| J1.4 | Welcome: nome da org + timezone salvos | grava `display_name`/`timezone`, avança pro WhatsApp |
| J1.5 | Connect WhatsApp: WAHA ativo → QR aparece | sessão criada, QR renderiza via proxy, poll de status roda |
| J1.6 | Connect WhatsApp: "Pular por enquanto" | avança pro step correto (setup-ai quando Nuvemshop off) |
| J1.7 | Setup IA: criar agente default | `ai_agents` criado, avança |
| J1.8 | Invite team: enviar convite SEM Resend configurado (realidade da VPS fresca) | UI **não mente**: mostra que email não saiu + oferece `accept_url` copiável |
| J1.9 | Done: "Ir para o Inbox" | seta `onboarded_at`, cai no `/app/inbox` |
| J1.10 | Gate MFA pós-onboarding | blocker aparece; enrolar TOTP + ver/salvar recovery codes funciona de ponta a ponta |
| J1.11 | Abandonar no meio e voltar (fecha browser no step 3) | retoma exatamente no step pendente |
| J1.12 | Tentar `/app/inbox` antes de concluir | redirect pro onboarding, sem loop |
| J1.13 | Reabrir `/onboarding` depois de concluído | redirect pro app (wizard não reabre) |
| J1.14 | Stepper com Nuvemshop desabilitado | numeração/etapas não quebram visualmente |

## J2 — Conectar WhatsApp e Central de Conexões `[P0]`

| # | Caso | Expectativa |
|---|------|-------------|
| J2.1 | Central lista a sessão criada no onboarding | card com status coerente |
| J2.2 | Conectar novo WhatsApp (admin) | sessão STARTING → SCAN_QR, QR visível no dialog |
| J2.3 | QR escaneado com celular real (**precisa do Rafael**) | status WORKING, card "Conectado" |
| J2.4 | Reconectar sessão | volta a SCAN_QR/WORKING sem duplicar sessão |
| J2.5 | WAHA derrubado (docker stop) | banner claro, botões desabilitados, 503 amigável |
| J2.6 | Atendente (role agent) não vê botão de conectar | gate admin respeitado na UI |
| J2.7 | AntiBanSheet: editar ritmo/janela/teto | salva, persiste em `channel_knobs`, validação de janela |

## J3 — Agentes de IA `[P0]` (criação) / `[P1]` (rotina)

| # | Caso | Expectativa |
|---|------|-------------|
| J3.1 | Agente default do onboarding aparece em `/app/ai/agents` | lista consistente |
| J3.2 | Criar agente novo pelo builder: draft → publicar | bloqueios de publish EXPLICADOS (credencial, número) |
| J3.3 | Knowledge sources: 4 slots visíveis, status honesto | sem "Em breve" enganoso no caminho principal |
| J3.4 | Mensagem inbound → bot responde (WAHA + AI key real) | resposta chega na conversa, `sent_via='bot'` |
| J3.5 | Bot NÃO responde quando humano assumiu (claim) | guard `assignee_kind='user'` |
| J3.6 | Handoff G1 ("quero falar com humano") | conversa vai pra fila humana, aviso visível |
| J3.7 | AI Gateway key ausente | feedback visível (hoje: skip silencioso — candidato a bug de UX) |
| J3.8 | Central de avisos do agente (sino) | eventos aparecem com copy leiga |
| J3.9 | Propostas do flywheel: aplicar bullet | nova versão publicada, badge atualiza |

## J4 — CRM e Pipelines `[P1]`

| # | Caso | Expectativa |
|---|------|-------------|
| J4.1 | Pipeline default existe pra org nova | Kanban abre com 8 colunas |
| J4.2 | Criar lead manual pelo dialog | card aparece na coluna certa |
| J4.3 | Drag-and-drop entre colunas | posição persiste após reload |
| J4.4 | Ganhar lead (mover pra "Pago") | status won + `closed_at` |
| J4.5 | Perder lead exige motivo | sem motivo → validação clara |
| J4.6 | Filtro por owner | leads coerentes com filtro |
| J4.7 | Bulk: mover/taguear 2+ leads | funciona; automações disparam por lead |
| J4.8 | Timeline do contato mostra atividades do lead | merge contato+leads correto |
| J4.9 | Vocabulário customizado (Pedido/Pago/Cancelado) | UI reflete em todo o kanban |
| J4.10 | Editar config de pipeline como agent | 403 amigável |
| J4.11 | Painel de Evolução → CTA da lacuna de funil | leva a Configurações › Funis, não ao quadro (executado 2026-07-27, manager) |
| J4.12 | Mapear passo do agente → etapa e salvar | persiste no reload e em `crm_stages.agent_stage_hint` (executado 2026-07-27) |
| J4.13 | Etapa já usada por outro passo | some das demais listas; volta ao desfazer (executado 2026-07-27) |
| J4.14 | «Ganho»/«Perdido» num funil sem etapa de fechamento | explica o motivo, não mostra lista vazia (executado 2026-07-27) |

## J5 — Time: convites e atuação de atendentes `[P0]` (convite) / `[P1]` (rotina)

| # | Caso | Expectativa |
|---|------|-------------|
| J5.1 | Admin convida atendente pela UI (sem Resend) | UI diz a verdade + accept_url copiável |
| J5.2 | Convidado abre link, cria sessão, aceita | vira membro agent, cai no inbox |
| J5.3 | Atendente vê APENAS fila + suas conversas | escopo RLS na prática |
| J5.4 | Atendente dá claim numa conversa da fila | claim ok; 2º atendente levando 409 amigável |
| J5.5 | Transferir conversa pra colega | imediata, contador de não-lidas zera pro novo dono |
| J5.6 | Atendente tenta ver billing/api-tokens | 403 página amigável |
| J5.7 | Revogar atendente | perde acesso na hora (próxima navegação) |
| J5.8 | Revogar último admin | bloqueado com explicação |
| J5.9 | Link de convite expirado/adulterado | tela clara, sem stack |

## J6 — Webhooks: receber, automatizar, provar `[P0]`

| # | Caso | Expectativa |
|---|------|-------------|
| J6.1 | Criar fonte de dados pela UI | URL pública + snippets exibidos |
| J6.2 | "Enviar lead de teste" | toast de sucesso + lead visível no Kanban + feed atualiza |
| J6.3 | POST externo real (curl de "Zapier") | lead entra; feed mostra recebimento; idempotência por external_id |
| J6.4 | HMAC: fonte com secret + assinatura errada | 401; feed marca inválido |
| J6.5 | Criar regra: lead com utm instagram → tag | regra nasce pausada; ativar pelo switch |
| J6.6 | Drain roda → regra executa | tag aplicada; aba Atividade mostra run Sucesso |
| J6.7 | Ação call_webhook → receiver local REAL | payload chega no receiver; envelope sem org_id/cpf |
| J6.8 | call_webhook com URL interna (SSRF) | bloqueado com erro claro |
| J6.9 | Run falho → botão Reenviar | novo run; sucesso após receiver voltar |
| J6.10 | Automação SEM cron configurado | hoje: morre em silêncio — **candidato a bug de produto** |

## J7 — Exploração completa `[P2]`

Andar por TODAS as rotas navegáveis logado como admin e como agent: settings, contacts,
LGPD anonymize, /admin (platform), error pages (403/503/not-found), estados vazios.
Critério: nenhuma tela quebra, nenhum stack trace, nenhum texto de erro cru.

---

## Achados do mapeamento (pré-execução) — candidatos a correção

| ID | Achado | Origem | Severidade |
|----|--------|--------|-----------|
| M1 | `supabase/config.toml` trava `major_version = 15`, mas `baseline.sql` exige PG17 (`GRANT MAINTAIN`) — contribuidor open-source não sobe ambiente local | reproduzido | Alta (DX) |
| M2 | Trilha manual do `docs/deploy-selfhost/README.md` não configura o cron do drain → automações mortas em silêncio | explorer webhooks | Alta |
| M3 | README self-host aponta repo/imagem `deskcommcrm/*`; kit usa `melgarafael/*` | explorer webhooks | Alta |
| M4 | `INVITE_TOKEN_SECRET` ausente → fallback `"dev-fallback"` → convite forjável em VPS mal configurada | explorer CRM/time | Alta (segurança) |
| M5 | AI Gateway key ausente → bot mudo sem NENHUM feedback na UI | explorer IA | Média |
| M6 | Knowledge sources: botões de upload/configurar são stubs "Em breve" | explorer IA | Média |
| M7 | Enviar mensagem com canal não-WORKING fica `queued` silencioso | explorer WhatsApp | Média |
| M8 | Kanban: colisão de fractional index aborta drag sem feedback | explorer CRM | Baixa |
| M9 | Toasts com códigos crus (`db_error`, `invalid_input`) no onboarding | explorer onboarding | Baixa |
| M10 | Onboarding: pular WhatsApp redirecionava hardcoded pro connect-nuvemshop (step oculto quando Nuvemshop off) | execução J1.6 | Alta (travava wizard) |
| M11 | Onboarding: convite sem Resend redirecionava em silêncio, sem dar o accept_url | execução J1.8 | Alta |
| M12 | MFA gate: revalidação do Server Action desmontava o modal e o usuário nunca via os recovery codes | execução J1.10 | Crítica |

## Ordem de execução

1. **Fase A `[P0]` primeira impressão:** J1 completo → J2.1-2.2/2.5-2.6 → J5.1-5.2 → J6.1-6.3.
2. **Fase B rotina:** J4, J5.3-5.9, J6.4-6.9, J3.1-3.3.
3. **Fase C IA viva + WhatsApp real:** J3.4-3.9, J2.3-2.4 (com Rafael no QR).
4. **Fase D exploração:** J7 + edge cases restantes.

## Bugs corrigidos nesta rodada de QA

| Bug | Arquivo | Correção |
|-----|---------|----------|
| M10 | `app/actions/onboarding/skipWhatsapp.ts` | `skipWhatsapp`/`markWhatsappConfigured` redirecionam pro roteador `/onboarding`, não pro step fixo |
| M11 | `app/actions/onboarding/sendOnboardingInvites.ts` + `invite-team/_form.tsx` | retorna `undelivered[]` com accept_url; UI mostra links copiáveis quando email falha |
| M12 | `components/auth/MfaEnrollGate.tsx` + `app/app/layout.tsx` | gate latcha a decisão client-side; revalidação não derruba mais a tela de recovery codes |
