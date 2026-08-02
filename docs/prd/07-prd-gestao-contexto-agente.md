---
title: Sub-PRD 07 — Ciclo de Vida do Contexto do Agente
parent: 00-prd-master.md
depends_on: 01-prd-platform-base.md, 02-prd-customer-360.md, 04-prd-pipeline-attendance.md, 05-prd-ai-rag-handoff.md
version: 0.1
status: em revisão
date: 2026-08-02
owner: Renan Brandão
referencia_arquitetural: docs/specs/05-spec-ai-rag-handoff.md, docs/specs/10-spec-ai-agents-runtime.md
---

# Sub-PRD 07 — Ciclo de Vida do Contexto do Agente

> Define **quanto tempo o agente lembra** e **o que ele nunca esquece**. Hoje o agente reconstrói contexto lendo o histórico bruto da conversa mais o checkpoint acumulado do contato — sem nenhuma noção de que uma jornada terminou ou de que meses se passaram. O resultado é um agente que retoma um pedido encerrado como se fosse de ontem, e que cita preço, estoque e endereço que já mudaram. Este sub-PRD introduz três camadas de esquecimento (fronteira de sessão, expiração por etapa, reset manual) e uma **ficha do cliente que sobrevive a todas elas** — porque esquecer a conversa não pode virar esquecer a pessoa.

---

## 1. Contexto & Posicionamento

O Sub-PRD 05 entregou um agente que monta contexto a cada inbound. O Sub-PRD 10 (runtime) formalizou o artefato durável: cada run fecha escrevendo um `lead_checkpoints` e o run seguinte abre lendo o mais recente — "sessões descartáveis, artefatos duráveis". O que nenhum dos dois definiu é **quando a sessão acaba** e **quando o artefato morre**.

Sem essa definição, o contexto é monotônico: só cresce, nunca vence. Um cliente que comprou em janeiro, recebeu o produto e volta em agosto atrás de outra coisa é atendido por um agente que ainda opera sob o resumo de janeiro — repropõe o mesmo item, confirma um endereço de retirada que mudou, trata uma pergunta nova como continuação de um pedido fechado. O sintoma que originou este documento foi exatamente esse: um contato de teste teve mensagens, conversa, checkpoint e estado de funil apagados fisicamente do banco, e mesmo assim o agente retomou um pedido antigo — porque a memória do agente tem mais fontes do que a conversa, e nenhuma delas tinha política de expiração.

O posicionamento é deliberadamente conservador: **o padrão de fábrica não esquece nada**. Toda expiração automática é escolha explícita do tenant, feita no vocabulário dele (as etapas do Kanban que ele mesmo nomeou), não em enums genéricos que só fazem sentido para e-commerce. Um sistema que apaga contexto por conta própria é pior que um que lembra demais — o primeiro perde vendas em silêncio, o segundo é visível e corrigível.

Também vale a fronteira negativa: **memória organizacional não é ciclo de vida por contato**. O RAG (`ai_chunks`, alimentado por conversas marcadas `usable_for_rag`) e a Memória da IA (`org_memory_entries`, injetada no prefixo estável de todo turno) são conhecimento do negócio, compartilhado entre todos os contatos, e continuam válidos depois de qualquer reset. Confundir os dois foi o que fez o diagnóstico inicial deste problema levar a lugar errado; §3.11 fecha essa porta.

---

## 2. Escopo

### Dentro do escopo

1. Modelo conceitual de três camadas de esquecimento (sessão, expiração, reset manual)
2. Fronteira de sessão por intervalo de silêncio (default 6h), calculada em tempo de leitura
3. Ficha do cliente que sobrevive a todo reset automático (identidade + compras)
4. Aviso de atendimento anterior injetado no contexto após reset
5. Expiração de contexto configurável **por etapa do Kanban** (checkbox + carência em dias)
6. Worker de expiração via cron, com marca de corte não-destrutiva
7. Hard reset manual por contato (`Contatos` → ação destrutiva, admin/manager)
8. Preservação integral do histórico humano + divisor visual na thread
9. Cancelamento de jobs pendentes no reset; bloqueio de reset com caso humano aberto
10. Configuração org-wide do intervalo de sessão em Memória da IA
11. Auditoria de todo reset (automático e manual) e reversibilidade do reset automático
12. Delimitação explícita do que é memória organizacional e não expira por contato

