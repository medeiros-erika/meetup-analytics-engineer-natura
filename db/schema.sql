-- Schema do Meetup SCD Tipo 2. Idempotente: roda a cada boot do servidor.

create table if not exists participantes (
  id          uuid primary key,
  nome        text,
  criado_em   timestamptz not null default now(),
  visto_em    timestamptz not null default now()
);

-- Estado atual do voto (um por pessoa por enquete)
create table if not exists votos (
  participante_id uuid not null references participantes(id) on delete cascade,
  enquete_id      text not null,
  opcao           smallint not null,
  atualizado_em   timestamptz not null default now(),
  primary key (participante_id, enquete_id)
);

-- Histórico append-only de cada voto (inclusive trocas de opção)
create table if not exists votos_historico (
  id              bigserial primary key,
  participante_id uuid not null,
  enquete_id      text not null,
  opcao           smallint not null,
  registrado_em   timestamptz not null default now()
);

create table if not exists perguntas (
  id              text primary key,
  participante_id uuid not null references participantes(id) on delete cascade,
  nome            text,                  -- nome no momento do envio
  texto           text not null check (char_length(texto) between 1 and 280),
  anonima         boolean not null default false,
  tipo            text not null default 'pergunta' check (tipo in ('pergunta','rodada')),
  respondida      boolean not null default false,
  criada_em       timestamptz not null default now(),
  apagada_em      timestamptz            -- soft delete: nada some do banco
);
create index if not exists perguntas_ativas on perguntas (criada_em) where apagada_em is null;

create table if not exists curtidas (
  participante_id uuid not null references participantes(id) on delete cascade,
  pergunta_id     text not null references perguntas(id) on delete cascade,
  criada_em       timestamptz not null default now(),
  primary key (participante_id, pergunta_id)
);

-- Estado do palco (slide atual, caso da dinâmica, enquetes reveladas)
create table if not exists estado_palco (
  id            smallint primary key default 1 check (id = 1),
  slide         integer not null default 0,
  dn            integer not null default 0,
  rev           jsonb   not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);
insert into estado_palco (id) values (1) on conflict (id) do nothing;
