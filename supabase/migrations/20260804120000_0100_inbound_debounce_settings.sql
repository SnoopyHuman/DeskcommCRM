-- Onda 5 — debounce de rajada inbound configurável por organização.
-- Vive em organizations.settings.inbound_debounce (jsonb), mesmo padrão de
-- routing / context_lifecycle / llm. Sem tabela nova.
--
-- Default: enabled=true, window_ms=5000 — reproduz o comportamento atual do
-- env INBOUND_DEBOUNCE_MS. Orgs que já tiverem a chave intactas.

comment on column public.organizations.settings is
  'JSONB de config da org. Chaves conhecidas: llm, routing, context_lifecycle, ai_dispatch_mode, visibility_mode, canonical_conversation_tags, inbound_debounce ({enabled, window_ms, max_window_ms?}) — coalescência de rajada inbound (Onda 5).';

update public.organizations o
set settings = jsonb_set(
      coalesce(o.settings, '{}'::jsonb),
      '{inbound_debounce}',
      coalesce(o.settings->'inbound_debounce', '{}'::jsonb)
        || jsonb_build_object(
             'enabled', coalesce((o.settings->'inbound_debounce'->>'enabled')::boolean, true),
             'window_ms', coalesce((o.settings->'inbound_debounce'->>'window_ms')::int, 5000)
           ),
      true
    ),
    updated_at = now()
where o.settings->'inbound_debounce' is null
   or o.settings->'inbound_debounce' = '{}'::jsonb;