### Fora do escopo

- Purga automática por retenção LGPD (declarada em §3.12 como gancho; implementação posterior)
- Criação automática de card novo no Kanban na recompra (semântica definida em §3.6; entrega posterior)
- Expiração ou versionamento de `org_memory_entries` e `ai_chunks` — Sub-PRD 05 e evolução da IA
- Reset em massa (por tag, por filtro, por importação) — decisão de produto: ação sempre unitária
- Reset por troca de versão de agente/playbook — registrado como risco R6, sem mecanismo no MVP
- Comando de reset disparado pelo próprio WhatsApp — avaliado e recusado (§7, R7)

---

## 3. Capacidades Funcionais

### 3.1 As três camadas de esquecimento

O produto trata "esquecer" como três coisas distintas, com gatilhos, alcances e reversibilidades diferentes. A confusão entre elas é a causa raiz do problema original.

| Camada | Gatilho | O que sai do contexto do agente | Histórico do humano | Reversível |
|---|---|---|---|---|
| **1. Fronteira de sessão** | silêncio do cliente ≥ N horas (default 6) | apenas as mensagens brutas anteriores ao intervalo | intacto | n/a (é leitura, não escrita) |
| **2. Expiração de contexto** | entrada em etapa marcada + carência | mensagens **e** checkpoint **e** estado do funil do agente | intacto | sim (limpar a marca) |
| **3. Hard reset** | ação manual de um humano | tudo, fisicamente apagado | **apagado** | não |

A ficha do cliente (§3.3) sobrevive às camadas 1 e 2. A camada 3 é ferramenta de exceção — bug, dado corrompido, ambiente de teste — e não é política de produto.

**ACs.** As três camadas existem com nomes distintos na UI e no código. Camada 1 nunca escreve no banco. Camada 2 nunca apaga linha. Camada 3 exige confirmação explícita e é auditada.

### 3.2 Fronteira de sessão (default 6h)

O agente para de reler o papo antigo quando o cliente sumiu por um intervalo configurável. A fronteira **não** é "mensagens das últimas 6h" — é o ponto onde ocorreu o último silêncio de 6h ou mais entre duas mensagens consecutivas. Uma conversa contínua de dez horas permanece inteira; uma conversa retomada no dia seguinte começa limpa.

O intervalo é org-wide, default **6 horas**, configurável em Memória da IA (§3.9). `null` desliga a fronteira.

O que a fronteira **não** corta: o `lead_checkpoints` (compromissos, objeções, próxima ação, resumo) e a ficha. É a diferença entre "não repetir o papo de ontem literalmente" e "esquecer a cotação de R$ 12/metro dada de manhã" — a primeira é o objetivo, a segunda seria um bug de negócio. O artefato durável do agente foi desenhado exatamente para atravessar sessões.

**ACs.** Cliente responde 8h depois: agente não recebe as mensagens da sessão anterior, mas recebe o checkpoint com a cotação. Conversa contínua de 10h chega inteira ao contexto. Intervalo configurado como `null` faz o agente ler o histórico completo (comportamento atual). Mudança do intervalo aplica no próximo turno, sem migração de dados.

### 3.3 A ficha que sobrevive

Esquecer a conversa não pode virar tratar o cliente como estranho. Após qualquer reset automático, o agente continua recebendo:

- **Identidade** — `display_name`/`name`, telefone, e-mail, `tags`
- **Relação comercial** — resumo derivado de `orders`: quantidade de pedidos, data e valor do último, status de entrega

