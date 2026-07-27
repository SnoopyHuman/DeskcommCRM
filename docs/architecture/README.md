# Mapas de arquitetura

## Regra única deste diretório: o JSON é a FONTE; o HTML é DERIVADO

Cada mapa tem um `*.json` (fonte) e pode ter um `*.html` (render).

> **Se os dois divergirem, o HTML é que está errado.** Nunca edite o HTML à mão: regenere-o a partir do
> JSON.

O motivo está aqui e não num handoff porque é aqui que a decisão errada seria tomada. O HTML é o
formato mais fácil de abrir e editar — e **o formato mais fácil de editar é o que envelhece mentindo**:
uma correção feita nele parece funcionar, some na próxima geração, e nesse intervalo a fonte deixou de
ser fonte sem ninguém decidir isso.

## Mapas

| arquivo | escopo |
|---|---|
| `agent-turn.workflow.json` | o turno do agente (runtime da IA) |
| `crm-vivo.architecture.json` | subsistema **CRM Vivo** — 24 peças, 44 arestas, 6 faixas |

### `crm-vivo.architecture.json` é PLANTA, não fotografia

Ele descreve o desenho **contratado** das oito waves do épico. As waves 6, 7 e 8 **ainda não existem em
código** — quem procurar essas peças no repositório não vai achar, e **o mapa não está errado: está
adiantado**.

Invariantes que a forma não mostra vivem nos `cards` do próprio JSON — inclusive as **não-ligações
deliberadas** (ex.: o score fica **fora** da publicação de realtime, de propósito). *Ausência de aresta
é indistinguível de aresta esquecida; por isso a não-ligação se **declara**, não se desenha.*

## O pedágio do eixo CONTATO × NEGÓCIO

Três peças diferentes pagaram o mesmo custo, e a quarta pagaria igual se isto
não estivesse escrito:

| onde | o que custou |
|---|---|
| **dossiê** (wave 6) | a timeline era indexada por `contact_id`; negócio sem contato ficava mudo — 25% dos leads, 64% das atividades |
| **reativação** (wave 7) | `cron_jobs` é por contato; negócio sem contato não pode receber proposta de retomada — 26 de 68 abertos |
| **funil do agente** (wave 8) | `lead_state.stage` é por contato e o card é por negócio; um contato com dois negócios exige decidir qual se move |

**A aresta:** `contacts` ─(1:N)─ `crm_leads`, e quase todo mecanismo do agente
vive do lado do CONTATO enquanto quase toda superfície do produto vive do lado
do NEGÓCIO.

**A regra que sai daí:** toda peça nova que ligue um mecanismo do agente a uma
superfície do CRM atravessa essa aresta, e precisa responder três perguntas
**antes** de ser escrita:

1. e se o contato tiver **dois** negócios abertos? — reuse
   `resolveActiveLeadForContact`, nunca escreva um segundo resolvedor;
2. e se o negócio **não tiver** contato? — é 25% dos casos, não é canto;
3. o que a peça faz quando não dá para decidir? — não agir e deixar rastro é
   resposta; agir no negócio errado não é.

As três vezes o custo foi o mesmo: descobrir a aresta **durante** a
implementação, com a peça já meio pronta.
