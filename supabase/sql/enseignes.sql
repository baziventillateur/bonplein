-- Enseignes des stations (Total, Shell, Esso…) tirées d'OpenStreetMap (© contributeurs OSM, ODbL).
-- Le flux officiel des prix ne contient ni nom ni marque : on rapproche chaque station officielle
-- de la station OSM qui porte sa référence (ref:FR:prix-carburants), sinon de la plus proche à 150 m max.
-- Tout tourne dans la base (pg_net + pg_cron), une zone de 1° par minute, les plus denses d'abord,
-- et chaque zone est refaite au bout de 7 jours. Appliqué par les migrations
-- enseigne_stations_osm, enseignes_import_par_zones, enseignes_tick_fix_variable, enseignes_tick_zones_denses_dabord.

create table if not exists public.enseigne (
  station_id bigint primary key,
  enseigne text not null,
  osm_id bigint,
  dist_m integer,
  maj timestamptz not null default now()
);
alter table public.enseigne enable row level security;
create policy "lecture publique" on public.enseigne for select to anon, authenticated using (true);
grant select on public.enseigne to anon, authenticated;

create table if not exists private.station_pos (
  station_id bigint primary key,
  lat double precision not null,
  lon double precision not null,
  maj timestamptz not null default now()
);
create index if not exists station_pos_lat_lon on private.station_pos (lat, lon);

create table if not exists private.enseigne_job (
  id text primary key,                                   -- 'positions' ou 'z:<lat>:<lon>' / 'z:<outre-mer>'
  s double precision, w double precision, n double precision, e double precision,
  req_id bigint, demande_le timestamptz, fait_le timestamptz, nb integer, erreur text
);
insert into private.enseigne_job (id) values ('positions') on conflict do nothing;
insert into private.enseigne_job (id, s, w, n, e)
select 'z:' || la || ':' || lo, la, lo, la + 1, lo + 1
from generate_series(41, 50) la, generate_series(-5, 9) lo on conflict do nothing;
insert into private.enseigne_job (id, s, w, n, e) values
  ('z:guadeloupe', 15.8, -61.9, 16.6, -60.9), ('z:martinique', 14.3, -61.3, 14.95, -60.75),
  ('z:guyane', 2.0, -54.7, 5.9, -51.5), ('z:reunion', -21.45, 55.15, -20.8, 55.9),
  ('z:mayotte', -13.1, 44.95, -12.55, 45.35)
on conflict do nothing;

-- Lecture du flux officiel (identifiant + position)
create or replace function private.enseigne_positions(doc jsonb) returns integer
language plpgsql set search_path = public, private, pg_temp as $$
declare n integer;
begin
  if jsonb_typeof(doc) <> 'array' or jsonb_array_length(doc) < 1000 then
    raise exception 'flux officiel incomplet';
  end if;
  insert into private.station_pos (station_id, lat, lon, maj)
  select distinct on (id) id, lat, lon, now() from (
    select (r->>'id')::bigint id, (r->'geom'->>'lat')::float8 lat, (r->'geom'->>'lon')::float8 lon
    from jsonb_array_elements(doc) r
    where (r->>'id') ~ '^\d+$'
  ) x
  where lat between -90 and 90 and lon between -180 and 180
  on conflict (station_id) do update set lat = excluded.lat, lon = excluded.lon, maj = excluded.maj;
  get diagnostics n = row_count;
  delete from private.station_pos where maj < now() - interval '30 days';
  return n;
end $$;

-- Rapprochement d'une zone
create or replace function private.enseigne_zone_apparier(p_zone text, doc jsonb) returns integer
language plpgsql set search_path = public, private, pg_temp as $$
declare z record; n integer; t timestamptz := now();
begin
  select * into z from private.enseigne_job where id = p_zone;
  with osm as (
    select (el->>'id')::bigint as osm_id,
      coalesce((el->>'lat')::float8, (el->'center'->>'lat')::float8) as lat,
      coalesce((el->>'lon')::float8, (el->'center'->>'lon')::float8) as lon,
      coalesce(
        nullif(btrim(el->'tags'->>'brand'), ''),
        case when btrim(el->'tags'->>'name') ~* '^(station[ -]?(service|essence)?|carburants?|essence|gas station|fuel)$' then null
             else nullif(btrim(el->'tags'->>'name'), '') end
      ) as enseigne,
      string_to_array(coalesce(el->'tags'->>'ref:FR:prix-carburants', ''), ';') as refs
    from jsonb_array_elements(doc->'elements') el
  ), st as (
    select station_id, lat, lon from private.station_pos
    where lat >= z.s and lat < z.n and lon >= z.w and lon < z.e
  ), cand as (
    select st.station_id, o.osm_id, o.enseigne,
      round(111320 * sqrt(power(o.lat - st.lat, 2) + power((o.lon - st.lon) * cos(radians(st.lat)), 2)))::int as dist_m,
      (st.station_id::text = any(o.refs)) as par_ref
    from st join osm o on o.enseigne is not null and o.lat is not null
      and (st.station_id::text = any(o.refs) or (abs(o.lat - st.lat) < 0.0015 and abs(o.lon - st.lon) < 0.0025))
  ), choix as (
    select distinct on (station_id) * from cand where par_ref or dist_m <= 150
    order by station_id, par_ref desc, dist_m
  ), uniq as (
    select distinct on (osm_id) * from choix order by osm_id, par_ref desc, dist_m
  )
  insert into public.enseigne (station_id, enseigne, osm_id, dist_m, maj)
  select station_id, left(enseigne, 60), osm_id, dist_m, t from uniq
  on conflict (station_id) do update
    set enseigne = excluded.enseigne, osm_id = excluded.osm_id, dist_m = excluded.dist_m, maj = excluded.maj;
  get diagnostics n = row_count;
  delete from public.enseigne en using private.station_pos p
   where en.station_id = p.station_id and p.lat >= z.s and p.lat < z.n and p.lon >= z.w and p.lon < z.e and en.maj < t;
  return n;