A ficha é montada de **dado estruturado**, nunca do `rolling_summary`. Essa é a regra que impede o vazamento que originou este documento: o resumo textual é memória conversacional (expira), a tabela de pedidos é fato de negócio (não expira). Cliente anonimizado por LGPD não gera ficha.

**ACs.** Cliente com 3 pedidos que teve contexto expirado é saudado com conhecimento de que é cliente recorrente. A ficha nunca contém frase extraída de conversa. `orders.is_anonymized=true` e `contacts.is_anonymized=true` são excluídos da ficha. Contato sem pedido gera ficha só com identidade, sem bloco comercial vazio.

### 3.4 Aviso de atendimento anterior

Quando existe histórico anterior à marca de corte, o contexto recebe uma linha explícita informando que houve atendimento prévio cujo conteúdo não está disponível neste turno. Sem isso, o agente afirma "é a primeira vez que conversamos" para quem já comprou três vezes — troca uma alucinação por outra.

A linha é curta, factual, e não convida o agente a especular sobre o conteúdo perdido.

**ACs.** Contato com histórico cortado recebe o aviso; contato genuinamente novo não recebe. O agente não inventa conteúdo do atendimento anterior quando questionado. O aviso não aparece no texto enviado ao cliente.

### 3.5 Expiração de contexto por etapa do Kanban

A política de expiração é declarada **nas etapas que o tenant criou**, não em estados genéricos. Cada etapa do Kanban ganha duas configurações:

- **Recomeçar o atendimento do zero quando o negócio chegar aqui** (padrão: desligado)
- **Esperar N dias antes de recomeçar** (padrão: 7)

Assim um e-commerce marca "Entregue", uma clínica marca "Alta", uma imobiliária marca "Escriturado" — e ninguém precisa entender o que significa `won` ou `lost`. A carência existe para não cortar o pós-venda: o cliente que pergunta sobre a entrega dois dias depois ainda encontra um agente que sabe do pedido.

Etapas de perda não são tratadas de forma especial. O motivo da perda ("achou caro") é informação comercial valiosa para reconquista, e por isso o padrão é **não** expirar; quem quiser o contrário marca a etapa como qualquer outra. Nenhuma regra é fixada no código a partir de `is_won`/`is_lost` — a decisão é sempre do tenant, porque as etapas dele mudam.

Quando a expiração dispara, o worker grava uma **marca de corte** no contato. Nada é apagado. Na volta do cliente, o agente lê apenas o que veio depois da marca.

**ACs.** Etapa marcada com carência de 7 dias expira o contexto de um negócio parado nela há 8 dias, e não expira o de 6 dias. Renomear ou reordenar a etapa não altera a política. Nenhuma etapa vem marcada por padrão em org nova. Etapa arquivada não dispara expiração. A expiração emite atividade na timeline e é visível para o humano.

### 3.6 Novo ciclo na recompra

Quando o contexto expira por etapa terminal e o cliente volta, a leitura correta não é "o agente teve amnésia" — é **um novo ciclo de negócio começou**. O estado do funil interno do agente (`lead_state`) volta ao início, e a venda anterior permanece registrada e contabilizada.

Sobre o Kanban do tenant, a regra é dura: **nenhum reset move ou edita um card existente**. Cards são objeto de trabalho humano e não se movem sozinhos de madrugada. A materialização do novo ciclo como um card novo é a semântica pretendida e está declarada aqui, mas entra em fase posterior (§9) — a primeira entrega marca o corte e zera o funil interno, sem tocar no quadro.

**ACs.** Contexto expirado por etapa terminal zera `lead_state`. Nenhum card do Kanban muda de posição, estágio ou pipeline por efeito de reset. A venda anterior continua contando nas métricas de ganho.

### 3.7 O histórico humano nunca é apagado automaticamente

Nenhum reset automático apaga mensagem. O atendente que abrir a conversa meses depois vê tudo — inclusive o que o agente já não lê. Histórico de mensagem é prova, é contexto de auditoria, é o que permite um humano entender uma venda que a IA conduziu.

