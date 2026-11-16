-- Space · banco de dados multi-barbearia
create extension if not exists btree_gist;

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$' and slug not in ('painel','api','admin','index','assets')),
  name text not null check (length(name) between 2 and 60),
  owner uuid not null references auth.users(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index shops_owner_one on public.shops(owner);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  barber_id text not null,
  day date not null,
  start_min int not null check (start_min between 0 and 1439),
  dur int not null check (dur between 5 and 600),
  svc text not null default '',
  svc_name text not null default '',
  price numeric(10,2) not null default 0 check (price >= 0),
  plan_name text,
  status text not null check (status in ('pendente','confirmado','recusado','cancelado','concluido','nao-veio','bloqueado')),
  client_name text not null default '' check (length(client_name) <= 80),
  client_phone text not null default '' check (client_phone ~ '^[0-9]{0,13}$'),
  note text not null default '' check (length(note) <= 200),
  manage_token uuid not null default gen_random_uuid(),
  is_example boolean not null default false,
  created_at timestamptz not null default now(),
  constraint sem_conflito exclude using gist (
    shop_id with =, barber_id with =, day with =,
    int4range(start_min, start_min + dur) with &&
  ) where (status in ('pendente','confirmado','bloqueado','concluido'))
);
create index bookings_shop_day on public.bookings(shop_id, day);
create index bookings_token on public.bookings(manage_token);

create table public.subscribers (
  shop_id uuid not null references public.shops(id) on delete cascade,
  phone text not null check (phone ~ '^[0-9]{10,13}$'),
  plan_id text not null,
  since date not null default current_date,
  primary key (shop_id, phone)
);

alter table public.shops enable row level security;
alter table public.bookings enable row level security;
alter table public.subscribers enable row level security;

-- Vitrine pública: qualquer um lê nome e configuração da barbearia (sem dados de clientes)
create policy shops_leitura_publica on public.shops for select using (true);
create policy shops_dono_altera on public.shops for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- Agendamentos e assinantes: só o dono da barbearia
create policy bookings_dono on public.bookings for all to authenticated
  using (exists (select 1 from public.shops s where s.id = shop_id and s.owner = (select auth.uid())))
  with check (exists (select 1 from public.shops s where s.id = shop_id and s.owner = (select auth.uid())));
create policy subscribers_dono on public.subscribers for all to authenticated
  using (exists (select 1 from public.shops s where s.id = shop_id and s.owner = (select auth.uid())))
  with check (exists (select 1 from public.shops s where s.id = shop_id and s.owner = (select auth.uid())));

revoke all on public.bookings, public.subscribers from anon;
grant select on public.shops to anon, authenticated;
grant update (name, config) on public.shops to authenticated;
grant select, insert, update, delete on public.bookings, public.subscribers to authenticated;

-- Horários ocupados (sem nome nem telefone) para a tela do cliente
create or replace function public.horarios_ocupados(p_slug text, p_de date, p_ate date)
returns table(barber_id text, day date, start_min int, dur int)
language sql stable security definer set search_path = public as $$
  select b.barber_id, b.day, b.start_min, b.dur from bookings b join shops s on s.id = b.shop_id
  where s.slug = p_slug and b.day between p_de and least(p_ate, p_de + 45)
    and b.status in ('pendente','confirmado','bloqueado','concluido');
$$;

-- Cliente pede um horário: valida tudo no servidor
create or replace function public.pedir_horario(p_slug text, p_barber text, p_day date, p_start int, p_svc text,
  p_name text, p_phone text, p_note text default '')
returns table(id uuid, manage_token uuid, price numeric, plan_name text, svc_name text, dur int)
language plpgsql volatile security definer set search_path = public as $$
declare s shops; v jsonb; h jsonb; agora timestamp := (now() at time zone 'America/Sao_Paulo');
  v_dur int; v_price numeric; v_plan text; v_svcname text; sub subscribers; pl jsonb; r bookings;
