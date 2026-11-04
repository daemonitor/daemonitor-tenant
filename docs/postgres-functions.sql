-- Postgres functions the tenant ports, as defined in production on 2026-11-04
-- (pg_get_functiondef). purge_history_thin_batched and purge_history_age_out
-- exist in no migration; this is their only copy outside the database.

Output format is unaligned.
CREATE OR REPLACE FUNCTION public.history_batch_sampled(p_uids text[], p_since timestamp with time zone, p_buckets integer)
 RETURNS TABLE(unique_id text, system_id uuid, data jsonb, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select distinct on (h.unique_id, h.system_id, h.bkt)
         h.unique_id, h.system_id, h.data, h.created_at
  from (
    select ch.unique_id, ch.system_id, ch.data, ch.created_at,
           floor(
             extract(epoch from (ch.created_at - p_since))
             / greatest(1, extract(epoch from (now() - p_since)) / greatest(1, p_buckets))
           ) as bkt
    from public.client_state_history ch
    where ch.unique_id = any(p_uids)
      and ch.created_at >= p_since
  ) h
  -- newest row wins per bucket; overall order is chronological per service
  order by h.unique_id, h.system_id, h.bkt, h.created_at desc
$function$
;

CREATE OR REPLACE FUNCTION public.history_batch_series(p_uids text[], p_since timestamp with time zone, p_buckets integer)
 RETURNS TABLE(unique_id text, system_id uuid, cpu numeric, mem numeric, disk numeric, net numeric, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pairs as materialized (
    select distinct cs.unique_id, cs.system_id
    from public.client_states cs
    where cs.unique_id = any(p_uids) and cs.archived = false
  ),
  span as (
    select greatest(1, extract(epoch from (now() - p_since)) / greatest(1, p_buckets)) as sec
  ),
  sampled as materialized (
    select p.unique_id, p.system_id, h.type, h.data, h.created_at
    from pairs p
    cross join span s
    cross join generate_series(0, p_buckets - 1) as b
    cross join lateral (
      select h2.type, h2.data, h2.created_at
      from public.client_state_history h2
      where h2.unique_id = p.unique_id
        and h2.system_id = p.system_id
        and h2.created_at >= p_since + (b * s.sec) * interval '1 second'
        and h2.created_at <  p_since + ((b + 1) * s.sec) * interval '1 second'
      order by h2.created_at desc
      limit 1
    ) h
  ),
  derived as (
    select
      s.unique_id, s.system_id, s.type, s.created_at,
      case when s.type = 'os' then (
        select sum(coalesce((c->'times'->>'idle')::numeric, 0))
        from jsonb_array_elements(coalesce(s.data->'cpus', '[]'::jsonb)) c
      ) end as os_idle,
      case when s.type = 'os' then (
        select sum(coalesce((c->'times'->>'user')::numeric,0) + coalesce((c->'times'->>'nice')::numeric,0)
                 + coalesce((c->'times'->>'sys')::numeric,0) + coalesce((c->'times'->>'idle')::numeric,0)
                 + coalesce((c->'times'->>'irq')::numeric,0))
        from jsonb_array_elements(coalesce(s.data->'cpus', '[]'::jsonb)) c
      ) end as os_total,
      case when s.type = 'os' then
        case when coalesce((s.data->>'totalmem')::numeric, 0) > 0
          then round((1 - coalesce((s.data->>'available')::numeric, (s.data->>'freemem')::numeric, 0)
                        / (s.data->>'totalmem')::numeric) * 100)
          else 0 end
      end as mem,
      case when s.type = 'os' then (
        select coalesce(max(greatest(0, least(100, round(coalesce((d->>'pct')::numeric, 0))))), 0)
        from jsonb_array_elements(coalesce(s.data->'disks', '[]'::jsonb)) d
      ) end as disk,
      -- network throughput: os only, rx+tx bytes/sec (null when not yet recorded)
      case when s.type = 'os' and s.data ? 'network' then
        coalesce((s.data->'network'->>'rxRate')::numeric, 0) + coalesce((s.data->'network'->>'txRate')::numeric, 0)
      end as net,
      case
        when s.type = 'pm2' then round(coalesce((s.data->'monit'->>'cpu')::numeric, 0))
        when s.type = 'lxc-container' then round(coalesce((s.data->'container'->>'cpu')::numeric, 0))
        when s.type in ('docker', 'lxc') then (
          select round(coalesce(sum(coalesce((c->>'cpu')::numeric, 0)), 0))
          from jsonb_array_elements(coalesce(s.data->'containers', '[]'::jsonb)) c
        )
      end as direct_cpu
    from sampled s
  ),
  withdelta as (
    select d.*,
           lag(os_idle) over w  as prev_idle,
           lag(os_total) over w as prev_total
    from derived d
    window w as (partition by unique_id, system_id order by created_at)
  )
  select
    unique_id, system_id,
    case
      when type = 'os' then
        case when prev_total is not null and os_total > prev_total
          then greatest(0, least(100, round((1 - (os_idle - prev_idle) / (os_total - prev_total)) * 100)))
        end
      else direct_cpu
    end as cpu,
    mem, disk, net, created_at
  from withdelta
  order by unique_id, system_id, created_at
$function$
;

CREATE OR REPLACE FUNCTION public.history_batch_series(p_uids text[], p_systems uuid[], p_since timestamp with time zone, p_buckets integer)
 RETURNS TABLE(unique_id text, system_id uuid, cpu numeric, mem numeric, disk numeric, net numeric, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pairs as materialized (
    select distinct cs.unique_id, cs.system_id
    from unnest(p_uids, p_systems) as w(uid, sys)
    join public.client_states cs
      on cs.unique_id = w.uid and cs.system_id = w.sys
    where cs.archived = false
  ),
  span as (
    select greatest(1, extract(epoch from (now() - p_since)) / greatest(1, p_buckets)) as sec
  ),
  sampled as materialized (
    select p.unique_id, p.system_id, h.type, h.data, h.created_at
    from pairs p
    cross join span s
    cross join generate_series(0, p_buckets - 1) as b
    cross join lateral (
      select h2.type, h2.data, h2.created_at
      from public.client_state_history h2
      where h2.unique_id = p.unique_id
        and h2.system_id = p.system_id
        and h2.created_at >= p_since + (b * s.sec) * interval '1 second'
        and h2.created_at <  p_since + ((b + 1) * s.sec) * interval '1 second'
      order by h2.created_at desc
      limit 1
    ) h
  ),
  derived as (
    select
      s.unique_id, s.system_id, s.type, s.created_at,
      case when s.type = 'os' then (
        select sum(coalesce((c->'times'->>'idle')::numeric, 0))
        from jsonb_array_elements(coalesce(s.data->'cpus', '[]'::jsonb)) c
      ) end as os_idle,
      case when s.type = 'os' then (
        select sum(coalesce((c->'times'->>'user')::numeric,0) + coalesce((c->'times'->>'nice')::numeric,0)
                 + coalesce((c->'times'->>'sys')::numeric,0) + coalesce((c->'times'->>'idle')::numeric,0)
                 + coalesce((c->'times'->>'irq')::numeric,0))
        from jsonb_array_elements(coalesce(s.data->'cpus', '[]'::jsonb)) c
      ) end as os_total,
      case when s.type = 'os' then
        case when coalesce((s.data->>'totalmem')::numeric, 0) > 0
          then round((1 - coalesce((s.data->>'available')::numeric, (s.data->>'freemem')::numeric, 0)
                        / (s.data->>'totalmem')::numeric) * 100)
          else 0 end
      end as mem,
      case when s.type = 'os' then (
        select coalesce(max(greatest(0, least(100, round(coalesce((d->>'pct')::numeric, 0))))), 0)
        from jsonb_array_elements(coalesce(s.data->'disks', '[]'::jsonb)) d
      ) end as disk,
      -- network throughput: os only, rx+tx bytes/sec (null when not yet recorded)
      case when s.type = 'os' and s.data ? 'network' then
        coalesce((s.data->'network'->>'rxRate')::numeric, 0) + coalesce((s.data->'network'->>'txRate')::numeric, 0)
      end as net,
      case
        when s.type = 'pm2' then round(coalesce((s.data->'monit'->>'cpu')::numeric, 0))
        when s.type = 'lxc-container' then round(coalesce((s.data->'container'->>'cpu')::numeric, 0))
        when s.type in ('docker', 'lxc') then (
          select round(coalesce(sum(coalesce((c->>'cpu')::numeric, 0)), 0))
          from jsonb_array_elements(coalesce(s.data->'containers', '[]'::jsonb)) c
        )
      end as direct_cpu
    from sampled s
  ),
  withdelta as (
    select d.*,
           lag(os_idle) over w  as prev_idle,
           lag(os_total) over w as prev_total
    from derived d
    window w as (partition by unique_id, system_id order by created_at)
  )
  select
    unique_id, system_id,
    case
      when type = 'os' then
        case when prev_total is not null and os_total > prev_total
          then greatest(0, least(100, round((1 - (os_idle - prev_idle) / (os_total - prev_total)) * 100)))
        end
      else direct_cpu
    end as cpu,
    mem, disk, net, created_at
  from withdelta
  order by unique_id, system_id, created_at
$function$
;

CREATE OR REPLACE FUNCTION public.history_value_series(p_uids text[], p_since timestamp with time zone, p_buckets integer)
 RETURNS TABLE(unique_id text, system_id uuid, val numeric, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pairs as materialized (
    select distinct cs.unique_id, cs.system_id, cs.type
    from public.client_states cs
    where cs.unique_id = any(p_uids) and cs.archived = false
  ),
  span as (
    select greatest(1, extract(epoch from (now() - p_since)) / greatest(1, p_buckets)) as sec
  ),
  sampled as materialized (
    select p.unique_id, p.system_id, p.type, h.data, h.created_at
    from pairs p
    cross join span s
    cross join generate_series(0, p_buckets - 1) as b
    cross join lateral (
      select h2.data, h2.created_at
      from public.client_state_history h2
      where h2.unique_id = p.unique_id
        and h2.system_id = p.system_id
        and h2.created_at >= p_since + (b * s.sec) * interval '1 second'
        and h2.created_at <  p_since + ((b + 1) * s.sec) * interval '1 second'
      order by h2.created_at desc
      limit 1
    ) h
  )
  select
    s.unique_id,
    s.system_id,
    case
      when s.type in ('web', 'website')
        then round(coalesce((s.data ->> 'duration')::numeric, 0))
      when s.type = 'cloudflare-worker-script'
        then coalesce((s.data -> 'script' ->> 'requests')::numeric, 0)
      when s.type = 'cloudflare-project'
        then coalesce((s.data -> 'project' -> 'analytics' ->> 'requests')::numeric, 0)
    end as val,
    s.created_at
  from sampled s
  order by s.unique_id, s.system_id, s.created_at
$function$
;

CREATE OR REPLACE FUNCTION public.history_value_series(p_uids text[], p_systems uuid[], p_since timestamp with time zone, p_buckets integer)
 RETURNS TABLE(unique_id text, system_id uuid, val numeric, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with pairs as materialized (
    select distinct cs.unique_id, cs.system_id, cs.type
    from unnest(p_uids, p_systems) as w(uid, sys)
    join public.client_states cs
      on cs.unique_id = w.uid and cs.system_id = w.sys
    where cs.archived = false
  ),
  span as (
    select greatest(1, extract(epoch from (now() - p_since)) / greatest(1, p_buckets)) as sec
  ),
  sampled as materialized (
    select p.unique_id, p.system_id, p.type, h.data, h.created_at
    from pairs p
    cross join span s
    cross join generate_series(0, p_buckets - 1) as b
    cross join lateral (
      select h2.data, h2.created_at
      from public.client_state_history h2
      where h2.unique_id = p.unique_id
        and h2.system_id = p.system_id
        and h2.created_at >= p_since + (b * s.sec) * interval '1 second'
        and h2.created_at <  p_since + ((b + 1) * s.sec) * interval '1 second'
      order by h2.created_at desc
      limit 1
    ) h
  )
  select
    s.unique_id,
    s.system_id,
    case
      when s.type in ('web', 'website')
        then round(coalesce((s.data ->> 'duration')::numeric, 0))
      when s.type = 'cloudflare-worker-script'
        then coalesce((s.data -> 'script' ->> 'requests')::numeric, 0)
      when s.type = 'cloudflare-project'
        then coalesce((s.data -> 'project' -> 'analytics' ->> 'requests')::numeric, 0)
      when s.type = 'device' then (
        select sum(coalesce((i ->> 'inBps')::numeric, 0) + coalesce((i ->> 'outBps')::numeric, 0))
        from jsonb_array_elements(sw.ifs) i
      )
    end as val,
    s.created_at
  from sampled s
  cross join lateral (
    select case when jsonb_typeof(x.sw -> 'interfaces') = 'array' then x.sw -> 'interfaces' end as ifs
    from (select coalesce(
      s.data -> 'sources' -> 'tplinkswitch',
      case when s.data -> 'sources' -> 'snmp' ->> 'kind' = 'switch' then s.data -> 'sources' -> 'snmp' end
    ) as sw) x
  ) sw
  order by s.unique_id, s.system_id, s.created_at
$function$
;

CREATE OR REPLACE FUNCTION public.purge_cluster_service_history(keep_for interval DEFAULT '14 days'::interval)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM cluster_service_history WHERE created_at < NOW() - keep_for;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_history_age_out()
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
declare n bigint;
begin
  delete from public.client_state_history where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_history_thin()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  -- Beyond 24h keep ~hourly (24 newest per module per day). This is exactly the
  -- resolution the R2 export keeps, so thinning never drops anything the
  -- archive would have preserved.
  delete from public.client_state_history h
   using (
     select id, row_number() over (
              partition by unique_id, system_id, date_trunc('day', created_at)
              order by created_at desc) as rn
       from public.client_state_history
      where created_at < now() - interval '24 hours'
   ) r
   where h.id = r.id and r.rn > 24;

  -- Within the last 24h keep the 2000 newest per module: full resolution, bounded.
  delete from public.client_state_history h
   using (
     select id, row_number() over (
              partition by unique_id, system_id order by created_at desc) as rn
       from public.client_state_history
      where created_at >= now() - interval '24 hours'
   ) r
   where h.id = r.id and r.rn > 2000;
end;
$function$
;

CREATE OR REPLACE PROCEDURE public.purge_history_thin_batched(IN batch_size integer DEFAULT 2000, IN pause_s double precision DEFAULT 1.0)
 LANGUAGE plpgsql
AS $procedure$
declare
  n int;
  cutoff timestamptz := now() - interval '24 hours';
begin
  -- Beyond 24h: keep the 24 newest per module per day.
  loop
    delete from public.client_state_history
     where id in (
       select id from (
         select id, row_number() over (
                  partition by unique_id, system_id, date_trunc('day', created_at)
                  order by created_at desc) as rn
           from public.client_state_history
          where created_at < cutoff
       ) r
       where r.rn > 24
       limit batch_size);
    get diagnostics n = row_count;
    commit;
    exit when n = 0;
    perform pg_sleep(pause_s);
  end loop;

  -- Within 24h: keep the 2000 newest per module.
  loop
    delete from public.client_state_history
     where id in (
       select id from (
         select id, row_number() over (
                  partition by unique_id, system_id order by created_at desc) as rn
           from public.client_state_history
          where created_at >= cutoff
       ) r
       where r.rn > 2000
       limit batch_size);
    get diagnostics n = row_count;
    commit;
    exit when n = 0;
    perform pg_sleep(pause_s);
  end loop;
end;
$procedure$
;

CREATE OR REPLACE FUNCTION public.reap_stale_services(alive_within interval DEFAULT '00:15:00'::interval, quiet_for interval DEFAULT '02:00:00'::interval, dry_run boolean DEFAULT true)
 RETURNS TABLE(system_id uuid, system_name text, service_type text, unique_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if dry_run then
        return query
        select cs.system_id, s.name, cs.type, cs.unique_id
        from client_states cs
        join systems s on s.id = cs.system_id
        where s.last_seen > now() - alive_within
          and cs.updated_at < now() - quiet_for
          and cs.archived_module is null;
        return;
    end if;

    return query
    with doomed as (
        select cs.id, cs.system_id, s.name as system_name, cs.type, cs.unique_id
        from client_states cs
        join systems s on s.id = cs.system_id
        where s.last_seen > now() - alive_within   -- the agent is alive
          and cs.updated_at < now() - quiet_for    -- and has stopped reporting this
          and cs.archived_module is null           -- and no module switch stopped it
    ),
    drop_memberships as (
        delete from group_members m
        using doomed d
        where m.service_id = d.id::text
        returning 1
    ),
    drop_services as (
        delete from client_states cs
        using doomed d
        where cs.id = d.id
        returning cs.id
    )
    select d.system_id, d.system_name, d.type, d.unique_id from doomed d;
end;
$function$
;

