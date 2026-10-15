require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const { Server } = require('socket.io');

const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.BIND_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tournament.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const CAPTAINS_FILE = path.join(DATA_DIR, 'captains.json');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const RESET_PASSWORD_FILE = path.join(DATA_DIR, 'reset-password.json');
const RESET_PASSWORD_MIN = 8;
const RESET_PASSWORD_MAX = 128;
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'bgmi_broadcast';
fs.mkdirSync(DATA_DIR, { recursive: true });

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
  return secret;
}
const sessionStore = MONGODB_URI ? MongoStore.create({ mongoUrl: MONGODB_URI, dbName: MONGODB_DB, collectionName: 'bgmi_sessions', ttl: 60 * 60 * 12, autoRemove: 'native' }) : undefined;
const sessionMiddleware = session({ name: 'bgmi.sid', secret: sessionSecret(), resave: false, saveUninitialized: false, rolling: true, store: sessionStore, cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 12 * 60 * 60 * 1000 } });

// ---------------------------------------------------------------------------
// DEVELOPMENT LOGIN BYPASS
// Start the server with DEV_BYPASS_LOGIN=true (`npm run dev:open`) to walk
// straight into the operator dashboard without an administrator sign-in.
// Every browser gets an in-memory "dev-operator" admin session, so the REST
// routes and the operator socket work exactly as they do after a real login.
// It is OFF by default and must never be enabled on a public broadcast server.
// ---------------------------------------------------------------------------
const DEV_BYPASS_LOGIN = ['1', 'true', 'on', 'yes', 'enabled'].includes(String(process.env.DEV_BYPASS_LOGIN || '').trim().toLowerCase());
const DEV_BYPASS_USER = { username: 'dev-operator', role: 'admin', accountId: null, email: null, phone: null, captainName: null };
function developmentLoginBypass(req, _res, next) {
  if (DEV_BYPASS_LOGIN && req.session && !isAdminUser(req.session.user)) req.session.user = { ...DEV_BYPASS_USER };
  next();
}

const BROADCAST_STATES = ['pre-show', 'stream-start', 'countdown', 'caster', 'format', 'lineup', 'live', 'chicken-dinner', 'frag-leaders', 'results', 'overall', 'mvp', 'map-feed', 'intermission', 'technical-difficulties', 'hidden'];
const PLAYER_STATUSES = ['alive', 'knocked', 'eliminated'];
const MATCH_STATUSES = ['upcoming', 'live', 'awaiting-verification', 'verified'];
const DEFAULT_PLACEMENT_POINTS = { 1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1 };
const GROUPS = ['A', 'B', 'C', 'D', 'E', 'F'];

