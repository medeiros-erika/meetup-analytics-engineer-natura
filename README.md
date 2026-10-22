# Meetup SCD Tipo 2 · votações e perguntas ao vivo

Apresentação interativa do Chapter AE. Um único site com duas faces:

| Endereço | Quem usa | O que faz |
|---|---|---|
| `/` | Plateia (celular, via QR code) | Vota nas enquetes do slide atual, manda perguntas, curte perguntas |
| `/palco` | Apresentadora (com senha) | Slides 16:9, resultados ao vivo, painel de perguntas, revelar gabaritos, exportar dados |

Tudo fica gravado em Postgres. Quando a apresentadora avança o slide, o celular de todo mundo acompanha.

## Stack

- Node 20+ / Express, Server-Sent Events para o tempo real
- Postgres (`pg`), schema criado automaticamente no boot (`db/schema.sql`)
- QR code gerado pelo próprio servidor (`/qr.svg`) apontando para a URL do site

## Deploy no Render (Blueprint, ~5 min)

1. Suba esta pasta para um repositório no GitHub (pode ser privado).
2. No Render: **New → Blueprint** → escolha o repositório. O `render.yaml` cria:
   - o web service `meetup-scd2`
   - o Postgres `meetup-scd2-db`, já ligado via `DATABASE_URL`
   - um `SESSION_SECRET` aleatório
3. O Render vai pedir o valor de **`ADMIN_PASSWORD`**: é a senha do modo apresentadora.
4. Ao terminar o deploy, abra `https://<seu-servico>.onrender.com/palco`, entre com a senha e pronto. O QR code da capa já aponta para o endereço certo.

### Deploy manual (sem Blueprint)

1. **New → Postgres** → crie o banco e copie a *Internal Database URL*.
2. **New → Web Service** → repositório → Build `npm ci`, Start `npm start`.
3. Variáveis de ambiente: `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET` (qualquer texto longo e aleatório).

### Variáveis

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim | Conexão do Postgres |
| `ADMIN_PASSWORD` | sim | Senha do `/palco` |
| `SESSION_SECRET` | recomendada | Assina as sessões; se mudar, todo mundo ganha sessão nova |
| `PUBLIC_URL` | não | Força a URL do QR code (ex.: domínio próprio) |
| `PGSSL` | não | `true` para forçar SSL no banco |

### Pontos de atenção no plano free

- O web service **dorme após 15 min sem acesso** e leva ~1 min para acordar. Abra o `/palco` uns minutos antes de começar.
- O Postgres free **expira em 30 dias**. Exporte os dados depois do meetup (botão *Exportar* no palco) ou use um plano pago.
- O tempo real roda em memória: mantenha **uma instância** do web service.

## Rodar localmente

```bash
npm install
DATABASE_URL=postgres://usuario:senha@localhost:5432/meetup ADMIN_PASSWORD=teste npm start
# plateia: http://localhost:3000   apresentadora: http://localhost:3000/palco
```

## Modelo de dados

| Tabela | Grão | Observação |
|---|---|---|
| `participantes` | 1 por celular | id anônimo + nome opcional |
| `votos` | participante × enquete | estado atual (upsert) |
| `votos_historico` | 1 por clique | append-only: guarda as trocas de voto |
| `perguntas` | 1 por envio | `tipo` = `pergunta` ou `rodada`; apagar é soft delete (`apagada_em`) |
| `curtidas` | participante × pergunta | |
| `estado_palco` | 1 linha | slide atual, caso da dinâmica e enquetes reveladas |

### Zerar antes do evento (depois de testar)

```sql
truncate votos, votos_historico, curtidas, perguntas, participantes cascade;
update estado_palco set slide = 0, dn = 0, rev = '{}';
```

## Atalhos no palco

`→`/`espaço` próximo · `←` anterior · `Q` pergunta para a sala · `P` painel de perguntas · `C` QR code em tela cheia · `N` notas · `F` tela cheia
