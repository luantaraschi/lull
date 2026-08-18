# lull: runtime de conversa para agentes de atendimento

**Data:** 2026-08-18
**Status:** aprovado (design), pendente de plano de implementação
**Pacote npm:** `@luantaraschi/lull` (alternativa sem escopo: `lull-runtime`)

## 1. Objetivo

Biblioteca TypeScript que resolve os quatro problemas de canal que todo bot de
atendimento reencontra do zero: webhook duplicado, mensagem fragmentada em vários
balões, atendente humano assumindo a conversa e sessão que expira.

Os frameworks de agente cuidam do LLM. Ninguém cuida do canal. É essa lacuna que a
lib ocupa.

Objetivo secundário e explícito: servir de peça de portfólio para vagas de
IA/LLM. Isso justifica investimento em README, exemplo executável e benchmark
reproduzível, que num projeto interno seriam opcionais.

## 2. Escopo

### Dentro

1. **Idempotência**: o mesmo `messageId` entregue duas vezes produz um evento só.
2. **Coalescing por silêncio**: mensagens seguidas viram um turno único, fechado
   após `quietMs` de silêncio, com teto de `maxWaitMs`.
3. **Takeover humano**: pausa o bot por um TTL; libera por chamada explícita ou
   por vencimento.
4. **Sessão**: expira por inatividade e sinaliza `isNewSession` no turno seguinte.

### Fora (declarado no README)

Não chama LLM. Não conhece WhatsApp, Twilio ou Evolution API. Não transcreve
áudio. Não gerencia prompt nem memória de conversa. Não persiste: define a
interface `Store` e entrega apenas a implementação em memória.

### Fora desta versão, previsto na interface

Adapter Redis, adapter de canal, port para Python. A interface `Store` já
comporta o Redis; o port fica para outro repositório, se valer a pena.

## 3. Arquitetura

Núcleo puro com efeitos declarativos, fachada ergonômica por cima.

```
src/core/     reduce(state, event) => [state', Effect[]]   (puro, zero dependências)
src/runtime/  fachada: relógio, timers, execução de efeitos, emissão de eventos
src/store/    interface Store + memoryStore()
```

O núcleo nunca lê o relógio, nunca cria timer, nunca toca a rede. Todo evento
carrega `at`. Consequência prática: testar "quatro mensagens em oito segundos e
então silêncio" é aritmética, não `setTimeout`.

### 3.1 Estado

```ts
type ConversationState = {
  id: string
  seen: string[]              // janela de messageIds recentes (dedupe)
  buffer: BufferedMessage[]   // mensagens aguardando o silêncio
  firstBufferedAt: number | null
  lastMessageAt: number
  session: { id: string; lastActivityAt: number } | null
  pausedUntil: number | null  // takeover humano
}
```

Serializável de propósito: cabe em Redis ou Postgres sem tradução.

### 3.2 Eventos e efeitos

Eventos de entrada: `message`, `takeover`, `release`, `tick`. Todos carregam `at`.

Efeitos de saída: `emitTurn`, `schedule`, `cancel`, `drop` (com `reason`).

`drop` existe para observabilidade: o consumidor consegue medir quantas
duplicatas e quantas mensagens em pausa apareceram, sem instrumentar o núcleo.

### 3.3 Regra de fechamento do turno

O turno fecha quando:

```
at >= min(lastMessageAt + quietMs, firstBufferedAt + maxWaitMs)
```

Cada mensagem nova empurra o primeiro prazo. O segundo é imóvel, é o que
protege de quem nunca para de digitar.

### 3.4 Decisões opinativas

**Mensagem durante takeover não vira turno pendente.** Ela atualiza a sessão e
sai como `drop{reason:'paused'}`. Se ficasse no buffer, o bot voltaria do TTL
respondendo retroativamente a mensagens que o humano já resolveu, o pior
comportamento possível num atendimento real.

