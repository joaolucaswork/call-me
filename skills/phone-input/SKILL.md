# Phone Call Input Skill

## Description

Call the user (Lucas) on the phone. A ligacao e o UNICO canal de comunicacao confiavel — o Lucas tem dificuldades severas de visao e NAO consegue acompanhar o chat do Claude Code. Se voce nao ligar, ele NAO sabe que voce terminou, que tem duvidas, ou que precisa dar feedback.

**Regra geral**: Se voce tem algo a comunicar ao Lucas, LIGUE. Nunca apenas escreva no chat.

## Quando Ligar (Obrigatorio)

| Momento | Exemplo |
|---------|---------|
| Ao finalizar qualquer task ou entrega | "Terminei a implementacao, fiz commit no branch dev." |
| Ao ter qualquer pergunta ou duvida | "Tenho uma duvida sobre o comportamento esperado..." |
| Ao precisar confirmar algo | "Posso deletar esse arquivo?" |
| Ao apresentar resultados de investigacao | "Investiguei o bug e encontrei a causa..." |
| Antes de respostas longas no chat | Liga primeiro, depois explica por voz |

## Tools

### `initiate_call`
Inicia uma nova ligacao.

**Parameters:**
- `message` (string): O que voce quer dizer. Seja direto e resumido.

**Returns:**
- `callId` e a resposta do usuario (transcrita para texto)

### `continue_call`
Continua uma ligacao ativa enviando mensagem e ESPERANDO resposta do usuario.

**Parameters:**
- `call_id` (string): O call ID retornado por `initiate_call`
- `message` (string): Sua mensagem de follow-up

**Returns:**
- A resposta do usuario

### `speak_to_user`
Fala uma mensagem na ligacao ativa SEM esperar resposta (fire-and-forget). Use para updates e acknowledgments.

**Parameters:**
- `call_id` (string): O call ID retornado por `initiate_call`
- `message` (string): O que dizer ao usuario

**Returns:**
- Confirmacao de que a mensagem foi falada

### `end_call`
Encerra a ligacao com uma mensagem de despedida.

**Parameters:**
- `call_id` (string): O call ID retornado por `initiate_call`
- `message` (string): Mensagem de encerramento

**Returns:**
- Duracao da ligacao em segundos

### `get_call_status`
Verifica se a ligacao ainda esta ativa, se o usuario desligou, ou se nao foi encontrada.

**Parameters:**
- `call_id` (string): O call ID a verificar

**Returns:**
- Status: `active`, `hung_up`, ou `not_found`
- Historico da conversa e duracao (para active/hung_up)

## Metodos de Ligacao (Ordem de Tentativa)

Se um metodo falhar, tentar o proximo:

1. **MCP Tool**: `mcp__plugin_callme_callme__initiate_call`
2. **Script Local**: `bun ~/.claude/scripts/callme.js <action> "mensagem" [call_id]`
3. **API Direta**: `POST http://localhost:3334/api/initiate_call`

## Tratamento de Erros

### `hungUp: true` ou `"Call was hung up by user"`

O sinal de "hung up" NEM SEMPRE e confiavel — pode ser falso positivo.

1. RELIGAR IMEDIATAMENTE com nova `initiate`
2. Mensagem: "Oi Lucas, a ligacao caiu. Foi voce que desligou?"
3. Se Lucas confirmar "sim" → encerrar a call na hora (`end`), sem falar mais nada
4. Se Lucas disser "nao" ou der outra resposta → continuar normalmente

### Erro generico (timeout, `"STT session not available"`, etc.)

1. Esperar 2-3 segundos
2. Tentar novamente com `initiate`
3. Se falhar 3 vezes seguidas, tentar metodo alternativo (MCP → Script → API)
4. Se TODOS falharem, informar no chat que nao conseguiu ligar e pedir ao Lucas para verificar o plugin

### `"Call already in progress"` ou similar

1. Se tem `callId` ativo → usar `continue` ou `speak` com ele
2. Se NAO tem `callId` → iniciar nova ligacao com `initiate` (ignora o suposto call ativo)

## Modo Permanente

Quando o Lucas pedir "ligacao permanente" ou "fica na linha":

- Manter a call ativa durante toda a sessao
- Usar `speak` para updates que nao precisam de resposta
- Usar `continue` para perguntas que precisam de resposta
- Se a ligacao cair por qualquer motivo → RELIGAR AUTOMATICAMENTE
- So encerrar quando o Lucas disser explicitamente "finalizar", "desligar", "pode encerrar"
- NAO encerrar por inatividade — o Lucas pode estar pensando

## Boas Praticas de Voz

### Mensagens de `initiate` (primeira mensagem da ligacao)
- Ser direto e resumido
- Comecar com "Oi Lucas!" seguido do ponto principal
- Ex: "Oi Lucas! Terminei as correcoes no setup. O toggle agora funciona e o texto mostra o canal correto."

### Mensagens de `continue` (perguntas)
- Fazer UMA pergunta clara por vez
- Ex: "Quer que eu faca commit e push pro dev?"

### Mensagens de `speak` (updates sem esperar resposta)
- Curtas e informativas
- Ex: "Comecei a implementar, deve levar uns minutos."

### Mensagens de `end` (encerramento)
- Breve confirmacao
- Ex: "Pronto, tudo commitado. Ate mais!"

## Exemplos de Uso

**Fluxo tipico apos finalizar tarefa:**
```
1. initiate_call: "Oi Lucas! Terminei a implementacao do auth. Fiz commit no branch dev."
2. Lucas responde com instrucoes → executar e usar continue para dar feedback
3. Lucas diz "ok" / "obrigado" → end_call: "Pronto, ate mais!"
```

**Conversa com varias perguntas:**
```
1. initiate_call: "Oi Lucas! Estou trabalhando nos pagamentos. Devo usar Stripe ou PayPal?"
2. Lucas: "Stripe"
3. continue_call: "Quer o checkout completo ou so um botao simples?"
4. Lucas: "Checkout completo"
5. end_call: "Beleza, vou implementar o checkout completo com Stripe. Te ligo quando terminar!"
```

**Usando speak para operacoes longas:**
```
1. initiate_call: "Oi Lucas! Terminei a migracao do banco. O que faco agora?"
2. Lucas: "Pesquisa a doc mais recente do Stripe"
3. speak_to_user: "Beleza, vou pesquisar. Um momento..."
4. [Executa a pesquisa]
5. continue_call: "Achei a doc atualizada. A versao mais recente tem novos metodos de pagamento..."
6. Lucas: "Implementa isso"
7. end_call: "Perfeito, vou implementar. Te ligo quando estiver pronto!"
```

## Resumo

> **Sempre ligue. Se cair, religue. Se der erro, tente de novo. O Lucas so sabe o que esta acontecendo atraves da ligacao. Sem ligacao = sem comunicacao = falha no proposito.**
