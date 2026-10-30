-- Delivery buy list: stocks to accumulate, with target qty/price and fill lots.

create table if not exists public.delivery_plans (
  id text primary key,
  user_id text not null,
  symbol text not null,
  name text not null default '',
  isin text,
  quantity int not null default 0,
  target_price double precision not null default 0,
  bought_qty int not null default 0,
  fills jsonb not null default '[]'::jsonb,
  sort_order int not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create unique index if not exists idx_delivery_plans_user_symbol
  on public.delivery_plans (user_id, symbol);

create index if not exists idx_delivery_plans_user_sort
  on public.delivery_plans (user_id, sort_order, created_at);

alter table public.delivery_plans enable row level security;

drop policy if exists delivery_plans_all on public.delivery_plans;
create policy delivery_plans_all on public.delivery_plans for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

do $$
begin
  execute 'alter publication supabase_realtime add table public.delivery_plans';
exception
  when duplicate_object then null;
end $$;
