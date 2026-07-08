create table if not exists public.investment_workbooks (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.investment_workbooks enable row level security;

drop policy if exists "Allow classroom workbook read" on public.investment_workbooks;
drop policy if exists "Allow classroom workbook write" on public.investment_workbooks;

create policy "Allow classroom workbook read"
on public.investment_workbooks
for select
to anon
using (true);

create policy "Allow classroom workbook write"
on public.investment_workbooks
for insert
to anon
with check (true);

create policy "Allow classroom workbook update"
on public.investment_workbooks
for update
to anon
using (true)
with check (true);

do $$
begin
  alter publication supabase_realtime add table public.investment_workbooks;
exception
  when duplicate_object then null;
end $$;
