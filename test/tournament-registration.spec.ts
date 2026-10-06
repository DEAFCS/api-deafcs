import { TournamentsController } from "../src/tournaments/tournaments.controller";
import { TournamentRegistrationService } from "../src/tournaments/tournament-registration.service";
import { TournamentRegistrationController } from "../src/tournaments/tournament-registration.controller";
import { ProcessTournamentCheckIn } from "../src/matches/jobs/ProcessTournamentCheckIn";
import { InvitesController } from "../src/invites/invites.controller";
import { runAsUser } from "./utils/sql-test-db";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, SqlTestDb, seedRegionWithServer } from "./utils/sql-test-db";

// Exercise the real migrated schema, triggers and draft; no mocked packing.
describe("unified tournament registration (DEAFCS)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;
  beforeAll(async () => {
    db = await bootMigratedDb("UnifiedTournamentRegistration");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199969000000n);
    cups = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600000);
  afterAll(async () => { await db?.stop(); });

  async function cup(mode = "Wingman", type = "free_agents", maxTeams = 4) {
    const t = await cups.createTournament([
      {type: "SingleElimination", order: 1, minTeams: 4, maxTeams},
    ], mode, 2);
    await postgres.query("UPDATE tournaments SET registration_type = $2 WHERE id = $1", [t.id, type]);
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  }
  async function signup(tournamentId: string, steamId: string, party?: string) {
    return postgres.query(
      "INSERT INTO tournament_free_agents (tournament_id, player_steam_id, party_id) VALUES ($1, $2, $3) RETURNING id",
      [tournamentId, steamId, party ?? null],
    );
  }
  async function draft(id: string) {
    const [r] = await postgres.query<Array<{count: number}>>(
      "SELECT draft_tournament_free_agent_teams($1) AS count", [id],
    );
    return r.count;
  }
  async function roster(id: string) {
    return postgres.query<Array<{team: string; size: string}>>(
      "SELECT tt.id AS team, count(r.player_steam_id)::text AS size FROM tournament_teams tt LEFT JOIN tournament_team_roster r ON r.tournament_team_id = tt.id WHERE tt.tournament_id = $1 GROUP BY tt.id", [id],
    );
  }
  it("drafts full teams in signup order and waitlists late overflow regardless of ELO", async () => {
    const t = await cup();
    const players = await fx.players(5);
    for (const p of players) await signup(t.id, p);
    expect(await draft(t.id)).toBe(2);
    expect((await roster(t.id)).map(r => Number(r.size))).toEqual([2, 2]);
    const rows = await postgres.query<Array<{player: string; status: string}>>(
      "SELECT player_steam_id::text AS player, status FROM tournament_free_agents WHERE tournament_id = $1 ORDER BY created_at, id", [t.id],
    );
    expect(rows.map(r=>r.status)).toEqual(["drafted", "drafted", "drafted", "drafted", "waitlisted"]);
    expect(rows[4].player).toBe(players[4]);
    expect(await draft(t.id)).toBe(0);
    const [admins] = await postgres.query<Array<{count: string}>>(
      "SELECT count(*)::text FROM tournament_team_roster WHERE tournament_id = $1 AND role = 'Admin'", [t.id],
    );
    expect(Number(admins.count)).toBe(2);
  });
  it("keeps parties on one team and rejects oversized parties", async () => {
    const t = await cup();
    const players = await fx.players(5);
    const party = "11111111-1111-4111-8111-111111111111";
    await signup(t.id, players[0], party);
    await signup(t.id, players[1], party);
    await expect(signup(t.id, players[2], party)).rejects.toThrow(/size of a full team/);
    await signup(t.id, players[2]);
    await signup(t.id, players[3]);
    expect(await draft(t.id)).toBe(2);
    const partyRows = await postgres.query<Array<{team: string}>>(
      "SELECT tournament_team_id AS team FROM tournament_free_agents WHERE tournament_id = $1 AND party_id = $2", [t.id, party],
    );
    expect(new Set(partyRows.map(r=>r.team)).size).toBe(1);
  });
  it("leaves an insufficient pool unchanged rather than burying early registrations", async () => {
    const t = await cup("Competitive");
    for (const p of await fx.players(3)) await signup(t.id, p);
    expect(await draft(t.id)).toBe(0);
    const [r] = await postgres.query<Array<{count: string}>>(
      "SELECT count(*)::text FROM tournament_free_agents WHERE tournament_id = $1 AND status = 'registered'", [t.id],
    );
    expect(Number(r.count)).toBe(3);
  });
  it("uses remaining capacity in Both and avoids duplicate generated team names", async () => {
    const t = await cup("Wingman", "both");
    const premade = await fx.team(1);
    await cups.registerTeam(t.id, premade);
    await postgres.query("UPDATE tournament_teams SET name = 'Team 1' WHERE tournament_id = $1", [t.id]);
    await cups.registerTeam(t.id, await fx.team(1));
    await cups.registerTeam(t.id, await fx.team(1));
    for (const p of await fx.players(3)) await signup(t.id, p);
    expect(await draft(t.id)).toBe(1);
    expect(await roster(t.id)).toHaveLength(4);
    const [r] = await postgres.query<Array<{name: string}>>(
      "SELECT name FROM tournament_teams WHERE tournament_id = $1 AND is_drafted", [t.id],
    );
    expect(r.name).toBe("Team 2");
  });
  it("enforces Verified User and ELO for the target, including an internal draft", async () => {
    const t = await cup();
    const p = await fx.player();
    await postgres.query("UPDATE tournaments SET min_role = 'verified_user' WHERE id = $1", [t.id]);
    await expect(signup(t.id, p)).rejects.toThrow(/entry requirements/);
    await postgres.query("UPDATE players SET role = 'verified_user' WHERE steam_id = $1", [p]);
    await signup(t.id, p);
    await postgres.query("UPDATE tournaments SET min_elo = 6000 WHERE id = $1", [t.id]);
    const other = await fx.player();
    await postgres.query("UPDATE players SET role = 'verified_user' WHERE steam_id = $1", [other]);
    await expect(signup(t.id, other)).rejects.toThrow(/entry requirements/);
    expect(await draft(t.id)).toBe(0);
  });
  it.each(["Competitive", "Wingman", "Duel"])("reads existing %s matchmaking ELO", async (mode) => {
    const t = await cup(mode);
    const p = await fx.player();
    const [r] = await postgres.query<Array<{same: boolean}>>(
      "SELECT get_tournament_player_elo($1, p.steam_id) = get_player_elo_by_type(p, $3) AS same FROM players p WHERE steam_id = $2", [t.id, p, mode],
    );
    expect(r.same).toBe(true);
  });
  it("new Random locks Free Agents and rejects parties and premade teams server-side", async () => {
    const t = await cups.createTournament([{type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4}], "Competitive", 2, true);
    await postgres.query("UPDATE tournaments SET registration_type = 'free_agents', check_in_setting = 'Players' WHERE id = $1", [t.id]);
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    await expect(postgres.query("UPDATE tournaments SET registration_type = 'teams' WHERE id = $1", [t.id])).rejects.toThrow(/Random tournaments/);
    const p = await fx.player();
    await expect(signup(t.id, p, "22222222-2222-4222-8222-222222222222")).rejects.toThrow(/size of a full team/);
    await signup(t.id, p);
    await expect(cups.registerTeam(t.id, await fx.team(4))).rejects.toThrow(/only accepts Free Agents/);
  });
  it("Free Agents have tournament participation before drafting; historical fixtures remain version 1", async () => {
    const t = await cup();
    const p = await fx.player();
    await signup(t.id, p);
    const [r] = await postgres.query<Array<{joined: boolean}>>(
      "SELECT joined_tournament(t, json_build_object('x-hasura-user-id', $2::text)) AS joined FROM tournaments t WHERE id = $1", [t.id, p],
    );
    expect(r.joined).toBe(true);
    const old = await cups.createTournament([]);
    const [v] = await postgres.query<Array<{registration_version: number}>>("SELECT registration_version FROM tournaments WHERE id = $1", [old.id]);
    expect(v.registration_version).toBe(1);
  });

  function registrationService() { return new TournamentRegistrationService(postgres); }
  function registration() {
    return new TournamentRegistrationController({ log: jest.fn() } as any, postgres,
      { notifyPlayers: jest.fn() } as any, {getConnection:()=>({eval:jest.fn().mockResolvedValue(1)})} as any,
      {assertAccepted:jest.fn()} as any, registrationService());
  }
  function user(steam_id: string, role = 'user') { return {steam_id, role, name:'Fixture'} as any; }
  async function openWindow(id: string, mode = 'Captains') {
    await postgres.query("UPDATE tournaments SET check_in_required = true, check_in_setting = $2, start = now() + interval '30 minutes' WHERE id = $1", [id, mode]);
    await postgres.query("UPDATE tournaments SET check_in_ends_at = now() + interval '15 minutes' WHERE id = $1", [id]);
  }
  it.each(['Captains','Players','Admin'])('undrafted Free Agents check themselves in under %s', async mode => {
    const t=await cup(); const p=await fx.player(); await signup(t.id,p); await openWindow(t.id,mode);
    expect(await registrationService().checkIntoTournament({tournament_id:t.id,user:user(p)})).toEqual({success:true});
    const [r]=await postgres.query<Array<{confirmed:boolean}>>("SELECT checked_in_at IS NOT NULL AS confirmed FROM tournament_free_agents WHERE tournament_id=$1 AND player_steam_id=$2",[t.id,p]);
    expect(r.confirmed).toBe(true);
    await expect(postgres.query("UPDATE tournaments SET start=start + interval '1 hour' WHERE id=$1",[t.id])).rejects.toThrow(/check-in/);
  });
  it('late signup confirms automatically, duplicates fail and withdrawal releases participation',async()=>{
    const t=await cup();await openWindow(t.id);const p=await fx.player();await signup(t.id,p);
    await expect(signup(t.id,p)).rejects.toThrow(/duplicate key/);
    const [r]=await postgres.query<Array<{confirmed:boolean}>>("SELECT checked_in_at IS NOT NULL AS confirmed FROM tournament_free_agents WHERE tournament_id=$1",[t.id]);expect(r.confirmed).toBe(true);
    await registration().leaveTournamentAsFreeAgent({tournament_id:t.id,user:user(p)});
    const [joined]=await postgres.query<Array<{joined:boolean}>>("SELECT joined_tournament(t,json_build_object('x-hasura-user-id',$2::text)) AS joined FROM tournaments t WHERE id=$1",[t.id,p]);expect(joined.joined).toBe(false);
  });
  it('a party with an ineligible partner cannot shrink into the draft',async()=>{
    const t=await cup();const ps=await fx.players(4);const party='33333333-3333-4333-8333-333333333333';
    for(let i=0;i<4;i++)await signup(t.id,ps[i],i<2?party:undefined);
    await postgres.query("UPDATE players SET role='verified_user' WHERE steam_id=ANY($1::bigint[])",[ps.slice(1)]);
    await postgres.query("UPDATE tournaments SET min_role='verified_user' WHERE id=$1",[t.id]);
    expect(await draft(t.id)).toBe(1);
    const rows=await postgres.query<Array<{status:string}>>("SELECT status FROM tournament_free_agents WHERE tournament_id=$1 AND party_id=$2",[t.id,party]);expect(rows.map(r=>r.status)).toEqual(['waitlisted','waitlisted']);
  });
  it('4+4+2 does not split into two Competitive teams of five',async()=>{
    const t=await cup('Competitive');const ps=await fx.players(10);
    for(let i=0;i<10;i++)await signup(t.id,ps[i],['44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666'][i<4?0:i<8?1:2]);
    expect(await draft(t.id)).toBe(0);expect(await roster(t.id)).toHaveLength(0);
    const [r]=await postgres.query<Array<{count:string}>>("SELECT count(*)::text FROM tournament_free_agents WHERE tournament_id=$1 AND status='registered'",[t.id]);expect(Number(r.count)).toBe(10);
  });
  it('promotion skips a party that cannot fit and promotes the next solo without splitting',async()=>{
    const t=await cup('Wingman','both');for(let i=0;i<3;i++)await cups.registerTeam(t.id,await fx.team(1));
    const ps=await fx.players(5);const party='77777777-7777-4777-8777-777777777777';
    for(let i=0;i<5;i++)await signup(t.id,ps[i],i===2||i===3?party:undefined);
    expect(await draft(t.id)).toBe(1);
    const [team]=await postgres.query<Array<{id:string}>>("SELECT id FROM tournament_teams WHERE tournament_id=$1 AND is_drafted",[t.id]);
    const [member]=await postgres.query<Array<{steam:string}>>("SELECT player_steam_id::text AS steam FROM tournament_team_roster WHERE tournament_team_id=$1 AND role='Member'",[team.id]);
    await postgres.query("DELETE FROM tournament_team_roster WHERE tournament_team_id=$1 AND player_steam_id=$2",[team.id,member.steam]);
    const [promoted]=await postgres.query<Array<{status:string;team:string}>>("SELECT status,tournament_team_id AS team FROM tournament_free_agents WHERE tournament_id=$1 AND player_steam_id=$2",[t.id,ps[4]]);expect(promoted).toMatchObject({status:'drafted',team:team.id});
    const waiting=await postgres.query<Array<{status:string}>>("SELECT status FROM tournament_free_agents WHERE tournament_id=$1 AND party_id=$2",[t.id,party]);expect(waiting.map(r=>r.status)).toEqual(['waitlisted','waitlisted']);
  });
  it('never auto-fills a premade after a member leaves, including promotion and close-time draft retries',async()=>{
    const t=await cup('Competitive','both');
    await cups.registerTeam(t.id,await fx.team(4));
    const [premade]=await postgres.query<Array<{id:string}>>('SELECT id FROM tournament_teams WHERE tournament_id=$1 AND NOT is_drafted',[t.id]);
    await openWindow(t.id);
    for(const p of await fx.players(6)) await signup(t.id,p);
    expect(await draft(t.id)).toBe(1);
    const [waiting]=await postgres.query<Array<{checked:boolean}>>("SELECT checked_in_at IS NOT NULL AS checked FROM tournament_free_agents WHERE tournament_id=$1 AND status='waitlisted'",[t.id]);
    expect(waiting.checked).toBe(true);
    const [member]=await postgres.query<Array<{steam:string}>>("SELECT player_steam_id::text AS steam FROM tournament_team_roster WHERE tournament_team_id=$1 AND role='Member' LIMIT 1",[premade.id]);
    await postgres.query('DELETE FROM tournament_team_roster WHERE tournament_team_id=$1 AND player_steam_id=$2',[premade.id,member.steam]);
    async function expectUnfilled(){
      const [state]=await postgres.query<Array<{size:string,assigned:string,inserted:string}>>('SELECT (SELECT count(*)::text FROM tournament_team_roster WHERE tournament_team_id=$1) AS size,(SELECT count(*)::text FROM tournament_free_agents WHERE tournament_team_id=$1) AS assigned,(SELECT count(*)::text FROM tournament_team_roster r JOIN tournament_free_agents fa ON fa.tournament_id=r.tournament_id AND fa.player_steam_id=r.player_steam_id WHERE r.tournament_team_id=$1) AS inserted',[premade.id]);
      expect(state).toEqual({size:'4',assigned:'0',inserted:'0'});
    }
    await expectUnfilled(); // Covers the real AFTER DELETE automatic promotion.
    for(const closed of [false,true]){
      if(closed) await postgres.query("UPDATE tournaments SET check_in_ends_at=now()-interval '1 second' WHERE id=$1",[t.id]);
      const [promoted]=await postgres.query<Array<{players:string[]|null}>>('SELECT promote_tournament_free_agent($1,$2) AS players',[t.id,premade.id]);
      expect(promoted.players).toBeNull();
      expect(await draft(t.id)).toBe(0);
      await expectUnfilled();
    }
  });
  it.each([false,true])('generated Competitive teams still draft and promote checked-in agents (Random v2: %s)',async random=>{
    const t=random
      ? await cups.createTournament([{type:'SingleElimination',order:1,minTeams:4,maxTeams:4}],'Competitive',2,true)
      : await cup('Competitive','free_agents');
    if(random) await cups.setStatus(t.id,t.organizer,'RegistrationOpen');
    await openWindow(t.id,'Players');
    for(const p of await fx.players(6)) await signup(t.id,p);
    expect(await draft(t.id)).toBe(1);
    const [team]=await postgres.query<Array<{id:string}>>('SELECT id FROM tournament_teams WHERE tournament_id=$1 AND is_drafted',[t.id]);
    const [waiting]=await postgres.query<Array<{steam:string}>>("SELECT player_steam_id::text AS steam FROM tournament_free_agents WHERE tournament_id=$1 AND status='waitlisted'",[t.id]);
    const [member]=await postgres.query<Array<{steam:string}>>("SELECT player_steam_id::text AS steam FROM tournament_team_roster WHERE tournament_team_id=$1 AND role='Member' LIMIT 1",[team.id]);
    await postgres.query('DELETE FROM tournament_team_roster WHERE tournament_team_id=$1 AND player_steam_id=$2',[team.id,member.steam]);
    const [promoted]=await postgres.query<Array<{status:string,team:string,checked:boolean}>>('SELECT status,tournament_team_id AS team,checked_in_at IS NOT NULL AS checked FROM tournament_free_agents WHERE tournament_id=$1 AND player_steam_id=$2',[t.id,waiting.steam]);
    expect(promoted).toEqual({status:'drafted',team:team.id,checked:true});
    const [state]=await postgres.query<Array<{size:string,checked:boolean}>>('SELECT (SELECT count(*)::text FROM tournament_team_roster WHERE tournament_team_id=tt.id) AS size,tournament_team_checked_in(tt) AS checked FROM tournament_teams tt WHERE tt.id=$1',[team.id]);
    expect(state).toEqual({size:'5',checked:true});
    expect(await draft(t.id)).toBe(0);
  });
  it('concurrent drafts produce each roster once',async()=>{
    const t=await cup();for(const p of await fx.players(8))await signup(t.id,p);
    const results=await Promise.all([draft(t.id),draft(t.id)]);expect(results.sort()).toEqual([0,4]);expect(await roster(t.id)).toHaveLength(4);
  });

  it.each([4,5,6,7])('legacy Competitive captain check-in uses the minimum eligible lineup: %i players', async count => {
    const t=await cups.createTournament([{type:'SingleElimination',order:1,minTeams:4,maxTeams:4}], 'Competitive');
    await postgres.query('UPDATE match_options SET number_of_substitutes=2 WHERE id=(SELECT match_options_id FROM tournaments WHERE id=$1)',[t.id]);
    await cups.setStatus(t.id,t.organizer,'RegistrationOpen');
    await cups.registerTeam(t.id,await fx.team(count-1));
    const [tt]=await postgres.query<Array<{id:string}>>('SELECT id FROM tournament_teams WHERE tournament_id=$1',[t.id]);
    await postgres.query("UPDATE tournaments SET individual_check_in_ends_at=now()+interval '10 minutes' WHERE id=$1",[t.id]);
    const controller=new TournamentsController({log:jest.fn()} as any, {query:async()=>{
      const [team]=await postgres.query("SELECT tt.*,json_build_object('individual_check_in_ends_at',t.individual_check_in_ends_at) AS tournament FROM tournament_teams tt JOIN tournaments t ON t.id=tt.tournament_id WHERE tt.id=$1",[tt.id]);
      return {tournament_teams_by_pk:team};
    }} as any, {} as any, {} as any, {} as any, postgres, {} as any, {} as any, {} as any, {assertAccepted:jest.fn()} as any, registrationService());
    const [captain]=await postgres.query<Array<{steam:string}>>('SELECT captain_steam_id::text AS steam FROM tournament_teams WHERE id=$1',[tt.id]);
    const action=controller.checkInTournamentTeam({tournament_team_id:tt.id,user:user(captain.steam)});
    if(count<5) await expect(action).rejects.toThrow(/minimum eligible lineup/);
    else await expect(action).resolves.toEqual({success:true});
    const [state]=await postgres.query<Array<{checked:boolean}>>('SELECT checked_in_at IS NOT NULL AS checked FROM tournament_teams WHERE id=$1',[tt.id]);
    expect(state.checked).toBe(count>=5);
  });

  it('legacy five-player Competitive registration during check-in auto-confirms with two optional substitutes',async()=>{
    const t=await cups.createTournament([{type:'SingleElimination',order:1,minTeams:4,maxTeams:4}],'Competitive');
    await postgres.query('UPDATE match_options SET number_of_substitutes=2 WHERE id=(SELECT match_options_id FROM tournaments WHERE id=$1)',[t.id]);
    await cups.setStatus(t.id,t.organizer,'RegistrationOpen');
    await postgres.query("UPDATE tournaments SET individual_check_in_ends_at=now()+interval '10 minutes' WHERE id=$1",[t.id]);
    await cups.registerTeam(t.id,await fx.team(4));
    const [state]=await postgres.query<Array<{checked:boolean,filled:boolean,eligible:boolean}>>('SELECT checked_in_at IS NOT NULL AS checked,tournament_team_lineup_filled(tt) AS filled,eligible_at IS NOT NULL AS eligible FROM tournament_teams tt WHERE tournament_id=$1',[t.id]);
    expect(state).toEqual({checked:true,filled:true,eligible:true});
  });

  it.each([4,5,6,7])('Competitive captain check-in with %i of 7 roster slots', async count => {
    const t=await cup('Competitive','teams');
    await postgres.query('UPDATE match_options SET number_of_substitutes=2 WHERE id=(SELECT match_options_id FROM tournaments WHERE id=$1)',[t.id]);
    const team=await fx.team(count-1);
    await cups.registerTeam(t.id,team);
    await openWindow(t.id);
    const [tt]=await postgres.query<Array<{id:string}>>('SELECT id FROM tournament_teams WHERE tournament_id=$1',[t.id]);
    const action=registrationService().checkIntoTournament({tournament_id:t.id,tournament_team_id:tt.id,user:user(team.owner)});
    if(count<5) await expect(action).rejects.toThrow(/minimum eligible lineup/);
    else await expect(action).resolves.toEqual({success:true});
    const [state]=await postgres.query<Array<{checked:boolean,filled:boolean}>>('SELECT checked_in_at IS NOT NULL AS checked,tournament_team_lineup_filled(tt) AS filled FROM tournament_teams tt WHERE id=$1',[tt.id]);
    expect(state.checked).toBe(count>=5);
    expect(state.filled).toBe(count>=5);
  });
  it('five-player Competitive registration during the window auto-confirms and is seedable',async()=>{
    const t=await cup('Competitive','teams');
    await postgres.query('UPDATE match_options SET number_of_substitutes=2 WHERE id=(SELECT match_options_id FROM tournaments WHERE id=$1)',[t.id]);
    await openWindow(t.id);
    await cups.registerTeam(t.id,await fx.team(4));
    const [state]=await postgres.query<Array<{checked:boolean,filled:boolean,eligible:boolean}>>('SELECT checked_in_at IS NOT NULL AS checked,tournament_team_lineup_filled(tt) AS filled,eligible_at IS NOT NULL AS eligible FROM tournament_teams tt WHERE tournament_id=$1',[t.id]);
    expect(state).toEqual({checked:true,filled:true,eligible:true});
  });
  it('does not silently fill a four-player premade with one checked-in Free Agent',async()=>{
    const t=await cup('Competitive','both');
    await cups.registerTeam(t.id,await fx.team(3));
    await openWindow(t.id);
    const player=await fx.player();await signup(t.id,player);
    expect(await draft(t.id)).toBe(0);
    const [state]=await postgres.query<Array<{players:string,assigned:boolean}>>('SELECT (SELECT count(*)::text FROM tournament_team_roster WHERE tournament_id=$1) AS players,(SELECT tournament_team_id IS NOT NULL FROM tournament_free_agents WHERE tournament_id=$1 AND player_steam_id=$2) AS assigned',[t.id,player]);
    expect(state).toEqual({players:'4',assigned:false});
  });
  it('Players check-in needs the starting lineup, not inactive substitutes',async()=>{
    const t=await cup('Wingman','teams');const team=await fx.team(1);await cups.registerTeam(t.id,team);await openWindow(t.id,'Players');
    const [tt]=await postgres.query<Array<{id:string}>>("SELECT id FROM tournament_teams WHERE tournament_id=$1",[t.id]);
    const members=await postgres.query<Array<{steam:string}>>("SELECT player_steam_id::text AS steam FROM tournament_team_roster WHERE tournament_team_id=$1 ORDER BY role",[tt.id]);
    await postgres.query('UPDATE match_options SET number_of_substitutes=1 WHERE id=(SELECT match_options_id FROM tournaments WHERE id=$1)',[t.id]);
    const sub=await fx.player();await runAsUser(postgres,t.organizer,'admin',q=>q("INSERT INTO tournament_team_roster(tournament_id,tournament_team_id,player_steam_id) VALUES($1,$2,$3)",[t.id,tt.id,sub]));
    const c=registrationService();for(const p of members)await c.checkIntoTournament({tournament_id:t.id,tournament_team_id:tt.id,user:user(p.steam)});
    const [r]=await postgres.query<Array<{checked:boolean}>>("SELECT tournament_team_checked_in(tt) AS checked FROM tournament_teams tt WHERE id=$1",[tt.id]);expect(r.checked).toBe(true);
  });
  it('missing teams hold for review, organizer can extend and recipients can confirm',async()=>{
    const t=await cup('Wingman','teams');for(let i=0;i<4;i++)await cups.registerTeam(t.id,await fx.team(1));await openWindow(t.id);
    await postgres.query("UPDATE tournaments SET check_in_ends_at=now()-interval '1 second' WHERE id=$1",[t.id]);
    const job=new ProcessTournamentCheckIn({log:jest.fn()} as any,postgres,{notifyPlayers:jest.fn()} as any);await job.process();
    const [r]=await postgres.query<Array<{status:string}>>("SELECT status FROM tournaments WHERE id=$1",[t.id]);expect(r.status).toBe('CheckInReview');
    await registration().extendTournamentCheckIn({tournament_id:t.id,minutes:5,user:user(t.organizer,'admin')});
    const [open]=await postgres.query<Array<{open:boolean}>>("SELECT tournament_check_in_open(t) AS open FROM tournaments t WHERE id=$1",[t.id]);expect(open.open).toBe(true);
  });
  it('player invites grant only that player and never bypass Verified User',async()=>{
    const t=await cup();const p=await fx.player(),other=await fx.player();await postgres.query("UPDATE tournaments SET invite_only=true,min_role='verified_user' WHERE id=$1",[t.id]);
    const [invite]=await postgres.query<Array<{id:string}>>("INSERT INTO tournament_invites(tournament_id,steam_id,invited_by_player_steam_id) VALUES($1,$2,$3) RETURNING id",[t.id,p,t.organizer]);
    const c=new InvitesController({} as any,{assertAccepted:jest.fn()} as any,postgres,{} as any);
    await expect(c.acceptInvite({invite_id:invite.id,type:'tournament_registration',user:user(other)})).rejects.toThrow(/addressed/);
    await c.acceptInvite({invite_id:invite.id,type:'tournament_registration',user:user(p)});
    await expect(runAsUser(postgres,p,'user',q=>q("INSERT INTO tournament_free_agents(tournament_id,player_steam_id) VALUES($1,$2)",[t.id,p]))).rejects.toThrow(/entry requirements/);
    await postgres.query("UPDATE players SET role='verified_user' WHERE steam_id=$1",[p]);await runAsUser(postgres,p,'user',q=>q("INSERT INTO tournament_free_agents(tournament_id,player_steam_id) VALUES($1,$2)",[t.id,p]));
    await expect(runAsUser(postgres,other,'user',q=>q("INSERT INTO tournament_free_agents(tournament_id,player_steam_id) VALUES($1,$2)",[t.id,other]))).rejects.toThrow(/invite only/);
  });


  it('balances from Wingman ratings even when Competitive rankings disagree',async()=>{
    const t=await cup();const ps=await fx.players(4);const a=await fx.bareMatch(),b=await fx.bareMatch();
    for(let i=0;i<4;i++){
      await postgres.query('INSERT INTO player_elo(steam_id,match_id,type,current,change) VALUES($1,$2,$3,$4,0)',[ps[i],a.matchId,'Wingman',[8000,7000,6000,5000][i]]);
      await postgres.query('INSERT INTO player_elo(steam_id,match_id,type,current,change) VALUES($1,$2,$3,$4,0)',[ps[i],b.matchId,'Competitive',[9000,1000,8000,2000][i]]);await signup(t.id,ps[i]);
    }
    expect(await draft(t.id)).toBe(2);
    const rows=await postgres.query<Array<{total:string}>>("SELECT sum(get_tournament_player_elo($1,r.player_steam_id))::text AS total FROM tournament_team_roster r WHERE r.tournament_id=$1 GROUP BY r.tournament_team_id",[t.id]);
    expect(rows.map(r=>Number(r.total))).toEqual([13000,13000]);
  });
  it.each(['Competitive','Wingman','Duel'])('reads the %s ladder with distinct persisted mode ratings',async mode=>{
    const t=await cup(mode),p=await fx.player();let expected=0;
    for(const [type,value] of [['Competitive',7100],['Wingman',4300],['Duel',8900]] as const){const m=await fx.bareMatch();await postgres.query('INSERT INTO player_elo(steam_id,match_id,type,current,change) VALUES($1,$2,$3,$4,0)',[p,m.matchId,type,value]);if(type===mode)expected=value;}
    const [r]=await postgres.query<Array<{elo:string}>>('SELECT get_tournament_player_elo($1,$2)::text AS elo',[t.id,p]);expect(Number(r.elo)).toBe(expected);
  });

  it('team invites unlock only that premade team, not the captain solo pool',async()=>{
    const t=await cup('Wingman','both');await postgres.query('UPDATE tournaments SET invite_only=true WHERE id=$1',[t.id]);const team=await fx.team(1);
    const [invite]=await postgres.query<Array<{id:string}>>('INSERT INTO tournament_invites(tournament_id,team_id,invited_by_player_steam_id) VALUES($1,$2,$3) RETURNING id',[t.id,team.id,t.organizer]);
    const c=new InvitesController({} as any,{assertAccepted:jest.fn()} as any,postgres,{} as any);await c.acceptInvite({invite_id:invite.id,type:'tournament_registration',user:user(team.owner)});
    const [r]=await postgres.query<Array<{team:boolean;solo:boolean}>>('SELECT tournament_registration_unlocked($1,$2,$3) AS team,tournament_registration_unlocked($1,$2) AS solo',[t.id,team.owner,team.id]);expect(r).toEqual({team:true,solo:false});
    await expect(registration().joinTournamentAsFreeAgent({tournament_id:t.id,user:user(team.owner)})).rejects.toThrow(/invite only/);
    await runAsUser(postgres,team.owner,'user',q=>q('INSERT INTO tournament_teams(tournament_id,team_id,owner_steam_id,name) VALUES($1,$2,$3,$4)',[t.id,team.id,team.owner,'Scoped team']));
  });
  it('invite codes are idempotent under concurrent reuse and honor exhaustion/revocation',async()=>{
    const t=await cup();const c=registration(),p=await fx.player(),other=await fx.player();
    const link=await c.createTournamentInviteCode({tournament_id:t.id,user:user(t.organizer,'admin'),max_uses:1});
    const input={tournament_id:t.id,code:link.code,user:user(p)};await Promise.all([c.redeemTournamentInviteCode(input),c.redeemTournamentInviteCode(input)]);
    const [r]=await postgres.query<Array<{uses:number}>>('SELECT uses FROM tournament_invite_codes WHERE id=$1',[link.id]);expect(r.uses).toBe(1);
    await expect(c.redeemTournamentInviteCode({...input,user:user(other)})).rejects.toThrow('invite_used_up');
    await c.revokeTournamentInviteCode({invite_code_id:link.id,user:user(t.organizer,'admin')});await expect(c.redeemTournamentInviteCode(input)).rejects.toThrow('invite_revoked');
  });
});
