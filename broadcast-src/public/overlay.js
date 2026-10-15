const socket = io({ auth: { role: 'overlay' } });
const $ = id => document.getElementById(id);
let lastState = null;
let lastBroadcastState = null;
let lastRenderedScene = null;
// Preview aid: /overlay?scene=overall pins this browser tab to one scene without
// touching the live broadcast state, so any scene can be checked in a normal tab.
const BROADCAST_STATES_PREVIEW=['pre-show','stream-start','countdown','caster','format','lineup','live','chicken-dinner','frag-leaders','results','overall','mvp','map-feed','intermission','technical-difficulties','hidden'];
const PREVIEW_SCENE=(()=>{try{const v=new URLSearchParams(location.search).get('scene');return v&&BROADCAST_STATES_PREVIEW.includes(v)?v:''}catch{return ''}})();
let overallPage = 0;
let sceneWipeTimer = null;
let loadedThemeUrl = '';
let lineupPage = 0;
let slideTransitionTriggered = false;
function syncThemeMusic(data,stateName){const audio=$('showMusic');const url=String(data.production?.themeMusicUrl||'').trim();if(url&&url!==loadedThemeUrl){audio.pause();audio.src=url;audio.load();loadedThemeUrl=url;}if(stateName==='stream-start'&&url){if(audio.paused)audio.play().catch(()=>{/* If browser autoplay is blocked, use the same track as an OBS Media Source. */});}else if(lastBroadcastState==='stream-start'||stateName!=='stream-start'){if(!audio.paused){audio.pause();try{audio.currentTime=0}catch{}}}lastBroadcastState=stateName;}
function playCinematicTransition(stateName){
  const wipe=$('transitionWipe');
  const label=$('transitionLabel');
  if(!wipe||!label)return;
  const words={
    'pre-show':'BROADCAST ONLINE','stream-start':'WE GO LIVE SOON','format':'THE ROAD TO CHAMPION',
    'lineup':'TEAMS DROPPING IN','caster':'CASTER READY','countdown':'DROP IN','live':'MATCH LIVE',
    'mvp':'PLAYER SPOTLIGHT','frag-leaders':'TOP FIVE FRAG LEADERS','chicken-dinner':'CHICKEN DINNER','map-feed':'TACTICAL MAP','results':'MATCH RESULTS','overall':'OVERALL STANDINGS',
    'intermission':'RESET AND RELOAD','technical-difficulties':'SIGNAL RECOVERY','hidden':'STANDBY'
  };
  label.textContent=words[stateName]||'BATTLEGROUNDS';
  wipe.classList.remove('active');
  // Force a new animation timeline when the same scene is revisited.
  void wipe.offsetWidth;
  wipe.classList.add('active');
  if(sceneWipeTimer)clearTimeout(sceneWipeTimer);
  sceneWipeTimer=setTimeout(()=>wipe.classList.remove('active'),1250);
}
function initials(value=''){return String(value).trim().split(/\s+/).slice(0,2).map(s=>s[0]||'').join('').toUpperCase()||'?';}
function setImage(imgId, fallbackId, url, fallbackText){const img=$(imgId),fallback=$(fallbackId);img.onerror=()=>{img.classList.add('hidden');fallback.classList.remove('hidden')};if(url){img.src=url;img.classList.remove('hidden');fallback.classList.add('hidden')}else{img.removeAttribute('src');img.classList.add('hidden');fallback.textContent=fallbackText||'?';fallback.classList.remove('hidden')}}
function setTeamLogo(img,url,teamName){img.replaceChildren();if(url){const image=document.createElement('img');image.src=url;image.alt=`${teamName} logo`;image.onerror=()=>{img.textContent=initials(teamName)};img.append(image)}else img.textContent=initials(teamName)}
socket.on('tournament:update', data => { lastState = data; render(data); });
socket.on('connect_error',()=>{});
function scoreOverallTeams(data){
  const history=Array.isArray(data.matchHistory)?data.matchHistory:[];
  const finishPoint=Math.max(0,Number(data.scoringRules?.finishPoint)||1);
  return (data.teams||[]).map(team=>{
    const records=history.flatMap(m=>(m.results||[]).map(r=>({...r,matchNumber:m.matchNumber,matchGroup:m.group}))).filter(r=>Number(r.teamId)===Number(team.id));
    const wins=records.filter(r=>Number(r.placement)===1).length;
    const positionPoints=records.reduce((sum,r)=>{
      const value=r.placementPoints!==undefined&&r.placementPoints!==null?Number(r.placementPoints):Math.max(0,(Number(r.matchPoints)||0)-(Number(r.kills)||0)*finishPoint);
      return sum+Math.max(0,Number(value)||0);
    },0);
    return {...team,overallWins:wins,overallPlacementPoints:positionPoints,overallMatches:Number(team.overallMatches)||records.length,overallFinishes:Number(team.overallKills)||records.reduce((sum,r)=>sum+(Number(r.kills)||0),0)};
  }).sort((a,b)=>(Number(b.overallPoints)||0)-(Number(a.overallPoints)||0)||(Number(b.overallFinishes)||0)-(Number(a.overallFinishes)||0)||a.name.localeCompare(b.name));
}
function groupClass(group){const g=String(group||'A').toLowerCase();return ['a','b','c','d','e','f'].includes(g)?`group-${g}`:'group-a'}
function animatePageSwap(root){if(!root)return;root.classList.remove('page-change');void root.offsetWidth;root.classList.add('page-change');setTimeout(()=>root.classList.remove('page-change'),650)}
function renderLiveScoreboard(data){
  const root=$('teams');root.replaceChildren();
  const activeIds=new Set((data.matchTeamIds||[]).map(Number));
  const ranked=scoreOverallTeams(data).map(team=>{
    const actual=(data.teams||[]).find(t=>Number(t.id)===Number(team.id))||team;
    const inProgress=activeIds.has(Number(team.id))&&data.matchStatus!=='verified';
    return {...team,_actual:actual,_isCurrent:inProgress,_liveFinishes:(Number(team.overallFinishes)||0)+(inProgress?(Number(actual.kills)||0):0),_livePoints:(Number(team.overallPoints)||0)+(inProgress?(Number(actual.matchPoints)||0):0)};
  }).sort((a,b)=>b._livePoints-a._livePoints||b._liveFinishes-a._liveFinishes||String(a.name).localeCompare(String(b.name))).slice(0,16);
  ranked.forEach((team,index)=>{
    const actual=team._actual;
    const row=document.createElement('div');row.className='row';row.dataset.group=String(team.group||'A');
    const rank=document.createElement('span');rank.className=`rank ${groupClass(team.group)}`;rank.textContent=String(index+1).padStart(2,'0');
    const logo=document.createElement('span');logo.className='team-logo';setTeamLogo(logo,team.logo,team.name);
    const name=document.createElement('span');name.className='name';name.textContent=team.name;
    const finishes=document.createElement('span');finishes.className='kills';finishes.textContent=String(team._liveFinishes);
    const points=document.createElement('span');points.className='pts';points.textContent=String(team._livePoints);
    const matches=document.createElement('span');matches.className='matches-count';matches.textContent=String(team.overallMatches||0);
    const statuses=document.createElement('span');statuses.className='players';
    (actual.players||[{}, {}, {}, {}]).forEach(player=>{const bar=document.createElement('i');bar.className=team._isCurrent?(player.status||'alive'):'untracked';bar.title=team._isCurrent?(player.status||'alive'):'not in current match';statuses.append(bar)});
    row.append(rank,logo,name,finishes,points,matches,statuses);root.append(row);requestAnimationFrame(()=>row.classList.add('show'));
  });
}
function render(data) {
  $('eventName').textContent = data.tournamentName || 'BGMI ESPORTS';$('cardEvent').textContent=data.tournamentName||'BGMI BROADCAST';$('casterEvent').textContent=data.tournamentName||'BGMI BROADCAST';$('mapFeedEvent').textContent=data.tournamentName||'BGMI BROADCAST';
  $('matchNumber').textContent=String(data.currentMatch||1).padStart(2,'0');$('headerMap').textContent=`${data.currentMap||'ERANGEL'} · GROUP ${data.currentGroup||'A'}`;
  $('countdownMatchLabel').textContent=`MATCH ${String(data.currentMatch||1).padStart(2,'0')} · GROUP ${data.currentGroup||'A'}`;$('countdownMapLabel').textContent=data.currentMap||'ERANGEL';
  $('mapFeedMapName').textContent=data.currentMap||'ERANGEL';$('mapFeedMatch').textContent=`MATCH ${String(data.currentMatch||1).padStart(2,'0')} · GROUP ${data.currentGroup||'A'}`;
  const stateName=PREVIEW_SCENE||data.broadcastState||'live';
  const sceneChanged=lastRenderedScene!==stateName;
  if(sceneChanged){if(stateName==='results'||stateName==='overall')overallPage=0;if(stateName==='lineup')lineupPage=0;if(lastRenderedScene!==null)playCinematicTransition(stateName);}
  $('broadcast').className=`broadcast state-${stateName}`;lastRenderedScene=stateName;syncThemeMusic(data,stateName);
  $('streamStartEventName').textContent=data.tournamentName||'BGMI COLLEGE CHAMPIONSHIP';$('streamStartFormat').textContent=data.format||'TOURNAMENT SERIES';$('streamStartOrganizer').textContent=data.organizer||'ESPORTS OPERATIONS';$('formatEventSmall').textContent=data.tournamentName||'BGMI BROADCAST';$('formatName').textContent=data.format||'TOURNAMENT SERIES';$('formatOrganizer').textContent=data.organizer||'ESPORTS OPERATIONS';$('formatGroupCount').textContent=`${Math.max(1,Math.ceil((data.teams||[]).length/16))} GROUPS`;$('formatSemiSlots').textContent=`${data.qualification?.semifinalSlots||24} TEAMS`;$('formatFinalSlots').textContent=`${data.qualification?.finalSlots||16} TEAMS`;$('formatMatchMeta').textContent=`MATCH ${String(data.currentMatch||1).padStart(2,'0')} · ${data.currentGroup||'GROUP A'}`;$('streamStartMatchLabel').textContent=`MATCH ${String(data.currentMatch||1).padStart(2,'0')} · ${data.currentMap||'ERANGEL'}`;$('lineupSubtitle').textContent=`MATCH ${String(data.currentMatch||1).padStart(2,'0')} · ${data.currentGroup||'GROUP A'} · ${data.currentMap||'ERANGEL'}`;$('lineupEventMark').textContent=data.tournamentName||'BGMI ESPORTS';
  const logoUrl=data.production?.eventLogoUrl||'';setImage('streamEventLogo','streamLogoFallback',logoUrl,initials(data.tournamentName||'BG'));
  const prod=data.production||{};const phase=String(data.currentGroup||'A');const automaticGroup=/^[A-F]$/.test(phase)?`GROUP ${phase}`:phase;
  $('liveInfoStage').textContent=`${prod.broadcastStageLabel||'GROUP STAGE'} // ${prod.broadcastDayLabel||'DAY 1'}`;$('liveInfoDay').textContent=prod.broadcastDayLabel||'DAY 1';$('liveInfoGroup').textContent=prod.broadcastGroupLabel||automaticGroup;$('liveInfoMatch').textContent=String(data.currentMatch||1).padStart(2,'0');$('liveInfoCaption').textContent=prod.broadcastMatchCaption||`${data.currentMap||'ERANGEL'}`;$('liveInfoEvent').textContent=data.tournamentName||'BGMI COLLEGE CHAMPIONSHIP';$('liveInfoMap').textContent=data.currentMap||'ERANGEL';$('liveInfoFooter').textContent=`${(data.matchTeamIds||[]).length||16} SQUADS IN PLAY`;setImage('liveInfoLogo','liveInfoLogoFallback',logoUrl,initials(data.tournamentName||'BG'));$('fragLeadersEvent').textContent=data.tournamentName||'BGMI BROADCAST';$('fragLeadersSubline').textContent=`OVERALL LEADERS · THROUGH MATCH ${String(data.currentMatch||1).padStart(2,'0')}`;
  $('cardKicker').textContent=`${String(data.format||'TOURNAMENT SERIES').toUpperCase()} // DAY 01`;$('cardSubline').textContent=stateName==='overall'?`OVERALL AFTER MATCH ${String(data.currentMatch||1).padStart(2,'0')}`:`MATCH ${String(data.currentMatch||1).padStart(2,'0')} · GROUP ${data.currentGroup||'A'} · ${data.currentMap||'ERANGEL'}`;
  $('cardTitle').textContent=stateName==='overall'?'OVERALL STANDINGS':stateName==='results'?'POINTS STANDINGS':'STANDINGS';$('intermissionTitle').textContent=stateName==='pre-show'?'COMING UP NEXT':'MATCH BREAK';
  const ids=new Set(Array.isArray(data.matchTeamIds)?data.matchTeamIds:[]);
  const currentLineup=(ids.size?[...ids].map(id=>(data.teams||[]).find(t=>Number(t.id)===Number(id))).filter(Boolean):(data.teams||[]).filter(t=>String(t.group||'A')===String(data.currentGroup||'A'))).slice(0,16);
  const current=[...currentLineup].sort((a,b)=>b.matchPoints-a.matchPoints||b.kills-a.kills||(a.placement||99)-(b.placement||99));
  renderLineup(data,currentLineup);
  renderLiveScoreboard(data);
  const overall=scoreOverallTeams(data).slice(0,16);
  const currentSorted=[...current].sort((a,b)=>{
    if(stateName==='results'){
      const ap=Number(a.placement)||999,bp=Number(b.placement)||999;
      return ap-bp||b.kills-a.kills||b.matchPoints-a.matchPoints;
    }
    return b.matchPoints-a.matchPoints||b.kills-a.kills||(Number(a.placement)||999)-(Number(b.placement)||999);
  });
  const isOverall=stateName==='overall';
  const sourceRows=isOverall?overall:currentSorted;
  // Overall standings show every squad at once: 01-08 in the left table, 09-16 in the right.
  // The results card shares the screen with the winner panel, so it keeps its 8-row rotation.
  const shown=sourceRows.slice(0,16);
  const splitTables=isOverall&&shown.length>8;
  const pageCount=Math.max(1,Math.ceil(shown.length/8));
  if(!splitTables)overallPage=overallPage%pageCount;
  const leftRows=splitTables?shown.slice(0,8):shown.slice(overallPage*8,overallPage*8+8);
  const rightRows=splitTables?shown.slice(8,16):[];
  const root=$('fullRows'),rightRoot=$('fullRowsRight');
  root.replaceChildren();
  if(rightRoot)rightRoot.replaceChildren();
  const columnsRoot=$('fullColumns'),rightHalf=$('fullHalfRight');
  if(columnsRoot)columnsRoot.classList.toggle('single',!splitTables);
  if(rightHalf)rightHalf.classList.toggle('hidden',!splitTables);
  const buildRow=(team,index,container)=>{
    const row=document.createElement('div');row.className='full-row';row.dataset.group=String(team.group||'A');
    const rank=document.createElement('span');rank.className=`standings-rank ${groupClass(team.group)}`;rank.textContent=String((isOverall?index+1:(Number(team.placement)||index+1))).padStart(2,'0');
    const teamCell=document.createElement('div');teamCell.className='standings-team-cell';
    const logo=document.createElement('span');logo.className=`standings-team-logo${team.logo?'':' empty'}`;if(team.logo)setTeamLogo(logo,team.logo,team.name);
    const teamCopy=document.createElement('span');teamCopy.className='standings-team-copy';const teamName=document.createElement('b');teamName.className='team';teamName.textContent=team.name;const teamMeta=document.createElement('small');teamMeta.textContent=`GROUP ${team.group||'A'}${team.registered?' · REGISTERED':' · ROSTER SLOT'}`;teamCopy.append(teamName,teamMeta);teamCell.append(logo,teamCopy);
    const wins=document.createElement('span');wins.className='num win-count';wins.textContent=String(isOverall?(team.overallWins||0):(Number(team.placement)===1?1:0)).padStart(2,'0');
    const matches=document.createElement('span');matches.className='num';matches.textContent=String(isOverall?(team.overallMatches||0):1).padStart(2,'0');
    const finishes=document.createElement('span');finishes.className='num';finishes.textContent=String(isOverall?(team.overallFinishes||0):(team.kills||0)).padStart(2,'0');
    const finishPoint=Math.max(0,Number(data.scoringRules?.finishPoint)||1);
    const positionPts=document.createElement('span');positionPts.className='num';positionPts.textContent=String(isOverall?(team.overallPlacementPoints||0):Math.max(0,(Number(team.matchPoints)||0)-(Number(team.kills)||0)*finishPoint)).padStart(2,'0');
    const totalPts=document.createElement('span');totalPts.className='num total-points';totalPts.textContent=String(isOverall?(team.overallPoints||0):(team.matchPoints||0)).padStart(3,'0');
    row.append(rank,teamCell,wins,matches,finishes,positionPts,totalPts);container.append(row);
  };
  leftRows.forEach((team,localIndex)=>buildRow(team,splitTables?localIndex:overallPage*8+localIndex,root));
  rightRows.forEach((team,index)=>buildRow(team,index+8,rightRoot));
  const pad2=n=>String(n).padStart(2,'0');
  const from=shown.length?(splitTables?1:overallPage*8+1):0;
  const to=shown.length?(splitTables?shown.length:Math.min(overallPage*8+8,shown.length)):0;
  $('fullPageReadout').textContent=shown.length?`TEAMS ${pad2(from)}–${pad2(to)} / ${pad2(shown.length)}`:'TEAMS 00 / 00';
  $('cardPageKicker').textContent=splitTables?`TACTICAL DATA GRID // LEFT 01–08 · RIGHT 09–${pad2(shown.length)}`:`${isOverall?'TACTICAL DATA GRID':'MATCH DATA GRID'} // TABLE ${pad2(overallPage+1)} OF ${pad2(pageCount)}`;
  $('standingsUnit').textContent=shown.length?`${pad2(from)}_${pad2(to)}`:'00_00';
  $('fullCardFootLeft').textContent=isOverall?'OVERALL LEADERBOARD // ALL 16 TEAMS · ONE PAGE':'MATCH POINTS // VERIFIED RESULTS';
  $('lineupPageReadout').textContent='DROP SEQUENCE READY';
  if(slideTransitionTriggered){animatePageSwap(root);animatePageSwap($('lineupTeams'));slideTransitionTriggered=false;}
  renderTopFragger(data);renderProduction(data);renderMapFeed(data);renderFragLeaders(data);renderWinnerPanel(data);tickCountdown();tickStreamStart();
}
function renderLineup(data,current){
  const root=$('lineupTeams');root.replaceChildren();
  const allTeams=current.slice(0,16);
  allTeams.forEach((team,index)=>{
    const card=document.createElement('article');card.className='lineup-roster-card';card.dataset.group=String(team.group||'A');card.dataset.column=index<8?'left':'right';
    const rank=document.createElement('span');rank.className=`lineup-rank ${groupClass(team.group)}`;rank.textContent=String(index+1).padStart(2,'0');
    const logo=document.createElement('span');logo.className=`lineup-team-logo${team.logo?'':' empty'}`;if(team.logo)setTeamLogo(logo,team.logo,team.name);
    const copy=document.createElement('div');copy.className='lineup-team-copy';
    const name=document.createElement('b');name.textContent=team.name;
    const meta=document.createElement('small');meta.textContent=`GROUP ${team.group||'A'} · ${team.registered?'REGISTERED SQUAD':'TEAM SLOT '+String(team.id).padStart(2,'0')}`;
    copy.append(name,meta);card.append(rank,logo,copy);root.append(card);
  });
  $('lineupTeamTotal').textContent=`${allTeams.length} SQUADS LOCKED`;
  $('lineupPageReadout').textContent='DROP SEQUENCE READY';
}
function renderFragLeaders(data){
  const root=$('fragLeaderList');root.replaceChildren();
  const leaders=(data.playerStats?.overallLeaders||data.overallFraggers||[]).slice().sort((a,b)=>(Number(b.kills)||0)-(Number(a.kills)||0)||(Number(b.damage)||0)-(Number(a.damage)||0)).slice(0,5);
  while(leaders.length<5)leaders.push({playerName:'AWAITING FRAGS',teamName:'—',kills:0,damage:0,avatarUrl:'',teamLogo:'',placeholder:true});
  leaders.forEach((player,index)=>{
    const row=document.createElement('article');row.className='frag-leader-row';row.dataset.rank=index+1;
    const rank=document.createElement('span');rank.className='frag-leader-rank';rank.textContent=String(index+1).padStart(2,'0');
    const avatar=document.createElement('span');avatar.className='frag-leader-avatar';
    if(player.avatarUrl){const img=document.createElement('img');img.src=player.avatarUrl;img.alt=player.playerName;img.onerror=()=>{img.remove();avatar.textContent=initials(player.playerName)};avatar.append(img)}else{avatar.textContent=player.placeholder?'—':initials(player.playerName);if(!player.placeholder)avatar.classList.add('squad-art-fallback')}
    const copy=document.createElement('div');copy.className='frag-leader-copy';const name=document.createElement('b');name.textContent=player.playerName||'UNKNOWN PLAYER';const team=document.createElement('span');team.className='frag-leader-team';const logo=document.createElement('span');logo.className='frag-leader-logo';setTeamLogo(logo,player.teamLogo,player.teamName||'TEAM');const teamName=document.createElement('small');teamName.textContent=player.teamName||'TEAM NOT ASSIGNED';team.append(logo,teamName);copy.append(name,team);
    const kills=document.createElement('div');kills.className='frag-leader-stat';kills.innerHTML=`<b>${Number(player.kills)||0}</b><small>FINISHES</small>`;
    const damage=document.createElement('div');damage.className='frag-leader-stat';damage.innerHTML=`<b>${Number(player.damage)||0}</b><small>DAMAGE</small>`;
    row.append(rank,avatar,copy,kills,damage);root.append(row);
  });
}
function currentWinner(data){
  const matchNo=Number(data.currentMatch)||1, group=String(data.currentGroup||'A');
  const records=(data.matchHistory||[]).filter(m=>Number(m.matchNumber)===matchNo&&String(m.group||'A')===group);
  const latest=records[records.length-1];
  if(latest){const result=(latest.results||[]).find(r=>Number(r.placement)===1);if(result)return {...(data.teams||[]).find(t=>Number(t.id)===Number(result.teamId)),...result,players:result.players||[]}}
  const winner=(data.teams||[]).find(t=>Number(t.placement)===1&&((data.matchTeamIds||[]).map(Number).includes(Number(t.id))));
  return winner||null;
}
function renderWinnerPanel(data){
  const team=currentWinner(data),root=$('winnerPlayers');root.replaceChildren();
  $('winnerMatchMeta').textContent=`MATCH ${String(data.currentMatch||1).padStart(2,'0')} · ${String(data.currentGroup||'A')}`;
  if(!team){$('winnerTeamName').textContent='AWAITING VERIFIED WINNER';$('winnerTeamGroup').textContent='Finish the match and enter the final placements.';$('winnerTotalFinishes').textContent='—';$('winnerTotalDamage').textContent='—';$('winnerTotalPoints').textContent='—';$('winnerFooterLeft').textContent='BATTLEGROUNDS · MATCH WINNER';$('winnerFooterRight').textContent='RESULTS DESK';$('winnerTeamLogo').removeAttribute('src');$('winnerTeamLogo').classList.add('hidden');$('winnerTeamLogoFallback').classList.remove('hidden');$('winnerTeamLogoFallback').textContent='WIN';return;}
  const players=(team.players||[]).slice(0,4);while(players.length<4)players.push({name:`PLAYER ${players.length+1}`,kills:0,damage:0,avatarUrl:''});
  const totalDamage=players.reduce((sum,p)=>sum+Math.max(0,Number(p.damage)||0),0);
  $('winnerTeamName').textContent=team.teamName||team.name||'WINNING SQUAD';$('winnerTeamGroup').textContent=`GROUP ${team.group||'A'} · CHICKEN DINNER`;$('winnerTotalFinishes').textContent=String(Number(team.kills)||players.reduce((sum,p)=>sum+(Number(p.kills)||0),0));$('winnerTotalDamage').textContent=totalDamage.toLocaleString('en-US');$('winnerTotalPoints').textContent=String(Number(team.matchPoints)||0);$('winnerFooterLeft').textContent=`${data.tournamentName||'BGMI BROADCAST'} · MATCH WINNER`;$('winnerFooterRight').textContent=`${Number(team.placement)===1?'PLACEMENT 1':'WINNER SPOTLIGHT'}`;
  if(team.teamLogo||team.logo){$('winnerTeamLogo').src=team.teamLogo||team.logo;$('winnerTeamLogo').classList.remove('hidden');$('winnerTeamLogoFallback').classList.add('hidden')}else{$('winnerTeamLogo').removeAttribute('src');$('winnerTeamLogo').classList.add('hidden');$('winnerTeamLogoFallback').classList.remove('hidden');$('winnerTeamLogoFallback').textContent=initials(team.teamName||team.name||'WIN')}
  players.forEach((player,index)=>{
    const card=document.createElement('article');card.className='winner-player-card';
    const photo=document.createElement('div');photo.className='winner-player-photo';
    if(player.avatarUrl){const img=document.createElement('img');img.src=player.avatarUrl;img.alt=player.name||`Player ${index+1}`;img.onerror=()=>{img.remove();photo.classList.add('squad-art-fallback');photo.textContent=initials(player.name)};photo.append(img)}else{photo.classList.add('squad-art-fallback',`operator-crop-${index+1}`);photo.setAttribute('aria-label','Fictional tactical operator fallback')}
    const info=document.createElement('div');info.className='winner-player-info';const n=document.createElement('b');n.textContent=player.name||`PLAYER ${index+1}`;const meta=document.createElement('small');meta.textContent=`PLAYER ${String(index+1).padStart(2,'0')}`;info.append(n,meta);
    const stats=document.createElement('div');stats.className='winner-player-stats';stats.innerHTML=`<span><small>FIN</small><b>${Number(player.kills)||0}</b></span><span><small>DMG</small><b>${(Number(player.damage)||0).toLocaleString('en-US')}</b></span>`;
    card.append(photo,info,stats);root.append(card);
  });
}
function renderTopFragger(data){const player=data.playerStats?.overallTopFragger;if(!player||!player.kills){$('topFragger').classList.add('empty');$('topFraggerName').textContent='Awaiting frags';$('topFraggerTeam').textContent='OVERALL LEADERBOARD';$('topFraggerKills').textContent='0';setImage('topFraggerPhoto','topFraggerInitials','', '•');setTeamLogo($('topFraggerTeamLogo'),'','TEAM');return;}$('topFragger').classList.remove('empty');$('topFraggerName').textContent=player.playerName;$('topFraggerTeam').textContent=player.teamName;$('topFraggerKills').textContent=player.kills;setImage('topFraggerPhoto','topFraggerInitials',player.avatarUrl,initials(player.playerName));setTeamLogo($('topFraggerTeamLogo'),player.teamLogo,player.teamName);}
function renderProduction(data){const prod=data.production||{};const caster=prod.caster||{};$('casterName').textContent=caster.name||'MAIN CASTER';$('casterTagline').textContent=caster.tagline||'THE BATTLE STARTS NOW';setImage('casterPhoto','casterInitials',caster.imageUrl,initials(caster.name||'MC'));const mode=prod.mvpMode==='overall'?'overall':'match';const player=mode==='overall'?data.playerStats?.overallTopFragger:data.playerStats?.matchMvp;const team=(data.teams||[]).find(t=>t.id===player?.teamId);$('mvpEyebrow').textContent=mode==='overall'?'OVERALL TOP FRAGGER':'CURRENT MATCH MVP';$('mvpOverline').textContent=mode==='overall'?'TOURNAMENT FRAG LEADER':'MOST VALUABLE PLAYER';$('mvpModeLabel').textContent=mode==='overall'?'OVERALL LEADERBOARD':'CURRENT MATCH MVP';$('mvpName').textContent=player?.playerName||'AWAITING FRAGS';$('mvpTeam').textContent=player?.teamName||'Player spotlight';$('mvpKills').textContent=player?.kills||0;$('mvpMatches').textContent=`MATCH ${String(data.currentMatch||1).padStart(2,'0')}`;setImage('mvpPhoto','mvpInitials',player?.avatarUrl,initials(player?.playerName||'MVP'));const logo=$('mvpTeamLogo');if(player?.teamLogo||team?.logo){logo.src=player?.teamLogo||team?.logo;logo.classList.remove('hidden');logo.onerror=()=>logo.classList.add('hidden')}else{logo.removeAttribute('src');logo.classList.add('hidden')}}
function renderMapFeed(data){const url=data.production?.mapFeed?.imageUrl;const img=$('mapFeedImage'),placeholder=$('mapPlaceholder');if(url){img.onerror=()=>{img.classList.add('hidden');placeholder.classList.remove('hidden')};img.src=url;img.classList.remove('hidden');placeholder.classList.add('hidden')}else{img.removeAttribute('src');img.classList.add('hidden');placeholder.classList.remove('hidden')}}
function tickCountdown(){if(!lastState)return;const end=Number(lastState.production?.countdownEndsAt)||0;const remain=end?Math.max(0,Math.ceil((end-Date.now())/1000)):0;$('countdownClock').textContent=String(remain).padStart(2,'0');$('countdownClock').classList.toggle('final-seconds',remain>0&&remain<=5);$('matchCountdownCornerClock').textContent=`00:${String(remain).padStart(2,'0')}`;$('matchCountdownCornerClock').classList.toggle('final-seconds',remain>0&&remain<=5);$('matchCountdownCornerLabel').textContent=`MATCH ${String(lastState.currentMatch||1).padStart(2,'0')} · ${lastState.currentMap||'ERANGEL'}`;}
function tickStreamStart(){if(!lastState)return;const end=Number(lastState.production?.streamStartEndsAt)||0;const remain=end?Math.max(0,Math.ceil((end-Date.now())/1000)):Math.max(0,Number(lastState.production?.streamStartDurationSeconds)||1200);const mins=Math.floor(remain/60),secs=remain%60;$('streamStartClock').textContent=`${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;$('streamStartClock').classList.toggle('final-seconds',remain>0&&remain<=60);}
setInterval(()=>{tickCountdown();tickStreamStart()},200);

// The results card still rotates 01-08 / 09-16 beside the winner panel;
// the overall standings table shows all 16 squads at once, so it never rotates.
setInterval(()=>{
  if(!lastState)return;
  if(lastState.broadcastState!=='results')return;
  const total=(lastState.matchTeamIds||[]).length||16;
  if(total>8){overallPage=(overallPage+1)%Math.max(2,Math.ceil(total/8));slideTransitionTriggered=true;render(lastState);}
},8500);
