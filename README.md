# 🔀 CarrinhoLeve — Proxy

Servidor que repassa as buscas do site [CarrinhoLeve](https://github.com/eoshai/comparador) para o **Atacadão** e o **Mateus**.

Ele existe porque o navegador não consegue consultar as APIs dos mercados diretamente (bloqueio de CORS).

---

## ✨ O que ele faz

- Recebe a busca do site e consulta a loja correspondente
- **Cache em memória:** 5 minutos para buscas normais, 30 minutos para a lista padrão (busca vazia)
- **Deduplicação:** se várias pessoas buscam o mesmo termo ao mesmo tempo, só uma consulta vai para o mercado
- **Limite de requisições:** 60 por minuto por IP (responde `429` com `Retry-After`)
- **Timeout** de 8 segundos nas consultas aos mercados
- **Validação da resposta:** se o mercado devolver algo que não seja JSON (por exemplo, uma página de bloqueio), responde `502` em vez de repassar
- **CORS liberado** para qualquer origem
- Node 18+, **sem dependências externas**

---

## 🔌 Rotas

| Rota | Descrição |
| --- | --- |
| `GET /api/atacadao?term=ovos` | Busca no Atacadão |
| `GET /api/mateus?term=ovos` | Busca no Mateus |
| `GET /health` | Verifica se o servidor está no ar |

- `term` vazio é válido e retorna os produtos padrão
- `term` é cortado em 100 caracteres
- A resposta traz o cabeçalho `X-Cache: HIT` ou `MISS`

---

## 🚀 Como rodar localmente

**Pré-requisito:** Node.js 18 ou superior.

```sh
git clone https://github.com/eoshai/comparador-proxy.git
cd comparador-proxy
npm start
```

O servidor sobe em `http://localhost:3000`. Para testar:

```
http://localhost:3000/health
http://localhost:3000/api/atacadao?term=ovos
http://localhost:3000/api/mateus?term=ovos
```

### Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta do servidor |

### Ajustes no código

No topo do `server.js`:

| Constante | Padrão | Descrição |
| --- | --- | --- |
| `CACHE_TTL_MS` | 5 min | Validade do cache das buscas |
| `DEFAULT_TTL_MS` | 30 min | Validade do cache da lista padrão |
| `RATE_LIMIT` | 60 | Requisições por IP por minuto |
| `TIMEOUT_MS` | 8000 | Limite de tempo por consulta |

> Em eventos com muita gente na mesma rede Wi-Fi, todos aparecem com o mesmo IP. Se necessário, aumente o `RATE_LIMIT`.

---

## ☁️ Publicação (Render)

1. Crie um **Web Service** no [Render](https://render.com) ligado a este repositório
2. Configure:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Health check path:** `/health`
3. Copie a URL pública (algo como `https://seu-proxy.onrender.com`)
4. No repositório do site, coloque essa URL no `PROXY_BASE` de `src/lib/comparador.ts`

> 💡 **Plano gratuito:** o serviço "dorme" quando fica sem uso, e a primeira busca pode levar de 30 a 60 segundos. Abra `/health` alguns minutos antes de usar o site em um evento.

O cache e o limite de requisições ficam **na memória**, por isso o proxy deve rodar como um servidor contínuo (como o Render), e não como funções serverless.

---

## ⚠️ Observações

- Os mercados podem bloquear requisições vindas de servidores na nuvem. Se as rotas devolverem `502` com a mensagem de resposta inválida, esse é o provável motivo
- As APIs são as usadas pelos próprios sites dos mercados e **podem mudar a qualquer momento**
- Este é um projeto escolar, sem vínculo com o Atacadão ou o Mateus