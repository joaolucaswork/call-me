# CallMe Plugin — Especificacao Completa

Documento de referencia para implementacao do plugin CallMe. Define todas as regras de comportamento que o Claude deve seguir ao usar o plugin.

---

## 1. Contexto

O usuario (Lucas) tem dificuldades severas de visao e NAO consegue acompanhar o chat do Claude Code. A ligacao via CallMe e o UNICO canal de comunicacao confiavel. Se o Claude nao ligar, o Lucas nao sabe que a tarefa terminou, que ha duvidas, ou que precisa dar feedback. Sem ligacao, o Claude falha no proposito de ajudar.

---

## 2. Quando Ligar (Obrigatorio)

O Claude DEVE iniciar uma ligacao nos seguintes momentos:

| Momento | Exemplo |
|---------|---------|
| Ao finalizar qualquer task ou entrega | "Terminei a implementacao, fiz commit no branch dev." |
| Ao ter qualquer pergunta ou duvida | "Tenho uma duvida sobre o comportamento esperado..." |
| Ao precisar confirmar algo | "Posso deletar esse arquivo?" |
| Ao apresentar resultados de investigacao | "Investiguei o bug e encontrei a causa..." |
| Antes de respostas longas no chat | Liga primeiro, depois explica por voz |

**Regra geral**: Se o Claude tem algo a comunicar ao Lucas, deve ligar. Nunca apenas escrever no chat.

---

## 3. Metodos de Ligacao (Ordem de Tentativa)

Tentar na seguinte ordem. Se um falhar, tentar o proximo:

### Metodo 1 — MCP Tool
```
mcp__plugin_callme_callme__initiate_call
```

### Metodo 2 — Script Local
```bash
bun ~/.claude/scripts/callme.js <action> "mensagem" [call_id]
```

Actions disponiveis:
- `initiate` — Inicia nova ligacao (retorna `callId`)
- `continue` — Envia mensagem e ESPERA resposta do usuario (retorna `response`)
- `speak` — Envia mensagem SEM esperar resposta (fire-and-forget)
- `end` — Encerra a ligacao

### Metodo 3 — API Direta
```
POST http://localhost:3334/api/initiate_call
```
Usar via `bun` para evitar problemas de encoding.

---

## 4. Fluxo de uma Ligacao Tipica

```
1. Claude finaliza tarefa
2. Claude chama `initiate` com resumo do que fez
3. Plugin retorna { callId, response }
4. Se Lucas responde com instrucoes → Claude executa e usa `continue` para dar feedback
5. Se Lucas diz "ok" / "obrigado" → Claude usa `end` para encerrar
6. Se precisa dar update sem esperar resposta → usa `speak`
```

---

## 5. Tratamento de Erros e Reconexao

### 5.1. `hungUp: true` ou `"Call was hung up by user"`

O sinal de "hung up" NEM SEMPRE e confiavel — pode ser falso positivo.

**Comportamento obrigatorio:**
1. RELIGAR IMEDIATAMENTE com nova `initiate`
2. Mensagem: "Oi Lucas, a ligacao caiu. Foi voce que desligou?"
3. Se Lucas confirmar "sim" → encerrar a call na hora (`end`), sem falar mais nada
4. Se Lucas disser "nao" ou der outra resposta → continuar a conversa normalmente

### 5.2. Erro generico (ex: `"STT session not available"`, timeout, etc.)

1. Esperar 2-3 segundos
2. Tentar novamente com `initiate`
3. Se falhar 3 vezes seguidas, tentar metodo alternativo (MCP → Script → API)
4. Se TODOS falharem, informar no chat que nao conseguiu ligar e pedir ao Lucas para verificar o plugin

### 5.3. `"Call already in progress"` ou similar

1. Se tem `callId` ativo → usar `continue` ou `speak` com ele
2. Se NAO tem `callId` → iniciar nova ligacao com `initiate` (ignora o suposto call ativo)

---

## 6. Modo Permanente

Quando o Lucas pedir "ligacao permanente" ou "fica na linha":

- Manter a call ativa durante toda a sessao
- Usar `speak` para updates que nao precisam de resposta
- Usar `continue` para perguntas que precisam de resposta
- Se a ligacao cair por qualquer motivo → RELIGAR AUTOMATICAMENTE
- So encerrar quando o Lucas disser explicitamente "finalizar", "desligar", "pode encerrar"
- NAO encerrar por inatividade — o Lucas pode estar pensando

---

## 7. Boas Praticas de Comunicacao por Voz

### Mensagens de `initiate` (primeira mensagem da ligacao):
- Ser direto e resumido
- Comecar com "Oi Lucas!" seguido do ponto principal
- Ex: "Oi Lucas! Terminei as correcoes no setup. O toggle agora funciona e o texto mostra o canal correto."

### Mensagens de `continue` (perguntas):
- Fazer UMA pergunta clara por vez
- Ex: "Quer que eu faca commit e push pro dev?"

### Mensagens de `speak` (updates):
- Curtas e informativas
- Ex: "Comecei a implementar, deve levar uns minutos."

### Mensagens de `end` (encerramento):
- Breve confirmacao
- Ex: "Pronto, tudo commitado. Ate mais!"

---

## 8. Infraestrutura

- Os processos `callme` e `ngrok` sao gerenciados pelo PM2
- Se os processos estiverem fora do ar, o plugin nao funciona
- Para verificar: `pm2 status` (via Bash)
- Para reiniciar: `pm2 restart callme ngrok`

---

## 9. Resumo das Regras em Uma Frase

> **Sempre ligue. Se cair, religue. Se der erro, tente de novo. O Lucas so sabe o que esta acontecendo atraves da ligacao. Sem ligacao = sem comunicacao = falha no proposito.**
