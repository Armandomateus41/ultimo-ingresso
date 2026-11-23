/*
 * Esquema do banco e dados iniciais, como texto SQL.
 *
 * Fica em TypeScript (e não em arquivos .sql) para o build standalone do Next levar junto sem configuração:
 * o app aplica as migrações sozinho ao iniciar (src/instrumentation.ts), e os testes chamam as mesmas funções.
 */

export const MIGRACOES: { nome: string; sql: string }[] = [
  {
    nome: "001_inicial",
    sql: /* sql */ `
      CREATE TABLE eventos (
        id          text PRIMARY KEY,
        artista     text NOT NULL,
        turne       text NOT NULL,
        local       text NOT NULL,
        cidade      text NOT NULL,
        acontece_em timestamptz NOT NULL
      );

      CREATE TABLE setores (
        id             text PRIMARY KEY,
        evento_id      text NOT NULL REFERENCES eventos (id),
        nome           text NOT NULL,
        preco_centavos integer NOT NULL CHECK (preco_centavos > 0),
        ordem          integer NOT NULL
      );

      CREATE TABLE assentos (
        id        text PRIMARY KEY,
        evento_id text NOT NULL REFERENCES eventos (id),
        setor_id  text NOT NULL REFERENCES setores (id),
        fila      text NOT NULL,
        numero    integer NOT NULL,
        UNIQUE (setor_id, fila, numero)
      );

      -- Cada visitante ganha uma sessão: um "show" só dele, para repetir a demonstração sem esbarrar nos outros.
      CREATE TABLE sessoes (
        id        uuid PRIMARY KEY,
        criada_em timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE reservas (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sessao_id          uuid NOT NULL REFERENCES sessoes (id) ON DELETE CASCADE,
        evento_id          text NOT NULL REFERENCES eventos (id),
        assento_id         text NOT NULL REFERENCES assentos (id),
        comprador          text NOT NULL CHECK (length(comprador) BETWEEN 1 AND 40),
        status             text NOT NULL CHECK (status IN ('ativa', 'confirmada', 'expirada', 'cancelada')),
        expira_em          timestamptz NOT NULL,
        chave_idempotencia text NOT NULL,
        criada_em          timestamptz NOT NULL DEFAULT clock_timestamp(),
        atualizada_em      timestamptz NOT NULL DEFAULT clock_timestamp(),
        confirmada_em      timestamptz
      );

      /*
       * A regra principal: no máximo UMA reserva válida (ativa ou confirmada) por assento, sessão e evento.
       * O índice único parcial é o juiz das disputas: duas transações que tentam inserir a mesma linha ao
       * mesmo tempo esperam uma pela outra dentro do Postgres, e só a primeira a confirmar fica.
       * Reservas expiradas e canceladas saem do índice e liberam o assento.
       */
      CREATE UNIQUE INDEX reservas_uma_valida_por_assento
        ON reservas (sessao_id, evento_id, assento_id)
        WHERE status IN ('ativa', 'confirmada');

      -- Clique duplo: o mesmo pedido (mesma chave) nunca vira duas reservas.
      CREATE UNIQUE INDEX reservas_chave_idempotencia ON reservas (sessao_id, chave_idempotencia);

      CREATE INDEX reservas_por_sessao ON reservas (sessao_id, atualizada_em);
      CREATE INDEX reservas_ativas_por_vencimento ON reservas (sessao_id, expira_em) WHERE status = 'ativa';

      -- Um ingresso por reserva: confirmar duas vezes não emite dois ingressos.
      CREATE TABLE ingressos (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reserva_id uuid NOT NULL UNIQUE REFERENCES reservas (id) ON DELETE CASCADE,
        codigo     text NOT NULL UNIQUE,
        emitido_em timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `,
  },
];

/*
 * Show fictício, setores e assentos. Pode rodar quantas vezes quiser (ON CONFLICT DO NOTHING).
 * Ids dos assentos: <setor>-<fila>-<número com dois dígitos>, por exemplo "CEN-C-08".
 */
export const SEMENTE = /* sql */ `
  INSERT INTO eventos (id, artista, turne, local, cidade, acontece_em)
  VALUES ('cais-2027', 'Lia Brasa & Banda Cometa', 'Turnê Cais', 'Arena Mangue', 'Recife, PE', '2027-03-13T21:00:00-03:00')
  ON CONFLICT DO NOTHING;

  INSERT INTO setores (id, evento_id, nome, preco_centavos, ordem) VALUES
    ('MAR', 'cais-2027', 'Setor Maré', 18000, 1),
    ('CEN', 'cais-2027', 'Setor Central', 24000, 2),
    ('SOL', 'cais-2027', 'Setor Sol', 18000, 3),
    ('CAM', 'cais-2027', 'Camarote Lua', 42000, 4)
  ON CONFLICT DO NOTHING;

  -- Laterais: 7 filas (A a G) de 8 assentos. Central: 6 filas (A a F) de 14. Camarote: 1 fila de 10.
  INSERT INTO assentos (id, evento_id, setor_id, fila, numero)
  SELECT s.setor || '-' || chr(64 + f) || '-' || lpad(n::text, 2, '0'), 'cais-2027', s.setor, chr(64 + f), n
  FROM (VALUES ('MAR', 7, 8), ('SOL', 7, 8), ('CEN', 6, 14), ('CAM', 1, 10)) AS s (setor, filas, por_fila)
  CROSS JOIN LATERAL generate_series(1, s.filas) AS f
  CROSS JOIN LATERAL generate_series(1, s.por_fila) AS n
  ON CONFLICT DO NOTHING;
`;
