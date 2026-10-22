-- DEAFCS: counts only role = 'gpu' accounts, the ones claim_free_steam_account
-- can hand out. Steam Presence 'friends' bots are not part of the GPU pool.
-- (Upstream 5Stack counts every steam_accounts row.)
create or replace view public.v_steam_account_pool_status as
select
  1 as id,
  (select count(*) from steam_accounts where role = 'gpu')::int as total_accounts,
  (select count(*) from steam_accounts
    where role = 'gpu'
      and id not in (select * from busy_steam_account_ids()))::int as free_accounts,
  (select count(*) from busy_steam_account_ids())::int as busy_accounts;