begin
  select * into s from shops where slug = p_slug;
  if not found then raise exception 'barbearia_nao_encontrada'; end if;
  select x into v from jsonb_array_elements(s.config->'services') x where x->>'id' = p_svc;
  if v is null then raise exception 'servico_invalido'; end if;
  if not exists (select 1 from jsonb_array_elements(s.config->'barbers') b where b->>'id' = p_barber and coalesce((b->>'active')::boolean, true)) then
    raise exception 'barbeiro_invalido'; end if;
  p_name := btrim(coalesce(p_name,'')); p_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if length(p_name) < 2 or length(p_name) > 80 then raise exception 'nome_invalido'; end if;
  if length(p_phone) not between 10 and 11 then raise exception 'telefone_invalido'; end if;
  if p_day < agora::date or p_day > agora::date + 30 then raise exception 'dia_invalido'; end if;
  v_dur := (v->>'dur')::int; v_price := (v->>'price')::numeric; v_svcname := v->>'name';
  h := s.config->'hours'->(extract(dow from p_day)::int)::text;
  if h is null or jsonb_typeof(h) <> 'array' then raise exception 'fechado'; end if;
  if p_start < (h->>0)::int or p_start + v_dur > (h->>1)::int then raise exception 'fora_do_horario'; end if;
  if p_day = agora::date and p_start < extract(hour from agora)*60 + extract(minute from agora) + 10 then raise exception 'horario_passou'; end if;
  if jsonb_typeof(s.config->'lunch') = 'array' and p_start < (s.config->'lunch'->>1)::int and p_start + v_dur > (s.config->'lunch'->>0)::int then raise exception 'almoco'; end if;
  if (select count(*) from bookings b where b.shop_id = s.id and b.client_phone = p_phone and b.status = 'pendente' and b.day >= agora::date) >= 3 then
    raise exception 'muitos_pedidos'; end if;
  select * into sub from subscribers where shop_id = s.id and phone = p_phone;
  if found then
    select x into pl from jsonb_array_elements(s.config->'planos') x where x->>'id' = sub.plan_id;
    if pl is not null and (pl->'svcs') ? p_svc then v_price := 0; v_plan := pl->>'name'; end if;
  end if;
  begin
    insert into bookings(shop_id, barber_id, day, start_min, dur, svc, svc_name, price, plan_name, status, client_name, client_phone, note)
    values (s.id, p_barber, p_day, p_start, v_dur, p_svc, v_svcname, v_price, v_plan, 'pendente', p_name, p_phone, left(coalesce(p_note,''),200))
    returning * into r;
  exception when exclusion_violation then raise exception 'horario_ocupado';
  end;
  return query select r.id, r.manage_token, r.price, r.plan_name, r.svc_name, r.dur;
end $$;

-- Cliente vê os próprios pedidos pelo código guardado no aparelho dele
create or replace function public.meus_pedidos(p_tokens uuid[])
returns table(id uuid, manage_token uuid, shop_slug text, barber_id text, day date, start_min int, dur int, svc text, svc_name text, price numeric, plan_name text, status text, client_name text, client_phone text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.id, b.manage_token, s.slug, b.barber_id, b.day, b.start_min, b.dur, b.svc, b.svc_name, b.price, b.plan_name, b.status, b.client_name, b.client_phone, b.created_at
  from bookings b join shops s on s.id = b.shop_id where b.manage_token = any(p_tokens[1:50]);
$$;

create or replace function public.cancelar_pedido(p_token uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  update bookings set status = 'cancelado'
  where manage_token = p_token and status in ('pendente','confirmado')
    and (day > (now() at time zone 'America/Sao_Paulo')::date
      or (day = (now() at time zone 'America/Sao_Paulo')::date and start_min > extract(hour from now() at time zone 'America/Sao_Paulo')*60 + extract(minute from now() at time zone 'America/Sao_Paulo')));
  if not found then raise exception 'nao_pode_cancelar'; end if;
end $$;

-- Barbeiro cria a própria barbearia (uma por conta)
create or replace function public.criar_barbearia(p_slug text, p_name text, p_config jsonb)
returns shops language plpgsql volatile security definer set search_path = public as $$
declare r shops;
begin
  if (select auth.uid()) is null then raise exception 'precisa_login'; end if;
  insert into shops(slug, name, owner, config) values (lower(p_slug), p_name, (select auth.uid()), coalesce(p_config,'{}'::jsonb)) returning * into r;
  return r;
exception when unique_violation then raise exception 'endereco_em_uso';
end $$;

revoke all on function public.horarios_ocupados, public.pedir_horario, public.meus_pedidos, public.cancelar_pedido, public.criar_barbearia from public;
grant execute on function public.horarios_ocupados, public.pedir_horario, public.meus_pedidos, public.cancelar_pedido to anon, authenticated;
grant execute on function public.criar_barbearia to authenticated;

-- Atualização ao vivo do painel
alter publication supabase_realtime add table public.bookings;
