create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'operator')),
  active boolean not null default true,
  must_change_password boolean not null default false,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists mfa_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists mfa_codes_user_idx on mfa_codes (user_id, created_at desc);

create table if not exists lines (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  carrier text not null,
  line_type text not null check (line_type in ('DADOS', 'DADOS_VOZ')),
  account text,
  assignee_name text,
  project text,
  delivery_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table lines add column if not exists account text;

create table if not exists line_history (
  id bigserial primary key,
  line_id uuid not null references lines(id) on delete cascade,
  action text not null,
  assignee_name text,
  project text,
  delivery_date date,
  changed_by_name text,
  changed_at timestamptz not null default now()
);
create index if not exists line_history_line_idx on line_history (line_id, changed_at desc);

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  carrier text not null,
  reference_month date not null,
  filename text not null,
  file_hash text not null unique,
  total_amount numeric(14,2) not null default 0,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);
create index if not exists invoices_month_idx on invoices (reference_month);

create table if not exists consumption (
  id bigserial primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  number text not null,
  voice_minutes numeric(14,2) not null default 0,
  data_mb numeric(16,2) not null default 0,
  amount numeric(14,2) not null default 0,
  assignee_name text,
  project text,
  unique (invoice_id, number)
);
create index if not exists consumption_number_idx on consumption (number);

create table if not exists rate_limits (
  key text primary key,
  count int not null,
  reset_at timestamptz not null
);

alter table users add column if not exists token_version int not null default 0;

create or replace function ensure_one_active_admin() returns trigger language plpgsql as $$
begin
  if old.role = 'admin' and old.active and not (new.role = 'admin' and new.active) then
    perform pg_advisory_xact_lock(7241);
    if not exists (select 1 from users where role = 'admin' and active and id <> old.id) then
      raise exception 'last_admin';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists users_keep_admin on users;

create trigger users_keep_admin before update on users
  for each row execute function ensure_one_active_admin();