end $$;

-- Une étape par minute : traite la réponse arrivée, puis lance une seule nouvelle requête
create or replace function private.enseigne_tick() returns text
language plpgsql set search_path = public, private, pg_temp as $$
declare j record; r record; doc jsonb; v_nb integer; msg text := '';
begin
  for j in select * from private.enseigne_job where req_id is not null for update loop
    select status_code, content, error_msg into r from net._http_response where id = j.req_id;
    if not found then
      if j.demande_le < now() - interval '15 minutes' then
        update private.enseigne_job set req_id = null, erreur = 'réponse perdue' where id = j.id;
      end if;
      continue;
    end if;
    begin
      if r.status_code is distinct from 200 then
        raise exception 'HTTP % %', r.status_code, coalesce(r.error_msg, left(r.content, 200));
      end if;
      doc := r.content::jsonb;
      if j.id = 'positions' then
        v_nb := private.enseigne_positions(doc);
      else
        if coalesce(doc->>'remark', '') ilike '%error%' then
          raise exception 'Overpass : %', left(doc->>'remark', 200);
        end if;
        v_nb := private.enseigne_zone_apparier(j.id, doc);
      end if;
      update private.enseigne_job set req_id = null, fait_le = now(), nb = v_nb, erreur = null where id = j.id;
      msg := msg || j.id || '=' || v_nb || ' ';
    exception when others then
      update private.enseigne_job set req_id = null, erreur = left(sqlerrm, 300) where id = j.id;
      msg := msg || j.id || ' erreur ';
    end;
  end loop;

  if exists (select 1 from private.enseigne_job where req_id is not null) then
    return msg || 'en attente';
  end if;

  if exists (select 1 from private.enseigne_job where id = 'positions'
             and (fait_le is null or fait_le < now() - interval '7 days')
             and (demande_le is null or demande_le < now() - interval '30 minutes')) then
    update private.enseigne_job set demande_le = now(), req_id = net.http_get(
      url := 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json',
      params := jsonb_build_object('select', 'id,geom'),
      headers := jsonb_build_object('Accept', 'application/json'),
      timeout_milliseconds := 120000)
    where id = 'positions';
    return msg || 'positions demandées';
  end if;

  -- Zone suivante : jamais faite ou vieille d'une semaine, les plus denses d'abord
  select z.* into j from private.enseigne_job z
  cross join lateral (select count(*) as nst from private.station_pos p
                      where p.lat >= z.s and p.lat < z.n and p.lon >= z.w and p.lon < z.e) c
  where z.id <> 'positions' and c.nst > 0
    and (z.fait_le is null or z.fait_le < now() - interval '7 days')
    and (z.demande_le is null or z.demande_le < now() - interval '30 minutes')
  order by z.fait_le nulls first, c.nst desc, z.id
  limit 1;
  if found then
    update private.enseigne_job set demande_le = now(), req_id = net.http_get(
      url := 'https://overpass-api.de/api/interpreter',
      params := jsonb_build_object('data', format('[out:json][timeout:150];nwr["amenity"="fuel"](%s,%s,%s,%s);out center tags;',
        j.s - 0.01, j.w - 0.01, j.n + 0.01, j.e + 0.01)),
      headers := jsonb_build_object('User-Agent', 'Bonplein/1.0 (https://bonplein.paceapp.fr; contact@paceapp.fr)', 'Accept', '*/*'),
      timeout_milliseconds := 180000)
    where id = j.id;
    return msg || j.id || ' demandée';
  end if;
  return msg || 'rien à faire';
end $$;

revoke all on function private.enseigne_positions(jsonb) from public;
revoke all on function private.enseigne_zone_apparier(text, jsonb) from public;
revoke all on function private.enseigne_tick() from public;

select cron.schedule('enseignes', '* * * * *', 'select private.enseigne_tick()');