function cleanHttpUrl(value) {
  const raw = String(value || '').trim(); if (!raw) return ''; if (raw.length > 500) return '';
  try { const parsed = new URL(raw); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''; } catch { return ''; }
}
function cleanMediaUrl(value) { const raw=String(value||'').trim(); if(!raw)return ''; if(raw.length>500)return ''; if(raw.startsWith('/assets/')&&!raw.startsWith('//')&&!raw.includes('..'))return raw; return cleanHttpUrl(raw); }
function makeTeam(id, total = 96) {
  return { id, name: `TEAM ${String(id).padStart(2, '0')}`, group: total <= 16 ? 'A' : GROUPS[Math.floor((id - 1) / Math.max(1, Math.ceil(total / 6))) % 6], logo: '', college: '', substitute: '', registered: false, registrationId: null, players: [1,2,3,4].map(n => ({ name: `PLAYER ${n}`, uid: '', status: 'alive', kills: 0, damage: 0, avatarUrl: '', autoEliminated: false })), kills: 0, placement: 0, placementAuto: true, eliminatedAt: null, matchPoints: 0, overallPoints: 0, overallKills: 0, overallMatches: 0 };
}
function makeDefaultData() {
  return {
    schemaVersion: 9, tournamentName: 'BGMI COLLEGE CHAMPIONSHIP', organizer: 'ESPORTS OPERATIONS', format: '96 TEAM SERIES', currentMatch: 1,
    currentGroup: 'A', currentMap: 'Erangel', matchStatus: 'upcoming', broadcastState: 'pre-show', matchTeamIds: Array.from({length:16},(_,i)=>i+1),
    registrationSettings: { open: true, maxTeams: 96 }, registrations: [],
    production: { countdownEndsAt: null, countdownDuration: 30, streamStartEndsAt: null, streamStartDurationSeconds: 1200, eventLogoUrl: '', themeMusicUrl: '', broadcastStageLabel: 'GROUP STAGE', broadcastDayLabel: 'DAY 1', broadcastGroupLabel: '', broadcastMatchCaption: '', caster: { name: 'MAIN CASTER', tagline: 'THE BATTLE STARTS NOW', imageUrl: '' }, mapFeed: { imageUrl: '', visible: true }, mvpMode: 'match' },
    qualification: { semifinalSlots: 24, finalSlots: 16 }, scoringRules: { finishPoint: 1, placementPoints: DEFAULT_PLACEMENT_POINTS }, autoPlacements: true, placementSequence: 0,
    matchHistory: [], auditLog: [], eventLog: [], teams: Array.from({length:96}, (_,i)=>makeTeam(i+1,96))
  };
}
function normalizeData(old) {
  const base = makeDefaultData();
  const data = { ...base, ...(old || {}) };
  data.schemaVersion = 9;
  data.registrationSettings = { open: true, maxTeams: 96, ...((old && old.registrationSettings) || {}) };
  data.registrationSettings.maxTeams = Math.max(16, Math.min(96, Number(data.registrationSettings.maxTeams) || 96));
  data.registrationSettings.open = data.registrationSettings.open !== false;
  data.registrations = Array.isArray(old && old.registrations) ? old.registrations.map(r => ({ id:String(r.id||crypto.randomUUID()), accountId:String(r.accountId||''), teamName:String(r.teamName||'').slice(0,48), college:String(r.college||'').slice(0,100), captainName:String(r.captainName||'').slice(0,60), email:String(r.email||'').slice(0,120), phone:String(r.phone||'').replace(/\D/g,'').slice(0,15), teamLogoUrl:cleanHttpUrl(r.teamLogoUrl), playerNames:Array.isArray(r.playerNames)?r.playerNames.slice(0,4).map(n=>String(n||'').slice(0,48)):[], playerUids:Array.isArray(r.playerUids)?r.playerUids.slice(0,4).map(v=>String(v||'').replace(/\D/g,'').slice(0,15)):[], playerAvatarUrls:Array.isArray(r.playerAvatarUrls)?r.playerAvatarUrls.slice(0,4).map(cleanHttpUrl):[], substitute:String(r.substitute||'').slice(0,48), submittedAt:r.submittedAt||new Date().toISOString(), status:['pending','approved','rejected','waitlisted'].includes(r.status)?r.status:'pending', groupPreference:String(r.groupPreference||'').slice(0,8), assignedTeamId:Number(r.assignedTeamId)||null, assignedGroup:String(r.assignedGroup||'').slice(0,16), reviewedAt:r.reviewedAt||null, reviewedBy:String(r.reviewedBy||'').slice(0,32), reason:String(r.reason||'').slice(0,300) })) : [];
  data.matchTeamIds = Array.isArray(old && old.matchTeamIds) ? [...new Set(old.matchTeamIds.map(Number).filter(n=>Number.isInteger(n)&&n>0&&n<=96))] : [];
  data.autoPlacements = !(old && old.autoPlacements === false);
  data.placementSequence = Math.max(0, Math.floor(Number(old && old.placementSequence) || 0));
  data.qualification = { ...base.qualification, ...((old && old.qualification) || {}) };
  data.scoringRules = { ...base.scoringRules, ...((old && old.scoringRules) || {}) };
  data.matchHistory = Array.isArray(old && old.matchHistory) ? old.matchHistory : [];
  data.auditLog = Array.isArray(old && old.auditLog) ? old.auditLog : [];
  data.eventLog = Array.isArray(old && old.eventLog) ? old.eventLog : [];
  const prod = (old && old.production) || {};
  data.production = { countdownEndsAt: Number(prod.countdownEndsAt) || null, countdownDuration: Math.max(5, Math.min(180, Number(prod.countdownDuration) || 30)), streamStartEndsAt: Number(prod.streamStartEndsAt) || null, streamStartDurationSeconds: Math.max(60, Math.min(10800, Number(prod.streamStartDurationSeconds) || 1200)), eventLogoUrl: cleanHttpUrl(prod.eventLogoUrl), themeMusicUrl: cleanMediaUrl(prod.themeMusicUrl), broadcastStageLabel: String(prod.broadcastStageLabel||'GROUP STAGE').slice(0,50), broadcastDayLabel: String(prod.broadcastDayLabel||'DAY 1').slice(0,30), broadcastGroupLabel: String(prod.broadcastGroupLabel||'').slice(0,40), broadcastMatchCaption: String(prod.broadcastMatchCaption||'').slice(0,60), caster: { name: String(prod.caster?.name || 'MAIN CASTER').slice(0,60), tagline: String(prod.caster?.tagline || 'THE BATTLE STARTS NOW').slice(0,100), imageUrl: cleanHttpUrl(prod.caster?.imageUrl) }, mapFeed: { imageUrl: cleanHttpUrl(prod.mapFeed?.imageUrl), visible: prod.mapFeed?.visible !== false }, mvpMode: prod.mvpMode === 'overall' ? 'overall' : 'match', mvpSelection: prod.mvpSelection && Number.isInteger(Number(prod.mvpSelection.teamId)) && Number.isInteger(Number(prod.mvpSelection.playerIndex)) ? {teamId:Number(prod.mvpSelection.teamId),playerIndex:Number(prod.mvpSelection.playerIndex)} : null };
  data.broadcastState = BROADCAST_STATES.includes(old && old.broadcastState) ? old.broadcastState : 'pre-show';
  data.matchStatus = MATCH_STATUSES.includes(old && old.matchStatus) ? old.matchStatus : 'upcoming';
  data.currentMatch = Math.max(1, Math.floor(Number(old && old.currentMatch) || 1));
  data.currentGroup = String((old && old.currentGroup) || 'A').slice(0, 16);
  data.currentMap = String((old && old.currentMap) || 'Erangel').slice(0, 40);
  const oldTeams = Array.isArray(old && old.teams) ? old.teams : [];
  const byId = new Map(oldTeams.map((t, i) => [Number(t.id) || i + 1, t]));
  const count = Math.max(16, Math.min(96, oldTeams.length || 96));
  data.teams = Array.from({ length: count }, (_, i) => {
    const id = i + 1, source = byId.get(id) || {}, defaults = makeTeam(id, count);
    return { ...defaults, ...source, id, placementAuto: source.placementAuto !== false, eliminatedAt: Number(source.eliminatedAt) > 0 ? Math.floor(Number(source.eliminatedAt)) : null, name: String(source.name || defaults.name).slice(0, 48), group: String(source.group || defaults.group).slice(0, 16), logo: cleanHttpUrl(source.logo), college: String(source.college || '').slice(0,100), substitute: String(source.substitute || '').slice(0,48), registered: Boolean(source.registered) || Boolean(source.registrationId), registrationId: source.registrationId ? String(source.registrationId).slice(0,80) : null,
      kills: Math.max(0, Math.floor(Number(source.kills) || 0)), placement: Math.max(0, Math.min(count, Math.floor(Number(source.placement) || 0))),
      players: Array.from({ length: 4 }, (_, pi) => ({ name: String((source.players && source.players[pi] && source.players[pi].name) || `PLAYER ${pi + 1}`).slice(0, 32), uid: String((source.players && source.players[pi] && source.players[pi].uid) || '').replace(/\D/g,'').slice(0,15), status: PLAYER_STATUSES.includes(source.players && source.players[pi] && source.players[pi].status) ? source.players[pi].status : 'alive', autoEliminated: Boolean(source.players && source.players[pi] && source.players[pi].autoEliminated), kills: Math.max(0, Math.floor(Number(source.players && source.players[pi] && source.players[pi].kills) || 0)), damage: Math.max(0, Math.min(50000, Math.floor(Number(source.players && source.players[pi] && source.players[pi].damage) || 0))), avatarUrl: cleanHttpUrl(source.players && source.players[pi] && source.players[pi].avatarUrl) })) };
  });
  if (!data.matchTeamIds.length) data.matchTeamIds = data.teams.filter(t => t.group === (GROUPS.includes(data.currentGroup) ? data.currentGroup : 'A')).slice(0,16).map(t=>t.id);
  data.matchTeamIds = data.matchTeamIds.filter(id=>data.teams.some(t=>t.id===id)).slice(0,16);
  if (data.matchTeamIds.length < 2) data.matchTeamIds = data.teams.filter(t=>t.group==='A').slice(0,16).map(t=>t.id);
  recalculate(data);
  return data;
}
function loadData() {
  const base = makeDefaultData();
  if (!fs.existsSync(DATA_FILE)) { fs.writeFileSync(DATA_FILE, JSON.stringify(base, null, 2)); return base; }
  try { return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch (e) { console.error('Tournament data could not be loaded:', e.message); return base; }
}
function placementPoints(position, data=tournament) { return Number(data.scoringRules.placementPoints[String(Number(position))]) || 0; }
// ---------------------------------------------------------------------------
// PLACEMENT AUTOMATION
// A squad owns a placement the moment its fourth player is eliminated: the
// first squad wiped from a 16-squad lobby is 16th, the next one is 15th and so
// on, so positions 9-16 fall out of the scoring table as zero placement points
// without any typing. Operators can still type an exact placement for
// re-verification, which pins that squad to manual mode until it is reset.
// ---------------------------------------------------------------------------
function activeMatchTeamList(data=tournament) { const ids = Array.isArray(data.matchTeamIds) && data.matchTeamIds.length ? data.matchTeamIds : data.teams.filter(t=>t.group===data.currentGroup).slice(0,16).map(t=>t.id); return data.teams.filter(t=>ids.includes(t.id)); }
/* A squad with no living member is finished: knocked players bleed out because
   nobody is left to revive them. Returns the number of players cascaded into
   elimination, or -1 when the wipe was undone by a revive. */
function applySquadWipe(team) {
  const players = team.players || [];
  if (!players.length) return 0;
  const alive = players.filter(p => p.status === 'alive').length;
  if (alive > 0) {
    // Revived: undo only the players this rule had eliminated by itself.
    let undone = 0;
    for (const p of players) if (p.autoEliminated) { p.status = 'knocked'; p.autoEliminated = false; undone += 1; }
    return undone ? -1 : 0;
  }
  let cascaded = 0;
  for (const p of players) if (p.status === 'knocked' || p.status === 'alive') { p.status = 'eliminated'; p.autoEliminated = true; cascaded += 1; }
  return cascaded;
}
function squadWiped(team) { const players = team.players || []; return players.length > 0 && players.every(p => p.status === 'eliminated'); }
/* Assigns placements as a permutation of 1..lobbySize, so two squads can never
   share a position (or its points). Squads the operator typed in keep their
   position; automatic squads fill the positions that are left, deepest first,
   in elimination order. */
function syncAutoPlacements(data=tournament) {
  if (data.autoPlacements === false) return;
  const active = activeMatchTeamList(data);
  if (!active.length) return;
  const total = active.length;
  let sequence = Math.max(0, Math.floor(Number(data.placementSequence) || 0));
  const automatic = active.filter(t => t.placementAuto !== false);
  for (const team of automatic) {
    if (!squadWiped(team)) { team.eliminatedAt = null; continue; }
    if (!(Number(team.eliminatedAt) > 0)) { sequence += 1; team.eliminatedAt = sequence; }
  }
  data.placementSequence = sequence;

  // 1. Positions the operator owns. Manual squads are never moved.
  const taken = new Set();
  for (const team of active) {
    if (team.placementAuto === false && Number(team.placement) >= 1 && Number(team.placement) <= total) taken.add(Number(team.placement));
    else if (team.placementAuto === false) team.placement = 0;
  }

  // 2. Free positions left for the automatic squads.
  const free = [];
  for (let position = total; position >= 1; position -= 1) if (!taken.has(position)) free.push(position);

  // 3. Earliest eliminated squad takes the deepest free position.
  for (const team of automatic) team.placement = 0;
  const wiped = automatic.filter(t => Number(t.eliminatedAt) > 0).sort((a,b) => a.eliminatedAt - b.eliminatedAt);
  wiped.forEach(team => { if (free.length) team.placement = free.shift(); });

  // 4. A lone survivor is the chicken dinner, so it takes the best position
  //    still free (free is ordered deepest-first, so the best one is last).
  const stillPlaying = automatic.filter(t => !squadWiped(t));
  if (stillPlaying.length === 1 && free.length) stillPlaying[0].placement = free[free.length - 1];
}
function resetAutoPlacements(data=tournament) { data.placementSequence = 0; data.teams.forEach(t => { t.placementAuto = true; t.eliminatedAt = null; }); }
// ---------------------------------------------------------------------------
// MASTER RESET
// The competition scope wipes every number the event has produced — live match
// inputs, live standings, overall standings, finalized match history, MVP and
// top-fragger records — and returns the controls to Match 1 / pre-show. The
// registration desk, approved rosters, group allocation, scoring rules and
// production identity are deliberately preserved: team registrations are not
// competition results and must survive a rehearsal reset.
// ---------------------------------------------------------------------------
function clearCompetitionData(data = tournament) {
  data.matchHistory = [];
  data.eventLog = [];
  data.placementSequence = 0;
  data.autoPlacements = true;
  data.currentMatch = 1;
  data.matchStatus = 'upcoming';
  data.broadcastState = 'pre-show';
  data.production.countdownEndsAt = null;
  data.production.streamStartEndsAt = null;
  data.production.mvpSelection = null;
  data.production.mvpMode = 'match';
  for (const team of data.teams) {
    team.kills = 0;
    team.placement = 0;
    team.placementAuto = true;
    team.eliminatedAt = null;
    team.matchPoints = 0;
    team.overallPoints = 0;
    team.overallKills = 0;
    team.overallMatches = 0;
    team.players = (team.players || []).map(player => ({ ...player, status: 'alive', kills: 0, damage: 0, autoEliminated: false }));
  }
  // Keep the lineup on the squads that are actually registered, so the next
  // rehearsal starts from the approved roster instead of placeholder slots.
  const groupLineup = data.teams.filter(t => t.registered && t.group === data.currentGroup).slice(0, 16).map(t => t.id);
  const registeredLineup = data.teams.filter(t => t.registered).slice(0, 16).map(t => t.id);
  const lineup = groupLineup.length >= 2 ? groupLineup : registeredLineup;
  if (lineup.length >= 2) data.matchTeamIds = lineup;
  else if (!Array.isArray(data.matchTeamIds) || data.matchTeamIds.length < 2) data.matchTeamIds = data.teams.filter(t => t.group === data.currentGroup).slice(0, 16).map(t => t.id);
  recalculate(data);
  return data;
}
function factoryResetData() {
  const fresh = makeDefaultData();
  fresh.tournamentName = tournament.tournamentName;
  fresh.organizer = tournament.organizer;
  fresh.format = tournament.format;
  return fresh;
}
function recalculate(data=tournament) {
  syncAutoPlacements(data);
  const totals=new Map();
  for(const match of data.matchHistory||[]) for(const r of match.results||[]) {
    const id=Number(r.teamId), t=totals.get(id)||{points:0,kills:0,matches:0};
    t.points+=Number(r.matchPoints)||0; t.kills+=Number(r.kills)||0; t.matches++; totals.set(id,t);
  }
  for(const team of data.teams) {
    team.kills=Math.max(0,Math.floor(Number(team.kills)||0));
    team.placement=Math.max(0,Math.floor(Number(team.placement)||0));
    team.matchPoints=team.kills*Math.max(0,Number(data.scoringRules.finishPoint)||0)+placementPoints(team.placement,data);
    const t=totals.get(Number(team.id))||{points:0,kills:0,matches:0}; team.overallPoints=t.points; team.overallKills=t.kills; team.overallMatches=t.matches;
  }
}
let mongoClient = null;
let mongoCollection = null;
let mongoWriteChain = Promise.resolve();
let storageMode = 'Local JSON';
function save() {
  recalculate();
  const snapshot = JSON.parse(JSON.stringify(tournament));
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(temp, DATA_FILE);
  if (mongoCollection) {
    mongoWriteChain = mongoWriteChain.then(() => mongoCollection.replaceOne({ _id: 'active' }, { ...snapshot, _id: 'active' }, { upsert: true }))
      .catch(err => { console.error('MongoDB mirror write failed; local recovery snapshot is still saved:', err.message); });
  }
}
function stripUidRows(rows){return (rows||[]).map(({uid,...publicRow})=>publicRow);}
function displayPlayerStats(){const stats=playerStats();return {...stats,currentLeaders:stripUidRows(stats.currentLeaders),overallLeaders:stripUidRows(stats.overallLeaders),matchMvp:stats.matchMvp?(({uid,...r})=>r)(stats.matchMvp):null,overallTopFragger:stats.overallTopFragger?(({uid,...r})=>r)(stats.overallTopFragger):null};}
function operatorState(){const {auditLog,registrations,...safeState}=tournament;return {...safeState,autoPlacements:tournament.autoPlacements!==false,placementSequence:tournament.placementSequence||0,playerStats:playerStats(),registrationCount:(tournament.registrations||[]).filter(r=>r.status==='approved').length,pendingRegistrationCount:(tournament.registrations||[]).filter(r=>r.status==='pending').length,reservedRegistrationCount:(tournament.registrations||[]).filter(r=>['approved','pending','waitlisted'].includes(r.status)).length};}
function publicState(){const {auditLog,registrations,...safeState}=tournament;const state=JSON.parse(JSON.stringify(safeState));state.teams=(state.teams||[]).map(({registrationId,college,substitute,...team})=>({...team,players:(team.players||[]).map(({uid,...p})=>p)}));state.matchHistory=(state.matchHistory||[]).map(match=>({...match,results:(match.results||[]).map(result=>({...result,players:(result.players||[]).map(({uid,...p})=>p)}))}));return {...state,playerStats:displayPlayerStats(),registrationCount:(tournament.registrations||[]).filter(r=>r.status==='approved').length,pendingRegistrationCount:(tournament.registrations||[]).filter(r=>r.status==='pending').length,reservedRegistrationCount:(tournament.registrations||[]).filter(r=>['approved','pending','waitlisted'].includes(r.status)).length};}
function spectatorState() {
  const history=Array.isArray(tournament.matchHistory)?tournament.matchHistory:[];
  const finishPoint=Math.max(0,Number(tournament.scoringRules?.finishPoint)||1);
  const teams=tournament.teams.map(team=>{
    const records=history.flatMap(m=>(m.results||[]).map(r=>({...r,matchNumber:m.matchNumber,matchGroup:m.group}))).filter(r=>Number(r.teamId)===Number(team.id));
    const positionPoints=records.reduce((sum,r)=>sum+Math.max(0,Number(r.placementPoints!==undefined&&r.placementPoints!==null?r.placementPoints:(Number(r.matchPoints)||0)-(Number(r.kills)||0)*finishPoint)||0),0);
    return {id:team.id,name:team.name,group:team.group,logo:team.logo||'',registered:Boolean(team.registered),college:team.college||'',kills:Number(team.kills)||0,placement:Number(team.placement)||0,matchPoints:Number(team.matchPoints)||0,overallPoints:Number(team.overallPoints)||0,overallFinishes:Number(team.overallKills)||records.reduce((a,r)=>a+(Number(r.kills)||0),0),overallMatches:Number(team.overallMatches)||records.length,overallWins:records.filter(r=>Number(r.placement)===1).length,overallPlacementPoints:positionPoints,players:(team.players||[]).map(p=>({name:p.name||'',status:p.status||'alive',kills:Number(p.kills)||0,damage:Number(p.damage)||0,avatarUrl:p.avatarUrl||''}))};
  });
  const activeIds=new Set(Array.isArray(tournament.matchTeamIds)?tournament.matchTeamIds:[]);
  const currentTeams=teams.filter(t=>activeIds.size?activeIds.has(t.id):t.group===tournament.currentGroup).map(t=>({id:t.id,name:t.name,group:t.group,logo:t.logo,kills:t.kills,placement:t.placement,matchPoints:t.matchPoints,statusCounts:{alive:t.players.filter(p=>p.status==='alive').length,knocked:t.players.filter(p=>p.status==='knocked').length,eliminated:t.players.filter(p=>p.status==='eliminated').length}})).sort((a,b)=>b.matchPoints-a.matchPoints||b.kills-a.kills||(a.placement||999)-(b.placement||999));
  const leaders=playerStats().overallLeaders.slice(0,20).map(p=>({playerName:p.playerName,teamId:p.teamId,teamName:p.teamName,teamLogo:p.teamLogo||'',avatarUrl:p.avatarUrl||'',kills:Number(p.kills)||0,damage:Number(p.damage)||0,matches:Number(p.matches)||0,group:p.group||''}));
  const recentMatches=history.slice(-12).reverse().map(m=>({matchNumber:m.matchNumber,group:m.group||'',map:m.map||'',finalizedAt:m.finalizedAt||'',results:(m.results||[]).map(r=>({teamId:r.teamId,teamName:r.teamName,group:r.group||'',teamLogo:r.teamLogo||'',kills:Number(r.kills)||0,placement:Number(r.placement)||0,matchPoints:Number(r.matchPoints)||0,players:(r.players||[]).map(p=>({name:p.name||'',kills:Number(p.kills)||0,damage:Number(p.damage)||0,avatarUrl:p.avatarUrl||''}))})).sort((a,b)=>(a.placement||999)-(b.placement||999)||b.matchPoints-a.matchPoints)}));
  const publicTeams=teams.map(({players,college,...team})=>team);
  return {tournamentName:tournament.tournamentName,organizer:tournament.organizer,format:tournament.format,currentMatch:tournament.currentMatch,currentGroup:tournament.currentGroup,currentMap:tournament.currentMap,matchStatus:tournament.matchStatus,broadcastState:tournament.broadcastState,registrationOpen:Boolean(tournament.registrationSettings?.open),teams:publicTeams,currentTeams,overallFraggers:leaders,recentMatches,completedMatches:history.length,updatedAt:new Date().toISOString()};
}
function playerStats(data=tournament) {
  const currentIds = new Set(data.matchTeamIds || []);
  const currentLeaders = data.teams.filter(t=>currentIds.has(t.id)).flatMap(t=>t.players.map((p,i)=>({teamId:t.id,teamName:t.name,teamLogo:t.logo||'',playerIndex:i,playerName:p.name,uid:String(p.uid||'').replace(/\D/g,''),avatarUrl:p.avatarUrl||'',kills:Number(p.kills)||0,damage:Number(p.damage)||0,group:t.group||'A'}))).sort((a,b)=>b.kills-a.kills||a.playerName.localeCompare(b.playerName));
  // Aggregate player records by team ID + normalized player name, not by roster slot.
  // This avoids combining different players who happen to occupy the same index in later matches.
  const overall = new Map();
  const playerKey = (teamId, name, uid='') => { const cleanUid=String(uid||'').replace(/\D/g,''); return cleanUid ? `uid:${cleanUid}` : `team:${Number(teamId)}:${String(name || '').trim().toLocaleLowerCase()}`; };
  for(const match of data.matchHistory||[]) for(const result of match.results||[]) (result.players||[]).forEach((p,i)=>{
    const name=String(p.name||`PLAYER ${i+1}`).trim()||`PLAYER ${i+1}`;
    const uid=String(p.uid||'').replace(/\D/g,''); const key=playerKey(result.teamId,name,uid), row=overall.get(key)||{teamId:Number(result.teamId),teamName:result.teamName||'',teamLogo:result.teamLogo||'',playerIndex:i,playerName:name,uid,avatarUrl:p.avatarUrl||'',kills:0,damage:0,matches:0};
    row.kills+=Number(p.kills)||0; row.damage+=Number(p.damage)||0; row.matches+=1; row.teamName=result.teamName||row.teamName; row.teamLogo=result.teamLogo||row.teamLogo; row.playerName=name; row.avatarUrl=p.avatarUrl||row.avatarUrl; overall.set(key,row);
  });
  if(data.matchStatus!=='verified') for(const row of currentLeaders) { const key=playerKey(row.teamId,row.playerName,row.uid), dest=overall.get(key)||{...row,matches:0,kills:0}; dest.kills+=Number(row.kills)||0; dest.damage+=Number(row.damage)||0; dest.matches=Math.max(1,Number(dest.matches)||0); dest.teamId=row.teamId; dest.teamName=row.teamName; dest.teamLogo=row.teamLogo; dest.playerName=row.playerName; dest.avatarUrl=row.avatarUrl||dest.avatarUrl; dest.playerIndex=row.playerIndex; overall.set(key,dest); }
  const overallLeaders=[...overall.values()].sort((a,b)=>b.kills-a.kills||a.playerName.localeCompare(b.playerName));
  const findSelected=()=>{const sel=data.production?.mvpSelection;if(!sel)return null;return currentLeaders.find(p=>p.teamId===sel.teamId&&p.playerIndex===sel.playerIndex)||null};
  const selected=findSelected(); const bestCurrent=currentLeaders[0]||null; const bestOverall=overallLeaders[0]||null; return { currentLeaders, overallLeaders, matchMvp: selected && selected.kills>0 ? selected : (bestCurrent && bestCurrent.kills>0 ? bestCurrent : null), overallTopFragger: bestOverall && bestOverall.kills>0 ? bestOverall : null };
}
function activeMatchTeams(data=tournament) { const ids = Array.isArray(data.matchTeamIds) && data.matchTeamIds.length ? data.matchTeamIds : data.teams.filter(t=>t.group===data.currentGroup).slice(0,16).map(t=>t.id); return data.teams.filter(t=>ids.includes(t.id)); }
function emitRegistrations() { const records = [...(tournament.registrations||[])].sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)); for (const s of io.sockets.sockets.values()) if (isOperator(s)) s.emit('registrations:update', records); }
function emitState(){ for(const client of io.sockets.sockets.values()){if(isOperator(client))client.emit('tournament:update',operatorState());else if(client.data.clientRole==='overlay')client.emit('tournament:update',publicState());} io.to('spectators').emit('spectator:update', spectatorState()); }
function findTeam(id){ return tournament.teams.find(t=>t.id===Number(id)); }
function audit(action,details={}) { tournament.auditLog.push({id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,at:new Date().toISOString(),action,...details}); if(tournament.auditLog.length>1500)tournament.auditLog=tournament.auditLog.slice(-1500); }
function logEvent(type,teamId,description,delta=0) { tournament.eventLog.unshift({id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,at:new Date().toISOString(),matchNumber:tournament.currentMatch,group:tournament.currentGroup,type,teamId:teamId||null,description,delta}); tournament.eventLog=tournament.eventLog.slice(0,250); }
function commit(action,details={}){ audit(action,details); save(); emitState(); }
function error(socket,msg){ socket.emit('operator:error',msg); }
function isAdminUser(user) { return Boolean(user && user.role === 'admin'); }
function isOperator(socket) { return Boolean(socket.request && socket.request.session && isAdminUser(socket.request.session.user)); }
function requireOperatorSocket(socket) { if (isOperator(socket)) return true; error(socket, 'Authorized operator login required. Please sign in again.'); return false; }
let tournament = loadData();
let countdownTimer = null;
let streamStartTimer = null;
if(tournament.broadcastState==='stream-start'&&tournament.production.streamStartEndsAt){const delay=Math.max(0,tournament.production.streamStartEndsAt-Date.now());streamStartTimer=setTimeout(()=>{if(tournament.broadcastState==='stream-start'){tournament.production.streamStartEndsAt=null;tournament.broadcastState='caster';commit('broadcast:stream-start-complete');}},delay+30);}
if(tournament.broadcastState==='countdown'&&tournament.production.countdownEndsAt){const delay=Math.max(0,tournament.production.countdownEndsAt-Date.now());countdownTimer=setTimeout(()=>{if(tournament.broadcastState==='countdown'){tournament.production.countdownEndsAt=null;tournament.broadcastState='live';tournament.matchStatus='live';commit('broadcast:countdown-complete');}},delay+30);}
let authAttempts = new Map();
const authLimiter = (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const record = authAttempts.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  if (Date.now() > record.until) { record.count = 0; record.until = Date.now() + 15 * 60 * 1000; }
  if (record.count >= 10) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  req.authAttemptKey = key; req.authAttemptRecord = record; next();
};
function sameOrigin(req, res, next) {
  // Browsers set Sec-Fetch-Site themselves and page scripts cannot forge it, so
  // it stays reliable when a reverse proxy or preview tunnel rewrites Host.
  if (req.get('sec-fetch-site') === 'same-origin') return next();
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'A same-origin browser request is required.' });
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  try {
    const host = new URL(origin).host;
    if (host === req.get('host') || (forwardedHost && host === forwardedHost)) return next();
  } catch {}
  return res.status(403).json({ error: 'Request origin rejected.' });
}
function requireAuth(req, res, next) {
  if (req.session && isAdminUser(req.session.user)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
  return res.redirect('/login');
}
async function readAdmin() { try { return JSON.parse(await fs.promises.readFile(ADMIN_FILE, 'utf8')); } catch { return null; } }
// ---------------------------------------------------------------------------
// RESET PROTECTION PASSWORD
// A destructive "reset the whole event" action must not be one stray click
// away, so it is unlocked by a special password that the administrator sets
// separately from the login password. Only the bcrypt hash is stored, in its
// own 0600 file next to the other private credentials.
// ---------------------------------------------------------------------------
function readResetPasswordRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(RESET_PASSWORD_FILE, 'utf8'));
    if (record && typeof record.passwordHash === 'string' && record.passwordHash) return record;
  } catch {}
  return null;
}
function writeResetPasswordRecord(record) {
  const temp = `${RESET_PASSWORD_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(temp, RESET_PASSWORD_FILE);
  try { fs.chmodSync(RESET_PASSWORD_FILE, 0o600); } catch {}
}
function resetPasswordStatus(admin) { const record = readResetPasswordRecord(); return { configured: Boolean(record), updatedAt: record ? record.updatedAt || null : null, updatedBy: record ? record.updatedBy || '' : '', loginPasswordRequired: Boolean(admin) }; }
// Shared brute-force gate for password-guarded actions (15-minute window).
const securityAttempts = new Map();
function securityGate(key, limit) { const now = Date.now(), window = 15 * 60 * 1000; const record = securityAttempts.get(key) || { count: 0, reset: now + window }; if (now > record.reset) { record.count = 0; record.reset = now + window; } securityAttempts.set(key, record); return { blocked: record.count >= limit, record }; }
function securityFail(record) { record.count += 1; }
function securityClear(key) { securityAttempts.delete(key); }
function loginSession(req, user) { return new Promise((resolve, reject) => req.session.regenerate(err => { if (err) return reject(err); req.session.user = { username: user.username, role: user.role || 'admin', accountId: user.accountId || null, email: user.email || null, phone: user.phone || null, captainName: user.captainName || null }; req.session.save(saveErr => saveErr ? reject(saveErr) : resolve()); })); }

app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  // Dev bypass runs inside sandbox/preview viewers and OBS browser sources, so allow framing there only.
  res.setHeader('X-Frame-Options', DEV_BYPASS_LOGIN ? 'ALLOWALL' : 'SAMEORIGIN');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');next();});
app.use(express.json({ limit: '100kb' }));
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
// Give every request and socket handshake the bypass operator session (dev only).
app.use(developmentLoginBypass);
io.engine.use(developmentLoginBypass);
// Protect the operator HTML before static-file handling, including path-prefix variants.
app.use('/operator.html', requireAuth);
app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'deny' }));
app.get('/', (_, res) => res.redirect('/operator'));
app.get('/login', (_, res) => DEV_BYPASS_LOGIN ? res.redirect('/operator') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login.html', (_, res) => DEV_BYPASS_LOGIN ? res.redirect('/operator') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/operator', requireAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'operator.html')));
app.get('/operator.html', requireAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'operator.html')));
app.get('/overlay', (_, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/register', (_, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/standings', (_, res) => res.sendFile(path.join(__dirname, 'public', 'standings.html')));
app.get('/standings.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'standings.html')));
app.get('/api/public/standings', (_, res) => res.json(spectatorState()));
app.get('/api/public/registration-info', (_, res) => res.json({ tournamentName:tournament.tournamentName, organizer:tournament.organizer, format:tournament.format, open:Boolean(tournament.registrationSettings?.open), maxTeams:Number(tournament.registrationSettings?.maxTeams)||96, approved:(tournament.registrations||[]).filter(r=>r.status==='approved').length, reserved:(tournament.registrations||[]).filter(r=>['approved','pending','waitlisted'].includes(r.status)).length }));
const registrationAttempts = new Map();
const registrationLimiter = (req,res,next) => { const key=req.ip||req.socket.remoteAddress||'unknown'; const now=Date.now(); const record=registrationAttempts.get(key)||{count:0,reset:now+60*60*1000}; if(now>record.reset){record.count=0;record.reset=now+60*60*1000;} if(record.count>=8)return res.status(429).json({error:'Too many registration attempts from this network. Please try again later.'}); record.count++; registrationAttempts.set(key,record); next(); };
let captainAccounts = [];
function loadCaptainAccounts() { try { captainAccounts=JSON.parse(fs.readFileSync(CAPTAINS_FILE,'utf8')); if(!Array.isArray(captainAccounts))captainAccounts=[]; } catch { captainAccounts=[]; } }
function saveCaptainAccounts() { const tmp=`${CAPTAINS_FILE}.tmp`; fs.writeFileSync(tmp,JSON.stringify(captainAccounts,null,2),{mode:0o600}); fs.renameSync(tmp,CAPTAINS_FILE); try{fs.chmodSync(CAPTAINS_FILE,0o600)}catch{} }
loadCaptainAccounts();
function requireCaptain(req,res,next) { if(req.session?.user?.role==='captain' && req.session.user.accountId)return next(); return res.status(401).json({error:'Captain sign-in required.',signInRequired:true}); }
const captainAuthLimiter = (req,res,next) => { const key=`captain:${req.ip||req.socket.remoteAddress||'unknown'}`; const now=Date.now(); const record=registrationAttempts.get(key)||{count:0,reset:now+60*60*1000}; if(now>record.reset){record.count=0;record.reset=now+60*60*1000;} if(record.count>=10)return res.status(429).json({error:'Too many account attempts. Try again in an hour.'}); record.count++; registrationAttempts.set(key,record); next(); };
app.post('/api/captain/auth/signup', sameOrigin, captainAuthLimiter, async (req,res) => {
  if(!(await readAdmin()))return res.status(503).json({error:'Tournament administrator must configure the production workspace before captain registration opens.'});
  const body=req.body||{}; const captainName=String(body.captainName||'').trim(); const email=String(body.email||'').trim().toLowerCase(); const phone=String(body.phone||'').trim(); const password=String(body.password||'');
  if(captainName.length<2||captainName.length>60)return res.status(400).json({error:'Enter your name (2–60 characters).'});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>120)return res.status(400).json({error:'Enter a valid email address.'});
  if(!/^\d{10,15}$/.test(phone))return res.status(400).json({error:'Phone must contain digits only (10–15 digits).'});
  if(password.length<12||password.length>128)return res.status(400).json({error:'Password must be 12–128 characters.'});
  if(captainAccounts.some(a=>a.email.toLowerCase()===email || a.phone===phone))return res.status(409).json({error:'An account already exists for this email or phone number. Sign in instead.'});
  const account={id:crypto.randomUUID(),captainName,email,phone,passwordHash:await bcrypt.hash(password,12),createdAt:new Date().toISOString()};
  captainAccounts.push(account); saveCaptainAccounts(); await loginSession(req,{username:captainName,role:'captain',accountId:account.id,email,phone,captainName});
  res.status(201).json({ok:true,user:{captainName,email,phone},redirect:'/register'});
});
app.post('/api/captain/auth/login', sameOrigin, authLimiter, async (req,res) => {
  const email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||'');
  const account=captainAccounts.find(a=>a.email.toLowerCase()===email);
  if(!account||!(await bcrypt.compare(password,account.passwordHash))){const r=req.authAttemptRecord;r.count+=1;authAttempts.set(req.authAttemptKey,r);return res.status(401).json({error:'Email or password is incorrect.'});}
  authAttempts.delete(req.authAttemptKey); await loginSession(req,{username:account.captainName,role:'captain',accountId:account.id,email:account.email,phone:account.phone,captainName:account.captainName});
  res.json({ok:true,user:{captainName:account.captainName,email:account.email,phone:account.phone},redirect:'/register'});
});
app.get('/api/captain/auth/me',(req,res)=>req.session?.user?.role==='captain'?res.json({authenticated:true,user:{captainName:req.session.user.captainName,email:req.session.user.email,phone:req.session.user.phone}}):res.status(401).json({authenticated:false}));
app.get('/api/captain/my-registration', requireCaptain, (req,res)=>{const item=(tournament.registrations||[]).find(r=>r.accountId===req.session.user.accountId);res.json({registration:item?{id:item.id,teamName:item.teamName,status:item.status,groupPreference:item.groupPreference,assignedGroup:item.assignedGroup,assignedTeamId:item.assignedTeamId,submittedAt:item.submittedAt,reason:item.reason}:null});});
app.post('/api/registrations', sameOrigin, registrationLimiter, requireCaptain, (req,res) => {
  const body=req.body||{}, accountId=req.session.user.accountId;
  if (!tournament.registrationSettings?.open) return res.status(403).json({error:'Team registration is currently closed.'});
  if((tournament.registrations||[]).some(r=>r.accountId===accountId))return res.status(409).json({error:'This captain account has already submitted a team. One account can register one team only.'});
  const account=captainAccounts.find(a=>a.id===accountId); if(!account)return res.status(401).json({error:'Captain account not found. Please sign in again.'});
  const teamName=String(body.teamName||'').trim(), college=String(body.college||'').trim(), captainName=account.captainName, email=account.email, phone=account.phone;
  const playerNames=[1,2,3,4].map(n=>String(body['player'+n]||'').trim()); const playerUids=[1,2,3,4].map(n=>String(body['playerUid'+n]||'').trim()); const playerAvatarUrls=[1,2,3,4].map(n=>cleanHttpUrl(body['playerAvatar'+n])); const substitute=String(body.substitute||'').trim(); const teamLogoUrl=cleanHttpUrl(body.teamLogoUrl);
  if(teamName.length<2||teamName.length>48)return res.status(400).json({error:'Team name must be 2–48 characters.'});
  if(college.length<2||college.length>100)return res.status(400).json({error:'Enter your college, organization or club name.'});
  if(playerNames.some(n=>n.length<2||n.length>48))return res.status(400).json({error:'Enter four player names (2–48 characters each).'});
  if(playerUids.some(uid=>!/^[0-9]{6,15}$/.test(uid)))return res.status(400).json({error:'Each player must have a BGMI Player UID containing 6–15 digits only. Check the ID from the in-game profile.'});
  if(new Set(playerUids).size!==playerUids.length)return res.status(400).json({error:'Each starting player must have a different BGMI Player UID.'});
  if(new Set(playerNames.map(n=>n.toLocaleLowerCase())).size!==playerNames.length)return res.status(400).json({error:'Each starting player must have a different in-game name.'});
  if(body.teamLogoUrl&&!teamLogoUrl)return res.status(400).json({error:'Team logo must be a valid HTTP or HTTPS image URL.'});
  if([1,2,3,4].some(n=>body['playerAvatar'+n]&&!playerAvatarUrls[n-1]))return res.status(400).json({error:'Player image fields must be valid HTTP or HTTPS URLs.'});
  if(!(body.consent==='on'||body.consent===true))return res.status(400).json({error:'Please confirm the information is accurate.'});
  const reserved=tournament.registrations.filter(r=>['approved','pending','waitlisted'].includes(r.status)).length;
  if(reserved>=Number(tournament.registrationSettings.maxTeams||96))return res.status(409).json({error:'Registration capacity has been reached. Contact the organizer for the waitlist.'});
  const duplicate=tournament.registrations.some(r=>String(r.teamName||'').toLowerCase()===teamName.toLowerCase() || String(r.email||'').toLowerCase()===email || String(r.phone||'')===phone);
  if(duplicate)return res.status(409).json({error:'This team name, email or phone is already used by another registration. Contact the organizer if this is an error.'});
  const activeRegistrations=tournament.registrations.filter(r=>['pending','approved','waitlisted'].includes(r.status));
  const duplicatePlayerUids=activeRegistrations.some(r=>(r.playerUids||[]).some(uid=>playerUids.includes(String(uid||''))));
  if(duplicatePlayerUids)return res.status(409).json({error:'At least one BGMI Player UID is already listed on another active application. Verify the roster IDs with your players.'});
  const registration={id:crypto.randomUUID(),accountId,teamName,college,captainName,email,phone,teamLogoUrl,playerNames,playerUids,playerAvatarUrls,substitute,submittedAt:new Date().toISOString(),status:'pending',groupPreference:GROUPS.includes(String(body.groupPreference||''))?String(body.groupPreference):'',assignedTeamId:null,assignedGroup:'',reviewedAt:null,reviewedBy:'',reason:''};
  tournament.registrations.push(registration); audit('registration:submitted',{registrationId:registration.id,teamName,accountId}); save(); emitState(); emitRegistrations();
  res.status(201).json({ok:true,registrationId:registration.id,status:'pending',message:'Registration submitted. One team is allowed per captain account.'});
});
app.get('/api/registrations.csv', requireAuth, (_,res)=>{ const rows=[['Status','Team','College / Club','Captain','Email','Phone','Group Preference','Assigned Group','Assigned Team','Player 1 UID','Player 2 UID','Player 3 UID','Player 4 UID','Submitted At'],...(tournament.registrations||[]).map(r=>[r.status,r.teamName,r.college,r.captainName,r.email,r.phone,r.groupPreference,r.assignedGroup,r.assignedTeamId||'',r.playerUids?.[0]||'',r.playerUids?.[1]||'',r.playerUids?.[2]||'',r.playerUids?.[3]||'',r.submittedAt])]; const csv=rows.map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n'); res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="bgmi-registrations.csv"');res.send(csv); });
app.get('/api/auth/status', async (_, res) => { const admin = await readAdmin(); res.json({ configured: Boolean(admin), setupAllowed: !admin }); });
app.get('/api/auth/me', (req, res) => isAdminUser(req.session?.user) ? res.json({ authenticated: true, user: req.session.user, loginBypass: DEV_BYPASS_LOGIN }) : res.status(401).json({ authenticated: false, loginBypass: DEV_BYPASS_LOGIN }));
app.post('/api/auth/setup', sameOrigin, authLimiter, async (req, res) => {
  const existing = await readAdmin();
  if (existing) return res.status(409).json({ error: 'Administrator is already configured. Please sign in.' });
  const username = String(req.body && req.body.username || '').trim();
  const password = String(req.body && req.body.password || '');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–32 characters (letters, numbers, dot, underscore or hyphen).' });
  if (password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Use a password between 12 and 128 characters.' });
  const passwordHash = await bcrypt.hash(password, 12);
  const temp = `${ADMIN_FILE}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify({ username, passwordHash, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { await fs.promises.rename(temp, ADMIN_FILE); } catch (e) { await fs.promises.rm(temp, { force: true }); const now = await readAdmin(); if (now) return res.status(409).json({ error: 'Administrator was just configured. Please sign in.' }); throw e; }
  authAttempts.delete(req.authAttemptKey);
  await loginSession(req, { username, role: 'admin' });
  audit('auth:administrator-created', { username }); save();
  res.json({ ok: true, redirect: '/operator' });
});
app.post('/api/auth/login', sameOrigin, authLimiter, async (req, res) => {
  const admin = await readAdmin();
  const username = String(req.body && req.body.username || '').trim();
  const password = String(req.body && req.body.password || '');
  if (!admin) return res.status(428).json({ error: 'Initial setup is required.', setupRequired: true });
  const valid = username.toLowerCase() === String(admin.username).toLowerCase() && await bcrypt.compare(password, admin.passwordHash);
  if (!valid) { const r = req.authAttemptRecord; r.count += 1; authAttempts.set(req.authAttemptKey, r); return res.status(401).json({ error: 'Incorrect username or password.' }); }
  authAttempts.delete(req.authAttemptKey);
  await loginSession(req, { username: admin.username, role: 'admin' });
  res.json({ ok: true, redirect: '/operator' });
});
app.post('/api/auth/logout', sameOrigin, (req, res) => { if (!req.session) return res.json({ ok: true }); req.session.destroy(err => { if (err) return res.status(500).json({ error: 'Could not close session.' }); res.clearCookie('bgmi.sid', { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true' }); res.json({ ok: true }); }); });
// Reset protection password: the administrator sets/changes it from Tournament
// setup with the login password as authorisation, and every master reset has to
// present it. A forgotten reset password is replaced by setting a new one here.
app.get('/api/admin/reset-password', requireAuth, async (_, res) => res.json(resetPasswordStatus(await readAdmin())));
app.post('/api/admin/reset-password', sameOrigin, requireAuth, async (req, res) => {
  const key = `reset-password:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  const gate = securityGate(key, 10);
  if (gate.blocked) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  const body = req.body || {};
  const newPassword = String(body.newPassword || '');
  const confirmPassword = String(body.confirmPassword || '');
  const loginPassword = String(body.loginPassword || '');
  if (newPassword.length < RESET_PASSWORD_MIN || newPassword.length > RESET_PASSWORD_MAX) return res.status(400).json({ error: `Use a reset password between ${RESET_PASSWORD_MIN} and ${RESET_PASSWORD_MAX} characters.` });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'The two reset password entries do not match.' });
  const admin = await readAdmin();
  if (admin) {
    if (!(await bcrypt.compare(loginPassword, admin.passwordHash))) { securityFail(gate.record); audit('auth:reset-password-denied', { username: req.session.user.username }); save(); return res.status(401).json({ error: 'Your administrator login password is incorrect.' }); }
  } else if (!DEV_BYPASS_LOGIN) return res.status(503).json({ error: 'The tournament administrator is not configured yet.' });
  securityClear(key);
  writeResetPasswordRecord({ passwordHash: await bcrypt.hash(newPassword, 12), updatedAt: new Date().toISOString(), updatedBy: req.session.user.username || 'admin' });
  commit('auth:reset-password-saved', { username: req.session.user.username });
  res.json({ ok: true, ...resetPasswordStatus(admin) });
});
app.get('/api/health', requireAuth, (_, res) => res.json({ ok: true, service: 'bgmi-broadcast', schemaVersion: 9, connectedClients: io.engine.clientsCount, teams: tournament.teams.length, storageMode, mongoConnected: Boolean(mongoCollection), authConfigured: fs.existsSync(ADMIN_FILE), resetPasswordConfigured: Boolean(readResetPasswordRecord()) }));
app.get('/api/standings.csv',requireAuth,(_,res)=>{
  const rows=[['Rank','Team ID','Team','Group','Finishes','Placement','Match Points','Overall Points','Matches Played']];
  [...tournament.teams].sort((a,b)=>b.overallPoints-a.overallPoints||b.overallKills-a.overallKills||a.name.localeCompare(b.name)).forEach((t,i)=>rows.push([i+1,t.id,t.name,t.group,t.overallKills,t.placement,t.matchPoints,t.overallPoints,t.overallMatches]));
  const csv=rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="bgmi-standings.csv"');res.send(csv);
});

io.use((socket, next) => {
  const role = socket.handshake && socket.handshake.auth && socket.handshake.auth.role;
  if (isOperator(socket) || role === 'overlay' || role === 'spectator') return next();
  return next(new Error('unauthorized'));
});
io.on('connection',socket=>{
  const clientRole=socket.handshake?.auth?.role||'';socket.data.clientRole=isOperator(socket)?'operator':clientRole;
  if(clientRole==='spectator'&&!isOperator(socket)){socket.join('spectators');socket.emit('spectator:update',spectatorState());return;}
  if(clientRole==='overlay'&&!isOperator(socket)){socket.join('overlays');socket.emit('tournament:update',publicState());return;}
  socket.emit('tournament:update',operatorState());
  if (isOperator(socket)) socket.emit('registrations:update', [...(tournament.registrations||[])].sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)));
  socket.on('registration:review', ({registrationId,decision,group='A',reason=''}={}) => {
    if (!requireOperatorSocket(socket)) return;
    const record=(tournament.registrations||[]).find(r=>r.id===String(registrationId));
    if(!record) return error(socket,'Registration not found. Refresh the registrations page.');
    if(!['approved','rejected','waitlisted','pending'].includes(decision)) return error(socket,'Invalid review decision.');
    if(record.status==='approved') return error(socket,'This registration is already approved.');
    if(decision==='pending') { record.status='pending';record.reviewedAt=null;record.reviewedBy='';record.reason='';audit('registration:reopened',{registrationId:record.id}); } else if(decision==='approved') {
      const chosenGroup=GROUPS.includes(String(group))?String(group):(GROUPS.includes(record.groupPreference)?record.groupPreference:'A');
      const used=new Set((tournament.matchHistory||[]).flatMap(m=>(m.results||[]).map(x=>Number(x.teamId))));
      const availableSlots=tournament.teams.filter(t=>!t.registered&&t.group===chosenGroup);
      const slot=availableSlots.find(t=>!used.has(t.id))||availableSlots[0];
      if(!slot) return error(socket,`No unused team slot remains in Group ${chosenGroup}. Select a different group or reallocate the group roster before approving this team.`);
      if(tournament.teams.some(t=>t.registered&&t.name.toLowerCase()===record.teamName.toLowerCase())) return error(socket,'A team with this name is already approved.');
      if(used.has(slot.id)) {
        tournament.matchHistory=(tournament.matchHistory||[]).map(match=>({...match,results:(match.results||[]).filter(result=>Number(result.teamId)!==Number(slot.id))})).filter(match=>match.results.length);
      }
      slot.name=record.teamName; slot.group=chosenGroup; slot.college=record.college; slot.substitute=record.substitute; slot.registered=true; slot.registrationId=record.id; slot.kills=0; slot.placement=0; slot.placementAuto=true; slot.eliminatedAt=null; slot.matchPoints=0; slot.logo='';
      slot.logo=record.teamLogoUrl||''; slot.players=record.playerNames.map((name,i)=>({name:name||`PLAYER ${i+1}`,uid:String(record.playerUids?.[i]||'').replace(/\D/g,'').slice(0,15),status:'alive',kills:0,avatarUrl:record.playerAvatarUrls?.[i]||'',autoEliminated:false}));
      record.status='approved';record.assignedTeamId=slot.id;record.assignedGroup=chosenGroup;record.reviewedAt=new Date().toISOString();record.reviewedBy=socket.request.session.user.username;record.reason='';
      audit('registration:approved',{registrationId:record.id,teamId:slot.id,group:chosenGroup});
    } else { record.status=decision; record.reviewedAt=new Date().toISOString();record.reviewedBy=socket.request.session.user.username;record.reason=String(reason||'').trim().slice(0,300); audit(`registration:${decision}`,{registrationId:record.id}); }
    save();emitState();emitRegistrations();socket.emit('registration:reviewed',{id:record.id,status:record.status,teamId:record.assignedTeamId});
  });
  socket.on('tournament:update-settings',payload=>{
    if (!requireOperatorSocket(socket)) return;
    if(!payload||typeof payload!=='object')return error(socket,'Invalid tournament settings.');
    if(typeof payload.tournamentName==='string')tournament.tournamentName=payload.tournamentName.trim().slice(0,80)||tournament.tournamentName;
    if(typeof payload.organizer==='string')tournament.organizer=payload.organizer.trim().slice(0,80);
    if(typeof payload.format==='string')tournament.format=payload.format.trim().slice(0,80);
    if(payload.semifinalSlots!==undefined)tournament.qualification.semifinalSlots=Math.max(1,Math.min(tournament.teams.length,Math.floor(Number(payload.semifinalSlots)||24)));
    if(payload.finalSlots!==undefined)tournament.qualification.finalSlots=Math.max(1,Math.min(tournament.teams.length,Math.floor(Number(payload.finalSlots)||16)));
    if(payload.registrationOpen!==undefined)tournament.registrationSettings.open=Boolean(payload.registrationOpen);
    if(payload.registrationCapacity!==undefined)tournament.registrationSettings.maxTeams=Math.max(16,Math.min(96,Math.floor(Number(payload.registrationCapacity)||96)));
    if(payload.finishPoint!==undefined)tournament.scoringRules.finishPoint=Math.max(0,Math.min(10,Number(payload.finishPoint)||0));
    if(payload.placementPoints&&typeof payload.placementPoints==='object'){const next={};for(let p=1;p<=8;p++)next[p]=Math.max(0,Math.min(100,Math.floor(Number(payload.placementPoints[p])||0)));tournament.scoringRules.placementPoints=next;}
    recalculate();
    commit('tournament:settings-updated');
  });
  socket.on('teams:generate',({count=96}={})=>{
    if (!requireOperatorSocket(socket)) return;
    count=Math.max(16,Math.min(96,Math.floor(Number(count)||96)));
    const usedIds=new Set((tournament.matchHistory||[]).flatMap(m=>(m.results||[]).map(r=>Number(r.teamId))));
    if(tournament.teams.some(t=>t.id>count&&t.registered)||usedIds.size&&[...usedIds].some(id=>id>count))return error(socket,'Cannot shrink the roster below a registered or finalized team ID. Keep 96 slots or start a new tournament.');
    const existing=new Map(tournament.teams.map(t=>[t.id,t]));
    tournament.teams=Array.from({length:count},(_,i)=>existing.get(i+1)||makeTeam(i+1,count));
    for(const t of tournament.teams)if(!t.group)t.group=GROUPS[Math.floor((t.id-1)/Math.ceil(count/6))%6];
    tournament.matchTeamIds=(tournament.matchTeamIds||[]).filter(id=>id<=count);if(tournament.matchTeamIds.length<2)tournament.matchTeamIds=tournament.teams.filter(t=>t.group==='A').slice(0,Math.min(16,count)).map(t=>t.id);
    tournament.registrationSettings.maxTeams=Math.min(tournament.registrationSettings.maxTeams,count);tournament.qualification.semifinalSlots=Math.min(tournament.qualification.semifinalSlots,count);tournament.qualification.finalSlots=Math.min(tournament.qualification.finalSlots,count);
    commit('teams:generated',{count});
  });
  socket.on('team:update',({teamId,updates={}}={})=>{
    if (!requireOperatorSocket(socket)) return;
    const team=findTeam(teamId);if(!team||!updates||typeof updates!=='object')return error(socket,'Team not found.');
    if(typeof updates.name==='string')team.name=updates.name.trim().slice(0,48)||team.name;
    if(typeof updates.group==='string'&&GROUPS.includes(updates.group.trim())){team.group=updates.group.trim();if(team.registrationId){const reg=tournament.registrations.find(r=>r.id===team.registrationId);if(reg)reg.assignedGroup=team.group;}}
    if(typeof updates.logo==='string')team.logo=cleanHttpUrl(updates.logo);
    if(Array.isArray(updates.players))team.players=updates.players.slice(0,4).map((p,i)=>({name:String(p.name||`PLAYER ${i+1}`).trim().slice(0,32)||`PLAYER ${i+1}`,uid:String(p.uid||team.players[i]?.uid||'').replace(/\D/g,'').slice(0,15),status:PLAYER_STATUSES.includes(p.status)?p.status:'alive',kills:Math.max(0,Math.min(999,Math.floor(Number(p.kills)||0))),damage:Math.max(0,Math.min(50000,Math.floor(Number(p.damage??team.players[i]?.damage)||0))),avatarUrl:cleanHttpUrl(p.avatarUrl)}));
    if(updates.placement!==undefined){
      if(tournament.matchStatus==='verified')return error(socket,'This match is verified.');
      const lobbySize=activeMatchTeams().length;
      const p=Number(updates.placement);
      if(!Number.isInteger(p)||p<0||p>lobbySize)return error(socket,`Placement must be a whole number from 0 to ${lobbySize} in this lobby.`);
      if(!activeMatchTeams().some(t=>t.id===team.id))return error(socket,'This squad is not selected for the current match lineup.');
      // Positions are unique by rule: 16th place belongs to exactly one squad.
      if(p>=1){
        const holder=activeMatchTeams().find(t=>t.id!==team.id&&Number(t.placement)===p);
        if(holder)return error(socket,`Placement ${p} is already taken by ${holder.name}. Give one of them a different position, or press \u21ba AUTO to let the elimination order decide.`);
      }
      team.placement=p;team.placementAuto=updates.placementAuto===true;if(team.placementAuto)team.eliminatedAt=null;recalculate();
    }
    commit('team:updated',{teamId:team.id});
  });
  socket.on('team:kill',({teamId,amount=1}={})=>{
    if (!requireOperatorSocket(socket)) return;
    const team=findTeam(teamId),delta=Number(amount);if(!team||![-1,1].includes(delta))return;if(!activeMatchTeams().some(t=>t.id===team.id))return error(socket,'This squad is not selected for the current match lineup.');
    if(tournament.matchStatus==='verified')return error(socket,'This match is verified. Start the next match or reopen it through the correction workflow.');
    team.kills=Math.max(0,team.kills+delta);recalculate();logEvent('finish',team.id,`${team.name}: ${delta>0?'+1 finish':'−1 finish'}`,delta);commit('team:finish',{teamId:team.id,delta});
  });
  socket.on('player:update',({teamId,playerIndex,status}={})=>{
    if (!requireOperatorSocket(socket)) return;
    const team=findTeam(teamId),i=Number(playerIndex);if(!team||!Number.isInteger(i)||!team.players[i]||!PLAYER_STATUSES.includes(status))return;if(!activeMatchTeams().some(t=>t.id===team.id))return error(socket,'This squad is not selected for the current match lineup.');
    if(tournament.matchStatus==='verified')return error(socket,'This match is verified.');
    const previous=team.players[i].status;
    team.players[i].status=status;
    if(status!=='eliminated')team.players[i].autoEliminated=false;
    // Nobody is left to revive a knocked player, so the squad is wiped out.
    const cascaded=applySquadWipe(team);
    logEvent('status',team.id,`${team.name} player ${i+1}: ${previous} → ${status}${cascaded?` · squad wiped (${cascaded} knocked player${cascaded===1?'':'s'} eliminated)`:''}`);
    if(cascaded===-1)team.players.forEach((p,pi)=>{if(p.autoEliminated){p.status='knocked';p.autoEliminated=false;logEvent('status',team.id,`${team.name} player ${pi+1}: revived to knocked`);}});
    commit('player:status',{teamId:team.id,playerIndex:i,status});
  });
  socket.on('player:damage',({teamId,playerIndex,damage}={})=>{
    if(!requireOperatorSocket(socket))return;
    const team=findTeam(teamId),i=Number(playerIndex),value=Number(damage);
    if(!team||!Number.isInteger(i)||!team.players[i]||!Number.isInteger(value)||value<0||value>50000)return error(socket,'Player damage must be a whole number from 0 to 50,000.');
    if(!activeMatchTeams().some(t=>t.id===team.id))return error(socket,'This squad is not selected for the current match lineup.');
    if(tournament.matchStatus==='verified')return error(socket,'This match is verified.');
    const previous=Number(team.players[i].damage)||0;team.players[i].damage=value;
    logEvent('player-damage',team.id,`${team.players[i].name}: damage ${previous} → ${value} · ${team.name}`);commit('player:damage',{teamId:team.id,playerIndex:i,damage:value});
  });
  socket.on('player:kill',({teamId,playerIndex,amount=1}={})=>{
    if(!requireOperatorSocket(socket))return;
    const team=findTeam(teamId),i=Number(playerIndex),delta=Number(amount);
    if(!team||!Number.isInteger(i)||!team.players[i]||![-1,1].includes(delta))return error(socket,'Invalid player finish update.');
    if(!activeMatchTeams().some(t=>t.id===team.id))return error(socket,'This squad is not selected for the current match lineup.');
    if(tournament.matchStatus==='verified')return error(socket,'This match is verified.');
    if(delta<0&&team.players[i].kills<=0)return error(socket,'Player finish count cannot go below zero.');
    if(delta<0&&team.kills<=0)return error(socket,'Team finish count cannot go below zero.');
    team.players[i].kills=Math.max(0,team.players[i].kills+delta);team.kills=Math.max(0,team.kills+delta);recalculate();
    logEvent('player-finish',team.id,`${team.players[i].name}: ${delta>0?'+1 finish':'−1 finish'} · ${team.name}`,delta);commit('player:finish',{teamId:team.id,playerIndex:i,delta});
  });
  socket.on('production:update',({casterName,casterTagline,casterImageUrl,mapImageUrl,eventLogoUrl,themeMusicUrl,streamStartDurationMinutes,broadcastStageLabel,broadcastDayLabel,broadcastGroupLabel,broadcastMatchCaption}={})=>{
    if(!requireOperatorSocket(socket))return;
    const casterUrl=cleanHttpUrl(casterImageUrl), mapUrl=cleanHttpUrl(mapImageUrl), eventLogo=cleanHttpUrl(eventLogoUrl), musicUrl=cleanMediaUrl(themeMusicUrl);
    if(casterImageUrl&&!casterUrl)return error(socket,'Caster image must be a valid HTTP or HTTPS URL.');
    if(mapImageUrl&&!mapUrl)return error(socket,'Map image must be a valid HTTP or HTTPS URL.');
    if(eventLogoUrl&&!eventLogo)return error(socket,'Tournament logo must be a valid HTTP or HTTPS URL.');
    if(themeMusicUrl&&!musicUrl)return error(socket,'Theme audio must be an HTTP/HTTPS URL or a same-site /assets/ path.');
    if(casterName!==undefined)tournament.production.caster.name=String(casterName||'MAIN CASTER').trim().slice(0,60)||'MAIN CASTER';
    if(casterTagline!==undefined)tournament.production.caster.tagline=String(casterTagline||'').trim().slice(0,100);
    if(casterImageUrl!==undefined)tournament.production.caster.imageUrl=casterUrl;
    if(mapImageUrl!==undefined)tournament.production.mapFeed.imageUrl=mapUrl;
    if(eventLogoUrl!==undefined)tournament.production.eventLogoUrl=eventLogo;
    if(themeMusicUrl!==undefined)tournament.production.themeMusicUrl=musicUrl;
    if(streamStartDurationMinutes!==undefined)tournament.production.streamStartDurationSeconds=Math.max(60,Math.min(10800,Math.floor(Number(streamStartDurationMinutes)||20)*60));
    if(broadcastStageLabel!==undefined)tournament.production.broadcastStageLabel=String(broadcastStageLabel||'GROUP STAGE').trim().slice(0,50)||'GROUP STAGE';
    if(broadcastDayLabel!==undefined)tournament.production.broadcastDayLabel=String(broadcastDayLabel||'DAY 1').trim().slice(0,30)||'DAY 1';
    if(broadcastGroupLabel!==undefined)tournament.production.broadcastGroupLabel=String(broadcastGroupLabel||'').trim().slice(0,40);
    if(broadcastMatchCaption!==undefined)tournament.production.broadcastMatchCaption=String(broadcastMatchCaption||'').trim().slice(0,60);
    commit('production:updated');
  });
  socket.on('broadcast:stream-start',({durationMinutes=20}={})=>{
    if(!requireOperatorSocket(socket))return;
    const minutes=Math.max(1,Math.min(180,Math.floor(Number(durationMinutes)||20)));
    if(countdownTimer)clearTimeout(countdownTimer);countdownTimer=null;tournament.production.countdownEndsAt=null;
    if(streamStartTimer)clearTimeout(streamStartTimer);
    tournament.production.streamStartDurationSeconds=minutes*60;
    tournament.production.streamStartEndsAt=Date.now()+minutes*60*1000;
    tournament.broadcastState='stream-start';
    commit('broadcast:stream-start-started',{durationMinutes:minutes});
    streamStartTimer=setTimeout(()=>{if(tournament.broadcastState==='stream-start'&&tournament.production.streamStartEndsAt&&Date.now()>=tournament.production.streamStartEndsAt){tournament.production.streamStartEndsAt=null;tournament.broadcastState='caster';streamStartTimer=null;commit('broadcast:stream-start-complete');}},minutes*60*1000+30);
  });
  socket.on('broadcast:countdown',({durationSeconds=30}={})=>{
    if(!requireOperatorSocket(socket))return;
    const duration=Math.max(5,Math.min(180,Math.floor(Number(durationSeconds)||30)));
    if(streamStartTimer)clearTimeout(streamStartTimer);streamStartTimer=null;tournament.production.streamStartEndsAt=null;
    tournament.production.countdownDuration=duration;tournament.production.countdownEndsAt=Date.now()+duration*1000;tournament.broadcastState='countdown';
    commit('broadcast:countdown-started',{durationSeconds:duration});
    if(countdownTimer)clearTimeout(countdownTimer);
    countdownTimer=setTimeout(()=>{if(tournament.broadcastState==='countdown'&&tournament.production.countdownEndsAt&&Date.now()>=tournament.production.countdownEndsAt){tournament.production.countdownEndsAt=null;tournament.broadcastState='live';tournament.matchStatus='live';commit('broadcast:countdown-complete');}},duration*1000+30);
  });
  socket.on('broadcast:mvp',({mode='match',teamId,playerIndex}={})=>{
    if(!requireOperatorSocket(socket))return;
    tournament.production.mvpMode=mode==='overall'?'overall':'match';
    if(Number.isInteger(Number(teamId))&&Number.isInteger(Number(playerIndex)))tournament.production.mvpSelection={teamId:Number(teamId),playerIndex:Number(playerIndex)};else tournament.production.mvpSelection=null;
    tournament.broadcastState='mvp';commit('broadcast:mvp',{mode:tournament.production.mvpMode});
  });
  socket.on('match:configure',({number,group,map,teamIds}={})=>{
    if (!requireOperatorSocket(socket)) return;
    const nextNumber=number===undefined?tournament.currentMatch:Number(number);
    const nextGroup=group===undefined?tournament.currentGroup:(String(group).trim().slice(0,16)||'A');
    if(!Number.isInteger(nextNumber)||nextNumber<1||nextNumber>999)return error(socket,'Match number must be between 1 and 999.');
    if(tournament.matchHistory.some(m=>Number(m.matchNumber)===nextNumber&&String(m.group||'A')===String(nextGroup)))return error(socket,'That match number and phase already has finalized results. Choose another match number or phase.');
    const nextTeamIds=Array.isArray(teamIds)?[...new Set(teamIds.map(Number).filter(id=>Number.isInteger(id)&&tournament.teams.some(t=>t.id===id)))]:tournament.teams.filter(t=>t.group===nextGroup).slice(0,16).map(t=>t.id);
    if(nextTeamIds.length<2)return error(socket,'Select at least two teams for the match lineup.');
    if(nextTeamIds.length>16)return error(socket,'A match lineup can contain a maximum of 16 teams.');
    const changed=nextNumber!==tournament.currentMatch||nextGroup!==tournament.currentGroup||nextTeamIds.join(',')!==(tournament.matchTeamIds||[]).join(',');
    tournament.currentMatch=nextNumber;tournament.currentGroup=nextGroup;tournament.matchTeamIds=nextTeamIds;
    if(map!==undefined)tournament.currentMap=String(map).trim().slice(0,40)||'Erangel';
    if(changed){tournament.teams.forEach(t=>{t.kills=0;t.placement=0;t.matchPoints=0;t.players.forEach(p=>{p.status='alive';p.kills=0;p.damage=0})});resetAutoPlacements();tournament.matchStatus='upcoming';tournament.eventLog=[];}
    commit('match:configured',{matchNumber:tournament.currentMatch,group:tournament.currentGroup,map:tournament.currentMap,teamIds:nextTeamIds});
  });
  socket.on('placements:auto-mode',({enabled}={})=>{
    if (!requireOperatorSocket(socket)) return;
    if(tournament.matchStatus==='verified')return error(socket,'This match is verified.');
    tournament.autoPlacements = enabled !== false;
    if(tournament.autoPlacements) activeMatchTeamList().forEach(t=>{t.placementAuto=true;});
    else activeMatchTeamList().forEach(t=>{t.placementAuto=false;});
    tournament.auditLog.push({id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,at:new Date().toISOString(),action:'placements:auto-mode',enabled:tournament.autoPlacements});
    commit('placements:auto-mode',{enabled:tournament.autoPlacements});
  });
  socket.on('placements:reset-auto',()=>{
    if (!requireOperatorSocket(socket)) return;
    if(tournament.matchStatus==='verified')return error(socket,'This match is verified.');
    const active = activeMatchTeamList();
    // Keep the elimination timeline: only the manual pin is released.
    active.forEach(t=>{t.placementAuto=true;t.placement=0;t.matchPoints=0;});
    commit('placements:recalculated',{teams:active.length});
  });
  socket.on('match:status',value=>{
    if (!requireOperatorSocket(socket)) return;
    if(!MATCH_STATUSES.includes(value))return error(socket,'Invalid match status.');
    if(value==='live'&&tournament.matchHistory.some(m=>Number(m.matchNumber)===Number(tournament.currentMatch)&&String(m.group||'A')===String(tournament.currentGroup)))return error(socket,'This match number and group already has finalized results. Choose the next match number or group.');
    tournament.matchStatus=value;
    if(value==='live')tournament.broadcastState='live';
    if(value==='awaiting-verification')tournament.broadcastState='results';
    logEvent('match-status',null,`Match ${tournament.currentMatch}: ${value}`);commit('match:status',{status:value});
  });
  socket.on('broadcast:state',value=>{
    if (!requireOperatorSocket(socket)) return;if(!BROADCAST_STATES.includes(value))return error(socket,'Unknown broadcast scene.');
    if(value!=='stream-start'){if(streamStartTimer)clearTimeout(streamStartTimer);streamStartTimer=null;tournament.production.streamStartEndsAt=null;}
    if(value!=='countdown'){if(countdownTimer)clearTimeout(countdownTimer);countdownTimer=null;tournament.production.countdownEndsAt=null;}
    tournament.broadcastState=value;commit('broadcast:state',{state:value});});
  socket.on('match:finalize',()=>{
    if (!requireOperatorSocket(socket)) return;
    if(tournament.matchHistory.some(m=>Number(m.matchNumber)===Number(tournament.currentMatch)&&String(m.group||'A')===String(tournament.currentGroup)))return error(socket,'This match number and group already has a finalized result. Choose another match number or group.');
    recalculate();const groupTeams=activeMatchTeams();
    if(groupTeams.length<2)return error(socket,'Select at least two teams in the match lineup.');
    const results=groupTeams.map(t=>({teamId:t.id,teamName:t.name,group:t.group,kills:t.kills,placement:t.placement,placementPoints:placementPoints(t.placement,tournament),matchPoints:t.matchPoints,teamLogo:t.logo||'',players:t.players.map(p=>({...p,uid:String(p.uid||'').replace(/\D/g,'').slice(0,15)}))})).sort((a,b)=>(a.placement||999)-(b.placement||999)||b.kills-a.kills);
    if(results.every(r=>r.kills===0&&r.placement===0))return error(socket,'Enter at least one finish or placement before verifying results.');
    if(results.some(r=>r.placement<1||r.placement>groupTeams.length))return error(socket,`Enter a final placement from 1 to ${groupTeams.length} for every selected squad before publishing.`);
    const placed=results.map(r=>r.placement);if(new Set(placed).size!==placed.length)return error(socket,'Duplicate placements found. Each squad must have a unique final placement.');
    tournament.matchHistory.push({matchNumber:tournament.currentMatch,group:tournament.currentGroup,map:tournament.currentMap,teamIds:groupTeams.map(t=>t.id),finalizedAt:new Date().toISOString(),verified:true,results});
    tournament.teams.forEach(t=>{t.kills=0;t.placement=0;t.matchPoints=0;t.players.forEach(p=>{p.status='alive';p.kills=0;p.damage=0});});resetAutoPlacements();
    tournament.eventLog=[];tournament.matchStatus='verified';tournament.broadcastState='chicken-dinner';logEvent('verified',null,`Match ${tournament.currentMatch} results verified and published`);commit('match:verified',{matchNumber:tournament.currentMatch});
  });
  socket.on('match:reset',()=>{
    if (!requireOperatorSocket(socket)) return;
    if(tournament.matchStatus==='verified')return error(socket,'Verified results are locked. Choose a new match number; corrections should preserve the official record.');
    tournament.teams.forEach(t=>{t.kills=0;t.placement=0;t.matchPoints=0;t.players.forEach(p=>{p.status='alive';p.kills=0;p.damage=0});});resetAutoPlacements();tournament.matchStatus='upcoming';tournament.eventLog=[];commit('match:reset',{matchNumber:tournament.currentMatch});
  });
  socket.on('tournament:master-reset',async (payload={},ack)=>{
    const respond=result=>{ if(typeof ack==='function')ack(result); return result; };
    if (!requireOperatorSocket(socket)) return respond({ok:false,error:'Authorized operator login required. Please sign in again.'});
    const body=payload&&typeof payload==='object'?payload:{};
    const scope=body.scope==='factory'?'factory':'competition';
    const actor=(socket.request.session.user&&socket.request.session.user.username)||'operator';
    const gateKey=`master-reset:${socket.handshake.address||'socket'}`;
    const gate=securityGate(gateKey,10);
    if(gate.blocked)return respond({ok:false,error:'Too many incorrect reset password attempts. Wait 15 minutes and try again.'});
    const record=readResetPasswordRecord();
    if(!record)return respond({ok:false,error:'No reset password is configured yet. Set one in Tournament setup → Reset protection password first.'});
    if(!(await bcrypt.compare(String(body.password||''),record.passwordHash))){
      securityFail(gate.record);
      // A refused reset is part of the record: leave a trace before answering.
      audit('tournament:master-reset-denied',{username:actor,scope});save();
      return respond({ok:false,error:'Reset password is incorrect.'});
    }
    securityClear(gateKey);
    if(countdownTimer){clearTimeout(countdownTimer);countdownTimer=null;}
    if(streamStartTimer){clearTimeout(streamStartTimer);streamStartTimer=null;}
    if(scope==='factory'){
      const erased={registrations:(tournament.registrations||[]).length,registeredTeams:tournament.teams.filter(t=>t.registered).length,matches:(tournament.matchHistory||[]).length};
      tournament=factoryResetData();
      commit('tournament:factory-reset',{username:actor,...erased});
      return respond({ok:true,scope,erased});
    }
    const cleared={matches:(tournament.matchHistory||[]).length,registeredTeams:(tournament.registrations||[]).filter(r=>r.status==='approved').length};
    clearCompetitionData(tournament);
    commit('tournament:master-reset',{username:actor,...cleared});
    return respond({ok:true,scope,cleared});
  });
});

async function initializeStorage() {
  if (!MONGODB_URI) { storageMode = 'Local JSON · recovery snapshot enabled'; return; }
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB);
  mongoCollection = db.collection('tournaments');
  const doc = await mongoCollection.findOne({ _id: 'active' });
  if (doc) { delete doc._id; tournament = normalizeData(doc); }
  else await mongoCollection.insertOne({ ...JSON.parse(JSON.stringify(tournament)), _id: 'active' });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(tournament, null, 2)); fs.renameSync(temp, DATA_FILE);
  storageMode = 'MongoDB primary · JSON recovery snapshot';
}
initializeStorage().then(() => {
  server.listen(PORT, HOST, () => console.log(`\nBGMI Broadcast V4.8.1 Tactical Broadcast Arena\nHost    : ${HOST}\nOperator: http://localhost:${PORT}/operator\nLogin   : ${DEV_BYPASS_LOGIN ? 'BYPASSED (DEV_BYPASS_LOGIN=true) - /operator opens directly, development only' : 'http://localhost:' + PORT + '/login'}\nRegister: http://localhost:${PORT}/register\nOverlay : http://localhost:${PORT}/overlay\nHealth  : http://localhost:${PORT}/api/health\nStorage : ${storageMode}\n`));
}).catch(err => { console.error('Storage initialization failed:', err.message); process.exit(1); });
