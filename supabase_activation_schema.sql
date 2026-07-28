alter table public.activation_codes
add column if not exists project_name text not null default 'ai-writing';

alter table public.client_quotas
add column if not exists project_name text not null default 'ai-writing';

update public.activation_codes
set project_name = 'read-tree'
where code like 'READTREE50-%';

update public.client_quotas quota
set project_name = 'read-tree'
where exists (
  select 1
  from public.activation_codes code
  where code.redeemed_by = quota.client_id
    and code.project_name = 'read-tree'
);

create unique index if not exists activation_codes_project_code_unique
on public.activation_codes (project_name, upper(trim(code)))
where code is not null and trim(code) <> '';

create unique index if not exists client_quotas_project_client_unique
on public.client_quotas (project_name, client_id);

alter table public.activation_codes enable row level security;
alter table public.client_quotas enable row level security;

revoke all on public.activation_codes from anon, authenticated;
revoke all on public.client_quotas from anon, authenticated;
grant select, insert, update on public.activation_codes to service_role;
grant select, insert, update on public.client_quotas to service_role;

create or replace function public.redeem_activation_code(
  p_client_id text,
  p_code text,
  p_project_name text default 'read-tree'
)
returns table (
  remaining_reviews integer,
  total_granted integer,
  total_used integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_client_id uuid;
  v_code public.activation_codes%rowtype;
  v_normalized_code text;
  v_project_name text;
begin
  v_normalized_code := upper(trim(p_code));
  v_project_name := lower(trim(coalesce(p_project_name, 'read-tree')));

  begin
    v_client_id := p_client_id::uuid;
  exception
    when invalid_text_representation then
      raise exception '客户端标识格式无效';
  end;

  if v_normalized_code = '' then
    raise exception '激活码不能为空';
  end if;

  if v_project_name = '' then
    raise exception '项目标识不能为空';
  end if;

  select *
  into v_code
  from public.activation_codes
  where project_name = v_project_name
    and upper(trim(code)) = v_normalized_code
  for update;

  if not found then
    raise exception '激活码不存在';
  end if;

  if v_code.status = 'used' then
    raise exception '激活码已被使用';
  end if;

  if v_code.status <> 'active' then
    raise exception '激活码不可用';
  end if;

  if v_code.expires_at is not null and v_code.expires_at < now() then
    raise exception '激活码已过期';
  end if;

  update public.activation_codes
  set
    status = 'used',
    redeemed_at = now(),
    redeemed_by = v_client_id
  where id = v_code.id;

  insert into public.client_quotas (
    client_id,
    project_name,
    remaining_reviews,
    total_granted,
    updated_at
  )
  values (
    v_client_id,
    v_project_name,
    v_code.grant_reviews,
    v_code.grant_reviews,
    now()
  )
  on conflict (project_name, client_id) do update
  set
    remaining_reviews = public.client_quotas.remaining_reviews + excluded.remaining_reviews,
    total_granted = public.client_quotas.total_granted + excluded.total_granted,
    updated_at = now();

  return query
  select
    q.remaining_reviews,
    q.total_granted,
    q.total_used
  from public.client_quotas q
  where q.client_id = v_client_id
    and q.project_name = v_project_name;
end;
$$;

create or replace function public.spend_client_quota(
  p_client_id text,
  p_reason text default 'ai',
  p_project_name text default 'read-tree'
)
returns table (
  remaining_reviews integer,
  total_granted integer,
  total_used integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_client_id uuid;
  v_project_name text;
  v_quota public.client_quotas%rowtype;
begin
  v_project_name := lower(trim(coalesce(p_project_name, 'read-tree')));

  begin
    v_client_id := p_client_id::uuid;
  exception
    when invalid_text_representation then
      raise exception '客户端标识格式无效';
  end;

  if v_project_name = '' then
    raise exception '项目标识不能为空';
  end if;

  select *
  into v_quota
  from public.client_quotas
  where client_id = v_client_id
    and project_name = v_project_name
  for update;

  if not found or v_quota.remaining_reviews <= 0 then
    raise exception 'AI 使用次数不足，请先兑换激活码';
  end if;

  update public.client_quotas
  set
    remaining_reviews = public.client_quotas.remaining_reviews - 1,
    total_used = public.client_quotas.total_used + 1,
    updated_at = now()
  where client_id = v_client_id
    and project_name = v_project_name;

  return query
  select
    q.remaining_reviews,
    q.total_granted,
    q.total_used
  from public.client_quotas q
  where q.client_id = v_client_id
    and q.project_name = v_project_name;
end;
$$;

create or replace function public.refund_client_quota(
  p_client_id text,
  p_reason text default 'ai_refund',
  p_project_name text default 'read-tree'
)
returns table (
  remaining_reviews integer,
  total_granted integer,
  total_used integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_client_id uuid;
  v_project_name text;
begin
  v_project_name := lower(trim(coalesce(p_project_name, 'read-tree')));

  begin
    v_client_id := p_client_id::uuid;
  exception
    when invalid_text_representation then
      raise exception '客户端标识格式无效';
  end;

  if v_project_name = '' then
    raise exception '项目标识不能为空';
  end if;

  update public.client_quotas
  set
    remaining_reviews = public.client_quotas.remaining_reviews + 1,
    total_used = greatest(public.client_quotas.total_used - 1, 0),
    updated_at = now()
  where client_id = v_client_id
    and project_name = v_project_name;

  return query
  select
    q.remaining_reviews,
    q.total_granted,
    q.total_used
  from public.client_quotas q
  where q.client_id = v_client_id
    and q.project_name = v_project_name;
end;
$$;

revoke all on function public.redeem_activation_code(text, text, text) from public;
revoke all on function public.spend_client_quota(text, text, text) from public;
revoke all on function public.refund_client_quota(text, text, text) from public;
grant execute on function public.redeem_activation_code(text, text, text) to service_role;
grant execute on function public.spend_client_quota(text, text, text) to service_role;
grant execute on function public.refund_client_quota(text, text, text) to service_role;

insert into public.activation_codes (code, project_name, grant_reviews, status)
select code, 'read-tree', 50, 'active'
from (
  values
    ('READTREE50-DEMO001'),
    ('READTREE50-DEMO002'),
    ('READTREE50-DEMO003')
) as seed(code)
where not exists (
  select 1
  from public.activation_codes existing
  where existing.project_name = 'read-tree'
    and upper(trim(existing.code)) = seed.code
);