Na thread, o ponto de corte aparece como um divisor discreto informando data e motivo (ex.: fim de ciclo, reset manual). O divisor é o que torna o comportamento do agente legível para o humano: sem ele, "por que a IA não lembrou disso?" vira suporte.

**ACs.** Após expiração, o inbox mostra 100% das mensagens. O divisor aparece na posição correta com data e motivo. O divisor não aparece em conversa sem corte. Exportação LGPD continua trazendo o histórico completo.

### 3.8 Jobs pendentes e casos humanos abertos

Dois estados vivos podem desfazer ou atrapalhar um reset:

- **Jobs enfileirados** para aquele contato que rodem depois do corte podem reescrever um checkpoint com contexto velho — o reset se desfaz sozinho minutos depois. Todo reset cancela os jobs pendentes do contato. Isso não altera nenhuma regra de follow-up: a cadência continua funcionando como definida, apenas execuções já agendadas sob o contexto antigo não são aproveitadas.
- **Caso humano aberto** (`agent_cases`) significa que uma pessoa está trabalhando numa tarefa cujo contexto o reset apagaria. O reset manual é **bloqueado** enquanto houver caso aberto, com mensagem que aponta o caso.

**ACs.** Reset cancela jobs pendentes do contato e nenhum job pós-reset grava checkpoint com dado anterior ao corte. Reset manual com caso aberto retorna erro claro e não executa. Expiração automática pula contatos com caso aberto e tenta de novo no próximo ciclo.

### 3.9 Configuração e permissões

| O quê | Onde | Quem configura |
|---|---|---|
| Intervalo de sessão (6h) | Memória da IA → aba *Ciclo de vida do contexto* | `admin` |
| Expiração por etapa | Configuração do pipeline, na própria etapa | `admin` |
| Hard reset manual | Contatos → detalhe do contato | `manager`+ (admin inclusive) |

O escopo da política é **org-wide** para o intervalo de sessão e **por etapa** para a expiração. Não há configuração por agente nem por contato no MVP.

A UI é escrita em linguagem de negócio, sem jargão técnico: "recomeçar o atendimento do zero", não "resetar contexto"; "o agente esquece o que foi conversado, mas continua sabendo quem é o cliente e o que ele já comprou", não "cutoff em lead_checkpoints".

**ACs.** `manager` não vê a configuração de política; vê e usa o reset manual. `agent` e `viewer` não veem nenhum dos dois. Toda mudança de política é auditada. Textos da UI passam por revisão de clareza (§9 da Spec traz as strings exatas).

### 3.10 Auditoria e reversibilidade

Todo reset gera rastro: entrada em `api_audit_log` e atividade na timeline do contato. O reset automático é **reversível** — a marca de corte é um campo, e limpá-lo devolve o contexto integralmente, porque nada foi apagado. O hard reset é irreversível por construção e o diálogo diz isso com todas as letras.

**ACs.** `context.reset_auto`, `context.reset_manual` e `context.policy_changed` aparecem no audit com ator, contato e motivo. Limpar a marca restaura o comportamento anterior do agente sem perda. O diálogo de hard reset exige confirmação digitada.

### 3.11 O que é memória organizacional e não expira por contato

Duas fontes alimentam todo turno e **não** são endereçadas por este sub-PRD:

- **RAG (`ai_chunks`)** — conhecimento extraído de conversas resolvidas marcadas `usable_for_rag`, anonimizado, recuperado por similaridade com filtro apenas de organização e versão da base. Um trecho ingerido continua disponível para qualquer contato depois de qualquer reset.
- **Memória da IA (`org_memory_entries`)** — regras e aprendizados publicados, injetados no prefixo estável do system prompt, válidos para todo atendimento.