**Dedupe por janela, não por histórico.** Últimos 200 `messageId` por conversa
(configurável). Webhook duplicado chega em segundos, não em dias; guardar tudo é
vazamento de memória disfarçado de correção.

**Sessão expira preguiçosamente.** Não há varredura de fundo; a expiração é
avaliada quando a conversa recebe o próximo evento. Sem processo de limpeza,
sem estado global.

### 3.5 Store

```ts
interface Store {
  load(conversationId: string): Promise<ConversationState | null>
  save(state: ConversationState): Promise<void>
  delete(conversationId: string): Promise<void>
  withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>
}
```

`withLock` é obrigatório, não conveniência: dois webhooks da mesma conversa
chegando juntos fazem read-modify-write um por cima do outro e uma mensagem se
perde. A store em memória serializa com uma cadeia de promises por chave; uma
store Redis usaria `SET NX` com TTL.

### 3.6 Limitação assumida

A fachada agenda com `setTimeout`, portanto opera em um processo só. Rodar em
várias instâncias exige uma store com índice de vencimento (`listDue(now)`).
Documentado no README como limitação conhecida, com o caminho de extensão
descrito, não escondido.

## 4. API pública

```ts
const runtime = createRuntime({
  store: memoryStore(),
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 30 * 60_000,
  takeoverTtlMs: 15 * 60_000,
  dedupeWindow: 200,
})

runtime.on('turn', async ({ conversationId, messages, isNewSession }) => { /* ... */ })
runtime.on('drop', ({ conversationId, reason }) => { /* ... */ })

await runtime.ingest({ conversationId, messageId, text, at })
await runtime.takeover({ conversationId })
await runtime.release({ conversationId })
await runtime.stop()   // limpa timers pendentes
```

O núcleo sai exportado em `@luantaraschi/lull/core`, para quem quiser rodar o
reducer dentro de um worker, Durable Object ou Lambda sem os timers da fachada.

## 5. Testes

- **Tabela de cenários sobre o reducer:** fragmentação, duplicata, takeover no
  meio do buffer, TTL vencendo junto com o silêncio, sessão expirando entre dois
  turnos, `maxWaitMs` vencendo antes de `quietMs`.
- **Propriedades com `fast-check`:** nenhuma mensagem entra e desaparece; nunca
  emite turno com bot pausado; `seen` nunca ultrapassa `dedupeWindow`.
- **Corrida real:** 50 `ingest` concorrentes na mesma conversa; a contagem final
  tem que bater.
- **Fachada:** timers falsos do vitest, verificando que `schedule`/`cancel` viram
  timers corretos.

Cobertura publicada no README como badge.

## 6. Entrega

- **Build:** tsup, saída ESM + CJS + tipos.
- **CI:** GitHub Actions, typecheck, teste, build em Node 20 e 22.
- **Publicação:** npm com `--provenance` (badge de proveniência assinada).
- **README:** problema em antes/depois, diagrama ASCII da linha do tempo do
  coalescing, uso em dez linhas, seção "o que esta lib não faz", decisões de
  design com o porquê.
- **`examples/`:** servidor mínimo simulando webhook fragmentado, `npm run
  example`, sem exigir chave de API. Quem avalia ou roda em dez segundos ou fecha
  a aba.
- **`bench/`:** simula N conversas com padrão realista de fragmentação e reporta
  a redução de chamadas ao LLM. Gera o número verificável que vai para o
  currículo, no lugar de adjetivo.

**Idioma:** código, comentários, README e mensagens de commit em inglês, o
público-alvo é internacional. Esta spec e a conversa de design ficam em
português.

## 7. Critérios de sucesso

1. `npm i @luantaraschi/lull` e o exemplo de dez linhas funciona sem mais nada.
2. `npm run example` roda sem credencial e demonstra os quatro comportamentos.
3. Suíte verde no CI, cobertura do núcleo acima de 90%.
4. `bench` produz um número reproduzível de redução de chamadas ao LLM.
5. Um leitor de README entende em trinta segundos qual problema a lib resolve.
