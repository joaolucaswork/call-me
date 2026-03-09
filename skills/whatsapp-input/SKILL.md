# WhatsApp Input Skill

## Description

Comunique-se com o Lucas via WhatsApp. Use para enviar mensagens de status intermediarias durante tarefas longas, responder mensagens recebidas, e manter o Lucas informado do progresso.

O Lucas tem dificuldades severas de visao e NAO consegue acompanhar o chat do Claude Code. Mensagens de WhatsApp sao uma forma essencial de mante-lo informado, especialmente quando ele nao esta no computador.

## Quando Usar WhatsApp

| Momento | Exemplo |
|---------|---------|
| Ao receber mensagem via WhatsApp | Responder diretamente via `send_whatsapp` |
| Durante tarefas longas (a cada 2-3 minutos) | "Analisando o codigo do modulo X..." |
| Ao encontrar algo importante | "Encontrei o bug — era um null pointer no auth" |
| Ao fazer commit | "Commit feito: fix auth null pointer" |
| Ao finalizar uma tarefa | "Pronto! Implementei X, Y e Z. Fiz commit no branch main." |
| Quando bloqueado | "Preciso de uma decisao: usar Stripe ou PayPal?" |

## Tools

### `send_whatsapp`
Envia mensagem de texto, imagem, audio ou documento via WhatsApp.

**Parameters:**
- `type` (string): `text`, `image`, `audio`, ou `document`
- `message` (string): Texto da mensagem (para type=text)
- `to` (string, opcional): Numero do destinatario. Default: numero do Lucas

**Exemplos:**
```
send_whatsapp type="text" message="Comecei a implementar o feature X"
send_whatsapp type="text" message="Commit feito: feat: add user auth"
```

### `read_whatsapp`
Le mensagens recebidas via WhatsApp.

**Parameters:**
- `limit` (number, opcional): Quantidade de mensagens. Default: 20
- `since_timestamp` (number, opcional): Filtrar desde timestamp

## Mensagens Intermediarias (Status Updates)

### Regra Principal
Quando estiver trabalhando em uma tarefa recebida por WhatsApp, envie updates periodicos para que o Lucas saiba o que esta acontecendo.

### Frequencia
- **A cada 2-3 minutos** durante trabalho ativo
- **Imediatamente** quando algo significativo acontecer (erro, descoberta, commit)
- **Nunca** mais de uma mensagem por minuto (evitar spam)

### Formato das Mensagens de Status

Usar mensagens CURTAS e diretas:

**Inicio da tarefa:**
```
Entendi! Vou [descricao breve]. Te atualizo pelo WhatsApp.
```

**Progresso:**
```
Analisando [componente]...
Encontrei [achado]. Corrigindo...
Implementando [feature]...
Testando as mudancas...
```

**Commit/entrega:**
```
Commit: [mensagem do commit]
Branch: [nome da branch]
```

**Bloqueio/pergunta:**
```
Preciso de uma decisao: [opcao A] ou [opcao B]?
```

**Finalizacao:**
```
Pronto! [Resumo do que foi feito em 1-2 frases]
```

### O Que NAO Fazer
- Nao enviar mensagens longas com detalhes tecnicos
- Nao enviar stack traces ou logs
- Nao enviar mais de 3 mensagens seguidas sem resposta do usuario
- Nao repetir a mesma mensagem de status

## Fluxo Tipico

```
1. Lucas manda WhatsApp: "arruma o bug do login"
2. Claude le via read_whatsapp
3. send_whatsapp: "Entendi! Vou investigar o bug do login. Te atualizo."
4. [Claude investiga o codigo]
5. send_whatsapp: "Encontrei o problema — erro de validacao no middleware."
6. [Claude corrige]
7. send_whatsapp: "Corrigido e commitado: fix: validate auth token before middleware"
8. send_whatsapp: "Pronto! O bug era uma validacao faltando no middleware de auth. Fiz commit no main."
```

## Integracao com Telefone

- Se a tarefa e complexa e precisa de decisoes, prefira LIGAR (initiate_call)
- Se e um update simples de status, use WhatsApp
- Se o Lucas pediu via WhatsApp, responda por WhatsApp
- Se o Lucas pediu via telefone, responda por telefone

## Metodos de Envio (Ordem de Tentativa)

1. **MCP Tool**: `send_whatsapp` / `read_whatsapp`
2. **API Direta**: `POST http://localhost:3334/api/whatsapp/send_text`

## Resumo

> **Quando trabalhando em tarefa do WhatsApp: envie updates intermediarios. O Lucas precisa saber que voce esta trabalhando e o que esta fazendo. Sem updates = Lucas sem visibilidade = frustracao.**
