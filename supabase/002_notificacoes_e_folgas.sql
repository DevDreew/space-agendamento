-- Notificações (Web Push), dias fechados e folgas. Já aplicado no projeto space-agendamento.
-- Os valores reais dos segredos ficam só no banco (private.segredos), nunca no GitHub.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
alter table public.bookings add column if not exists cancelado_por text check (cancelado_por in ('cliente','barbeiro')),
  add column if not exists motivo text check (length(motivo) <= 120),
  add column if not exists lembrete_enviado boolean not null default false;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.segredos (nome text primary key, valor text not null);
-- insert into private.segredos values ('webhook','<segredo>'),('vapid_publica','<chave>'),('vapid_privada','<chave>');
-- segredos_notificacao(): só service_role (usada pela função notificar)
-- push_subs: aparelhos com notificação ativa (papel barbeiro ou cliente). Sem acesso direto; só pelas funções:
--   registrar_push_cliente(p_sub, p_tokens) e registrar_push_barbeiro(p_sub)
-- pedir_horario passou a recusar dias em config.fechados e dias fora de barbers[].dias
-- cancelar_pedido marca cancelado_por = 'cliente'
-- gatilho bookings_avisar chama a função notificar a cada pedido novo e mudança de status
-- cron space-lembretes: todo dia às 18h (Brasília) manda lembrete da véspera para cliente e resumo para o barbeiro