Isso é intencional: são ativos do negócio, não memória de uma pessoa. A única concessão é operacional — o hard reset manual oferece a opção de remover também os trechos de RAG derivados das conversas daquele contato, para os casos de dado de teste que contaminou a base (§3.12 da Spec).

**ACs.** Reset automático nunca altera `ai_chunks` nem `org_memory_entries`. Hard reset só toca RAG quando a opção é marcada explicitamente. A documentação da tela de Memória da IA explica a diferença entre memória do negócio e contexto do cliente.

### 3.12 Gancho de retenção LGPD

A expiração de contexto reduz o que o agente lê, não o que o banco guarda. A minimização de dados de verdade — apagar ou anonimizar conversas sem finalidade ativa após N meses — é política de retenção, roda sobre as mesmas marcas e etapas definidas aqui, e fica declarada como evolução. O ponto de extensão é o mesmo worker.

**ACs.** O PRD declara o gancho; nenhuma purga é executada no MVP.

---

## 4. Requisitos Não-Funcionais

**Performance.** Cálculo da fronteira de sessão não adiciona query nova ao turno (deriva do histórico já lido) e custa <5ms. Worker de expiração processa até 500 contatos por invocação em <30s. Marca de corte não introduz índice novo em caminho quente.

**Confiabilidade.** Worker é idempotente: reprocessar o mesmo contato não muda o resultado. Falha do worker degrada graceful — o agente segue com o comportamento atual (lembra mais do que deveria), nunca com contexto corrompido. Nenhum reset automático apaga dado, então nenhuma falha de worker é destrutiva.

**Segurança & Conformidade.** Toda operação filtra `organization_id` de fonte confiável (sessão/cookie/secret de cron), nunca do body. Hard reset exige `manager`+ e é auditado. Marca de corte não afeta export LGPD nem retenção do audit.

**Observabilidade.** Métrica de contatos expirados por ciclo e por motivo. Alerta se o worker ficar >24h sem rodar com política ativa. Atividade na timeline para todo reset.

**Reversibilidade.** Reset automático 100% reversível. Toda a camada 1 é leitura pura — desligar a configuração restaura o comportamento anterior sem migração.

---

## 5. Acceptance Criteria do sub-PRD

A capacidade é **MVP-completa** quando:

1. Fronteira de sessão de 6h corta o histórico bruto na retomada e preserva checkpoint e ficha, provado com conversa real de teste
2. Conversa contínua que atravessa mais de 6h de duração **não** é cortada (o corte é por silêncio, não por duração)
3. Cliente com pedidos anteriores volta após expiração e é atendido com conhecimento da relação comercial, sem citar conteúdo da conversa antiga
4. Contato com histórico cortado recebe aviso de atendimento anterior; contato novo não recebe
5. Etapa do Kanban marcada com carência expira o contexto no prazo e emite atividade; etapa não marcada nunca expira
6. Org nova não tem nenhuma etapa marcada — o padrão de fábrica não esquece nada
7. Nenhum card do Kanban muda de estágio, posição ou pipeline por efeito de qualquer reset
8. Inbox mostra 100% do histórico após expiração, com divisor de corte na posição correta
9. Hard reset manual apaga contexto do contato mantendo `contacts` e `crm_leads`, com confirmação digitada e audit
10. Hard reset é bloqueado com caso humano aberto e cancela jobs pendentes
11. Reset automático é revertido limpando a marca, com contexto integral de volta
12. RAG e Memória da IA não são alterados por nenhum reset automático
13. Isolamento multi-tenant testado: política e marca de uma org nunca afetam outra
14. `pnpm test:db` verde, incluindo invariante de isolamento e de idempotência do worker

---

## 6. Dependências

### Internas
- **Sub-PRD 01** — audit log, RLS, RBAC, convenções de API, worker via cron com secret
- **Sub-PRD 02** — `contacts`, `crm_lead_activities` (timeline), export/anonimização LGPD
- **Sub-PRD 04** — `crm_stages` (onde a política é declarada), `crm_leads.stage_changed_at` (relógio da carência), inbox e thread (divisor visual)
- **Sub-PRD 05** — montagem de contexto do turno, `lead_checkpoints`, `lead_state`, RAG e Memória da IA como fronteira negativa
- **Spec 15** — `agent_cases` (bloqueio por caso aberto)

### Externas
- Nenhuma. Toda a capacidade roda sobre Postgres e o runtime já existente — sem provedor novo, sem custo de terceiro.

---

## 7. Riscos Específicos do sub-PRD

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| **R1** | Fronteira de sessão agressiva demais faz o agente esquecer cotação dada horas antes | Crítico | Checkpoint sobrevive à fronteira por design; intervalo configurável; teste de aceite 2 cobre o caso |
| **R2** | Expiração automática apaga contexto de venda em andamento | Crítico | Expiração só por etapa explicitamente marcada + carência; padrão de fábrica desligado; nada é apagado (marca reversível) |
| **R3** | Agente trata cliente recorrente como estranho | Alto | Ficha de §3.3 sobrevive a todo reset automático; aviso de §3.4; AC 3 |
| **R4** | Job pendente ressuscita contexto depois do corte | Alto | Cancelamento de jobs no reset; invariante de que nenhum checkpoint pós-corte carrega dado anterior |
| **R5** | Tenant marca a etapa errada e perde contexto em massa | Alto | Cópia da UI explícita sobre o efeito; carência default de 7 dias; reversibilidade por limpeza da marca; atividade na timeline torna visível |
| **R6** | Nova versão de agente/playbook torna checkpoint antigo incoerente | Médio | Fora do MVP; risco registrado; mitigação natural pela expiração por etapa |
| **R7** | Comando de reset pelo WhatsApp acionado por cliente real | Alto | Recusado no escopo: qualquer regex no inbound é acionável por qualquer contato. Reset é ação autenticada na plataforma |
| **R8** | Divergência entre funil do agente e Kanban do tenant | Médio | Nenhum reset toca no card; `lead_state` zerado é estado interno declarado, não espelho quebrado do quadro |
| **R9** | Usuário espera que reset limpe o RAG e não limpa | Médio | §3.11 explícito na UI de Memória da IA; opção dedicada no hard reset |
| **R10** | Worker parado silenciosamente deixa política sem efeito | Médio | Alerta de heartbeat >24h; métrica por ciclo |

---

## 8. Fora de Escopo (deste sub-PRD)

- Purga/retenção LGPD automática (gancho declarado, entrega posterior)
- Card novo no Kanban na recompra (semântica declarada em §3.6, entrega posterior)
- Reset em massa ou por filtro
- Política por agente, por pipeline ou por contato individual
- Expiração de RAG e de Memória da IA
- Comando de reset via WhatsApp

---

## 9. Decisões deferidas pra Spec

1. Onde exatamente a marca de corte vive (`contacts` vs `conversations`) e o tipo do campo
2. Cálculo da fronteira de sessão: função pura em TypeScript sobre o histórico já lido vs window function em SQL
3. Formato do bloco de ficha e do aviso de atendimento anterior no prompt (texto exato)
4. Nomes das colunas de política em `crm_stages` e defaults
5. Cadência do cron e teto de contatos por invocação
6. Strings exatas da UI (checkbox, carência, diálogo de hard reset, divisor da thread)
7. Chave de configuração do intervalo de sessão em `organizations.settings`
8. Faseamento da entrega e o que entra em cada fase

---

## Anexos

- Spec técnica: [`docs/specs/16-spec-gestao-contexto-agente.md`](../specs/16-spec-gestao-contexto-agente.md)
- Backlog executável: `plan/contexto/features.json` e `plan/contexto/phases.md`
- Origem: investigação de contexto residual em contato de teste (agosto/2026), em que apagar `messages`, `conversations`, `lead_checkpoints` e `lead_state` não impediu o agente de retomar um pedido antigo
