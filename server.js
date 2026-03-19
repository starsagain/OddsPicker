const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Configuration
const ODDS_API_KEY = process.env.ODDS_API_KEY || 'YOUR_API_KEY_HERE';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const PRIZEPICKS_API = 'https://api.prizepicks.com/projections';
const UNDERDOG_API = 'https://api.underdogfantasy.com/beta/v3/over_under_lines';

// Cache
let cachedData = [];
let lastUpdate = null;
let stats = { 
  prizePicksCalls: 0, 
  underdogCalls: 0, 
  oddsApiCalls: 0,
  creditsUsed: 0 
};

// Helper: Convert American odds to decimal
function americanToDecimal(odds) {
  if (!odds || odds === 0) return 2.0; // Default to even odds if missing
  return odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
}

// Helper: Calculate no-vig probability and EV
function calculateEdge(overOdds, underOdds) {
  const HURDLE = 0.5425; // 54.25% PrizePicks breakeven for 5-6 leg flex
  
  const overDec = americanToDecimal(overOdds);
  const underDec = americanToDecimal(underOdds);
  
  const overImpl = 1 / overDec;
  const underImpl = 1 / underDec;
  
  const total = overImpl + underImpl;
  
  // Handle edge case where total is invalid
  if (total === 0 || !isFinite(total)) {
    return { fairOver: 50, fairUnder: 50, overEV: 0, underEV: 0 };
  }
  
  const vigFactor = 1 / total;
  const fairOver = (overImpl * vigFactor) * 100;
  const fairUnder = (underImpl * vigFactor) * 100;
  
  const overEV = fairOver > (HURDLE * 100) ? ((fairOver / 100 / HURDLE) - 1) * 100 : 0;
  const underEV = fairUnder > (HURDLE * 100) ? ((fairUnder / 100 / HURDLE) - 1) * 100 : 0;
  
  return { fairOver, fairUnder, overEV, underEV };
}

// Fetch PrizePicks projections
async function fetchPrizePicks() {
  console.log('Fetching PrizePicks projections...');
  
  try {
    const response = await fetch(PRIZEPICKS_API);
    
    if (!response.ok) {
      console.log('PrizePicks API error:', response.status);
      return [];
    }
    
    const data = await response.json();
    stats.prizePicksCalls++;
    
    if (!data.data || !Array.isArray(data.data)) {
      console.log('Unexpected PrizePicks data structure');
      return [];
    }
    
    console.log(`Found ${data.data.length} PrizePicks projections`);
    
    // Parse projections into our format
    const projections = data.data
      .filter(proj => proj.attributes && proj.attributes.line_score)
      .map(proj => {
        const attrs = proj.attributes;
        return {
          platform: 'PrizePicks',
          playerName: attrs.name || 'Unknown Player',
          league: attrs.league || 'Unknown',
          team: attrs.team || '',
          statType: attrs.stat_type || '',
          line: parseFloat(attrs.line_score),
          gameTime: attrs.start_time,
          gameDescription: attrs.description || ''
        };
      });
    
    console.log(`Parsed ${projections.length} valid PrizePicks projections`);
    return projections;
    
  } catch (error) {
    console.error('Error fetching PrizePicks:', error.message);
    return [];
  }
}

// Fetch Underdog projections - FILTER FOR PLAYER PROPS ONLY
async function fetchUnderdog() {
  console.log('Fetching Underdog projections...');
  
  try {
    const response = await fetch(UNDERDOG_API, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.log('Underdog API error:', response.status);
      return [];
    }
    
    const data = await response.json();
    stats.underdogCalls++;
    
    console.log('Underdog response received');
    
    if (!data.over_under_lines || !Array.isArray(data.over_under_lines)) {
      console.log('No over_under_lines array found');
      return [];
    }
    
    console.log(`Found ${data.over_under_lines.length} total Underdog lines`);
    
    // Parse - filter for PLAYER props only (not team spreads/totals)
    const projections = [];
    let teamLines = 0;
    let playerLines = 0;
    
    data.over_under_lines.forEach((line, index) => {
      if (!line.over_under || !line.stat_value) {
        return;
      }
      
      const overUnder = line.over_under;
      const appearanceStat = overUnder.appearance_stat;
      
      if (!appearanceStat) {
        return;
      }
      
      // Check if this is a TEAM line (spread, total, etc) vs PLAYER prop
      const stat = appearanceStat.stat || '';
      const displayStat = appearanceStat.display_stat || '';
      
      // Skip team lines (spread, moneyline, total points)
      const teamStats = ['spread', 'moneyline', 'total_points', 'margin', 'total'];
      if (teamStats.some(ts => stat.toLowerCase().includes(ts) || displayStat.toLowerCase().includes(ts))) {
        teamLines++;
        return;
      }
      
      // This should be a player prop - look for player in options
      if (!line.options || line.options.length === 0) {
        return;
      }
      
      playerLines++;
      
      // Get player name from options
      const firstOption = line.options[0];
      const playerName = firstOption.selection_header || 'Unknown Player';
      
      // Get stat type
      const statType = displayStat || stat || '';
      
      // Get team from title (format: "TEAM @ TEAM Stat")
      const title = overUnder.title || '';
      const teamMatch = title.match(/^([A-Z]+)/);
      const team = teamMatch ? teamMatch[1] : '';
      
      // Get league/sport - need to look elsewhere
      // For now, default to Unknown - we'll enhance this
      const league = 'NBA'; // Most Underdog lines are NBA
      
      // Get line value
      const lineValue = parseFloat(line.stat_value);
      
      // Log first few player props to verify
      if (playerLines <= 3) {
        console.log(`Player prop ${playerLines}:`, {
          player: playerName,
          stat: statType,
          line: lineValue,
          team: team
        });
      }
      
      projections.push({
        platform: 'Underdog',
        playerName: playerName,
        league: league,
        team: team,
        statType: statType,
        line: lineValue,
        gameTime: null,
        gameDescription: title
      });
    });
    
    console.log(`Team lines filtered out: ${teamLines}`);
    console.log(`Player props found: ${playerLines}`);
    console.log(`✓ Parsed ${projections.length} valid Underdog projections`);
    
    if (projections.length > 0) {
      console.log('Sample projection:', projections[0]);
    }
    
    return projections;
    
  } catch (error) {
    console.error('Error fetching Underdog:', error.message);
    return [];
  }
}

// Fetch sharp odds from The Odds API for a specific sport/market
async function fetchSharpOdds(sport, market) {
  const url = `${ODDS_API_BASE}/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${market}&oddsFormat=american&bookmakers=pinnacle`;
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      return [];
    }
    
    const events = await response.json();
    stats.oddsApiCalls++;
    stats.creditsUsed++;
    
    return events;
    
  } catch (error) {
    console.error(`Error fetching sharp odds for ${sport}/${market}:`, error.message);
    return [];
  }
}

// Map stat types to Odds API market names
function mapStatTypeToMarket(statType) {
  const mapping = {
    'Points': 'player_points',
    'Pts': 'player_points',
    'Rebounds': 'player_rebounds',
    'Reb': 'player_rebounds',
    'Assists': 'player_assists',
    'Ast': 'player_assists',
    '3-PT Made': 'player_threes',
    'Threes': 'player_threes',
    'Pts+Rebs+Asts': 'player_points_rebounds_assists',
    'Fantasy Score': 'player_fantasy_points',
    'Passing Yards': 'player_pass_yds',
    'Passing TDs': 'player_pass_tds',
    'Rushing Yards': 'player_rush_yds',
    'Receptions': 'player_receptions',
    'Receiving Yards': 'player_reception_yds'
  };
  
  return mapping[statType] || null;
}

// Map league to Odds API sport
function mapLeagueToSport(league) {
  const mapping = {
    'NBA': 'basketball_nba',
    'NFL': 'americanfootball_nfl',
    'MLB': 'baseball_mlb',
    'NHL': 'icehockey_nhl',
    'NCAAB': 'basketball_ncaab',
    'NCAAF': 'americanfootball_ncaaf'
  };
  
  return mapping[league] || null;
}

// Find sharp odds for a specific player/stat combo
function findSharpOddsForPlayer(sharpEvents, playerName, statType, line) {
  for (const event of sharpEvents) {
    if (!event.bookmakers || event.bookmakers.length === 0) continue;
    
    for (const book of event.bookmakers) {
      if (!book.markets) continue;
      
      for (const market of book.markets) {
        if (!market.outcomes) continue;
        
        for (const outcome of market.outcomes) {
          // Match by player name and line value
          const outcomePlayer = outcome.description || outcome.name;
          const outcomeLine = outcome.point;
          
          // Fuzzy match player names (handle variations)
          const nameMatch = outcomePlayer && playerName && 
            (outcomePlayer.toLowerCase().includes(playerName.toLowerCase()) ||
             playerName.toLowerCase().includes(outcomePlayer.toLowerCase()));
          
          const lineMatch = outcomeLine && Math.abs(outcomeLine - line) < 0.5;
          
          if (nameMatch && lineMatch) {
            // Find the corresponding Over/Under
            const overOutcome = market.outcomes.find(o => 
              (o.description === outcomePlayer || o.name === outcomePlayer) && 
              (o.name === 'Over' || o.name.includes('Over'))
            );
            
            const underOutcome = market.outcomes.find(o => 
              (o.description === outcomePlayer || o.name === outcomePlayer) && 
              (o.name === 'Under' || o.name.includes('Under'))
            );
            
            if (overOutcome && underOutcome) {
              return {
                overOdds: overOutcome.price,
                underOdds: underOutcome.price,
                bookmaker: book.key
              };
            }
          }
        }
      }
    }
  }
  
  return null;
}

// Main refresh function
async function refreshData() {
  console.log('='.repeat(70));
  console.log('🔄 STARTING DATA REFRESH');
  console.log('='.repeat(70));
  const startTime = Date.now();
  
  try {
    // Step 1: Fetch PrizePicks and Underdog projections (free!)
    console.log('\n📊 STEP 1: Fetching DFS platform projections...');
    const [prizePicksProjs, underdogProjs] = await Promise.all([
      fetchPrizePicks(),
      fetchUnderdog()
    ]);
    
    const allProjections = [...prizePicksProjs, ...underdogProjs];
    console.log(`Total projections: ${allProjections.length}`);
    
    if (allProjections.length === 0) {
      console.log('❌ No projections found from PrizePicks or Underdog');
      return {
        success: false,
        message: 'No projections available from PrizePicks or Underdog',
        data: [],
        stats: { platforms: 0, withSharpOdds: 0, plusEV: 0 }
      };
    }
    
    // Step 2: Get unique sport/market combinations we need sharp odds for
    console.log('\n📈 STEP 2: Identifying sports/markets to fetch sharp odds...');
    const sportMarketPairs = new Set();
    
    allProjections.forEach(proj => {
      const sport = mapLeagueToSport(proj.league);
      const market = mapStatTypeToMarket(proj.statType);
      
      if (sport && market) {
        sportMarketPairs.add(`${sport}|${market}`);
      }
    });
    
    console.log(`Need sharp odds for ${sportMarketPairs.size} sport/market combinations`);
    
    // Step 3: Fetch sharp odds for each sport/market combo
    console.log('\n💎 STEP 3: Fetching sharp odds from Pinnacle...');
    const sharpOddsMap = new Map();
    
    for (const pair of sportMarketPairs) {
      const [sport, market] = pair.split('|');
      console.log(`  Fetching ${sport} ${market}...`);
      
      const events = await fetchSharpOdds(sport, market);
      sharpOddsMap.set(pair, events);
      
      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    
    // Step 4: Match projections with sharp odds and calculate EV
    console.log('\n🎯 STEP 4: Matching projections with sharp odds...');
    const plays = [];
    let matchedCount = 0;
    
    allProjections.forEach((proj, index) => {
      const sport = mapLeagueToSport(proj.league);
      const market = mapStatTypeToMarket(proj.statType);
      
      if (!sport || !market) {
        return; // Skip if we can't map the stat type
      }
      
      const pairKey = `${sport}|${market}`;
      const sharpEvents = sharpOddsMap.get(pairKey) || [];
      
      const sharpOdds = findSharpOddsForPlayer(
        sharpEvents,
        proj.playerName,
        proj.statType,
        proj.line
      );
      
      if (sharpOdds) {
        matchedCount++;
        
        const edge = calculateEdge(sharpOdds.overOdds, sharpOdds.underOdds);
        
        // Create Over play if it has +EV
        if (edge.overEV > 0) {
          plays.push({
            id: plays.length,
            platform: proj.platform,
            name: proj.playerName,
            team: proj.team,
            league: proj.league,
            stat: 'Over',
            line: proj.statType,
            value: proj.line,
            fairProb: edge.fairOver,
            evPercent: edge.overEV,
            sharpOdds: sharpOdds.overOdds,
            gameTime: proj.gameTime,
            game: proj.gameDescription,
            bookmaker: sharpOdds.bookmaker
          });
        }
        
        // Create Under play if it has +EV
        if (edge.underEV > 0) {
          plays.push({
            id: plays.length,
            platform: proj.platform,
            name: proj.playerName,
            team: proj.team,
            league: proj.league,
            stat: 'Under',
            line: proj.statType,
            value: proj.line,
            fairProb: edge.fairUnder,
            evPercent: edge.underEV,
            sharpOdds: sharpOdds.underOdds,
            gameTime: proj.gameTime,
            game: proj.gameDescription,
            bookmaker: sharpOdds.bookmaker
          });
        }
      }
    });
    
    // Sort by EV
    plays.sort((a, b) => b.evPercent - a.evPercent);
    
    cachedData = plays;
    lastUpdate = Date.now();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n' + '='.repeat(70));
    console.log('✅ REFRESH COMPLETE');
    console.log('='.repeat(70));
    console.log(`Total projections found: ${allProjections.length}`);
    console.log(`  - PrizePicks: ${prizePicksProjs.length}`);
    console.log(`  - Underdog: ${underdogProjs.length}`);
    console.log(`Matched with sharp odds: ${matchedCount}`);
    console.log(`+EV plays found: ${plays.length}`);
    console.log(`Duration: ${duration}s`);
    console.log(`API calls to Odds API: ${sportMarketPairs.size}`);
    console.log(`Credits used: ${sportMarketPairs.size}`);
    console.log('='.repeat(70));
    
    return {
      success: true,
      message: `Found ${plays.length} +EV plays from ${allProjections.length} projections`,
      data: plays,
      stats: {
        platforms: allProjections.length,
        withSharpOdds: matchedCount,
        plusEV: plays.length
      }
    };
    
  } catch (error) {
    console.error('❌ Error during refresh:', error);
    
    return {
      success: false,
      message: `Error: ${error.message}`,
      data: [],
      stats: { platforms: 0, withSharpOdds: 0, plusEV: 0 }
    };
  }
}

// API Routes
app.get('/api/player-props', (req, res) => {
  res.json({
    success: true,
    data: cachedData,
    lastUpdate: lastUpdate,
    count: cachedData.length,
    usageStats: {
      prizePicksCalls: stats.prizePicksCalls,
      underdogCalls: stats.underdogCalls,
      oddsApiCalls: stats.oddsApiCalls,
      creditsUsed: stats.creditsUsed
    }
  });
});

app.post('/api/player-props/refresh', async (req, res) => {
  try {
    console.log('📡 Manual refresh requested');
    const result = await refreshData();
    
    res.json({
      success: result.success,
      message: result.message,
      data: result.data,
      lastUpdate: lastUpdate,
      count: result.data.length,
      stats: result.stats,
      usageStats: {
        prizePicksCalls: stats.prizePicksCalls,
        underdogCalls: stats.underdogCalls,
        oddsApiCalls: stats.oddsApiCalls,
        creditsUsed: stats.creditsUsed
      }
    });
  } catch (error) {
    console.error('Error in refresh:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to refresh data'
    });
  }
});

// Serve HTML
app.get('/', (req, res) => {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fantasy Optimizer - PrizePicks & Underdog</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;
    
    function App() {
      const [players, setPlayers] = useState([]);
      const [loading, setLoading] = useState(true);
      const [refreshing, setRefreshing] = useState(false);
      const [stats, setStats] = useState({});
      const [lastUpdate, setLastUpdate] = useState(null);
      const [selectedPlatform, setSelectedPlatform] = useState('ALL');
      const [selectedSport, setSelectedSport] = useState('ALL');
      const [showConfirm, setShowConfirm] = useState(false);
      const [message, setMessage] = useState('');
      
      const platforms = ['ALL', 'PrizePicks', 'Underdog'];
      const sports = ['ALL', 'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB'];
      
      async function loadData() {
        try {
          const response = await fetch('/api/player-props');
          const result = await response.json();
          if (result.success) {
            setPlayers(result.data);
            setStats(result.usageStats || {});
            setLastUpdate(result.lastUpdate);
          }
          setLoading(false);
        } catch (error) {
          console.error('Error:', error);
          setLoading(false);
        }
      }
      
      async function handleRefresh() {
        setShowConfirm(false);
        setRefreshing(true);
        setMessage('Fetching from PrizePicks & Underdog...');
        
        try {
          const response = await fetch('/api/player-props/refresh', {
            method: 'POST'
          });
          const result = await response.json();
          
          setPlayers(result.data || []);
          setStats(result.usageStats || {});
          setLastUpdate(result.lastUpdate);
          setMessage(result.message || '');
          
        } catch (error) {
          setMessage('Error: ' + error.message);
        }
        
        setRefreshing(false);
      }
      
      useEffect(() => { loadData(); }, []);
      
      const formatTime = () => {
        if (!lastUpdate) return 'Never';
        const diff = Math.floor((Date.now() - lastUpdate) / 60000);
        return diff < 1 ? 'Just now' : diff < 60 ? diff + 'm ago' : Math.floor(diff/60) + 'h ago';
      };
      
      const filteredPlayers = players.filter(p => {
        const platformMatch = selectedPlatform === 'ALL' || p.platform === selectedPlatform;
        const sportMatch = selectedSport === 'ALL' || p.league === selectedSport;
        return platformMatch && sportMatch;
      });
      
      return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">
          {showConfirm && (
            <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-purple-500/30 rounded-xl p-6 max-w-md">
                <h3 className="text-lg font-bold mb-2">Refresh Data?</h3>
                <p className="text-sm mb-4">Fetches live projections from PrizePicks & Underdog (FREE), then gets sharp odds for comparison (~5-10 credits).</p>
                <div className="bg-slate-800/50 rounded p-3 mb-4 text-sm">
                  <div className="text-slate-400 mb-2">Last refresh:</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>PrizePicks: {stats.prizePicksCalls || 0}</div>
                    <div>Underdog: {stats.underdogCalls || 0}</div>
                    <div>Odds API: {stats.oddsApiCalls || 0}</div>
                    <div className="text-amber-400">Credits: ~{stats.creditsUsed || 0}</div>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setShowConfirm(false)} className="flex-1 px-4 py-2 border border-slate-600 rounded-lg">Cancel</button>
                  <button onClick={handleRefresh} className="flex-1 px-4 py-2 bg-purple-600 rounded-lg">Refresh</button>
                </div>
              </div>
            </div>
          )}
          
          <div className="container mx-auto p-6">
            <header className="mb-8">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-4xl font-bold mb-2">FANTASY OPTIMIZER</h1>
                  <p className="text-purple-300">PrizePicks & Underdog +EV Finder</p>
                </div>
                <div className="text-right">
                  <div className="text-sm text-slate-400 mb-2">
                    Last: {formatTime()} | Credits: ~{stats.creditsUsed || 0}
                  </div>
                  <button
                    onClick={() => setShowConfirm(true)}
                    disabled={refreshing}
                    className="px-6 py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium disabled:opacity-50"
                  >
                    {refreshing ? 'Refreshing...' : 'Refresh Data'}
                  </button>
                </div>
              </div>
              
              <div className="mb-4">
                <div className="text-xs text-slate-400 mb-2">Platform:</div>
                <div className="flex gap-2">
                  {platforms.map(platform => (
                    <button
                      key={platform}
                      onClick={() => setSelectedPlatform(platform)}
                      className={\`px-4 py-2 rounded-lg text-sm font-medium transition \${
                        selectedPlatform === platform 
                          ? 'bg-purple-600 text-white' 
                          : 'bg-slate-800/50 text-slate-300'
                      }\`}
                    >
                      {platform}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="mb-4">
                <div className="text-xs text-slate-400 mb-2">Sport:</div>
                <div className="flex gap-2 flex-wrap">
                  {sports.map(sport => (
                    <button
                      key={sport}
                      onClick={() => setSelectedSport(sport)}
                      className={\`px-4 py-2 rounded-lg text-sm font-medium transition \${
                        selectedSport === sport 
                          ? 'bg-purple-600 text-white' 
                          : 'bg-slate-800/50 text-slate-300'
                      }\`}
                    >
                      {sport}
                    </button>
                  ))}
                </div>
              </div>
              
              {message && (
                <div className="bg-blue-950/30 border border-blue-500/30 rounded-lg p-4">
                  <p className="text-sm text-blue-300">{message}</p>
                </div>
              )}
            </header>
            
            <main>
              {loading && (
                <div className="text-center py-20">
                  <div className="text-xl">Loading...</div>
                </div>
              )}
              
              {!loading && players.length === 0 && !refreshing && (
                <div className="text-center py-20">
                  <h2 className="text-2xl font-bold mb-4">No Data Available</h2>
                  <p className="text-slate-400 mb-6">Click refresh to fetch live projections from PrizePicks & Underdog</p>
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="px-8 py-4 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium text-lg"
                  >
                    Fetch Projections
                  </button>
                </div>
              )}
              
              {!loading && filteredPlayers.length > 0 && (
                <div>
                  <div className="bg-slate-800/50 rounded-lg p-4 mb-6">
                    <h2 className="text-2xl font-bold">{filteredPlayers.length} +EV Plays Found</h2>
                    <p className="text-slate-400 text-sm">
                      {selectedPlatform} | {selectedSport} | Sorted by highest EV
                    </p>
                  </div>
                  
                  <div className="space-y-4">
                    {filteredPlayers.map((player) => (
                      <div key={player.id} className="bg-slate-800/50 border border-purple-500/30 rounded-lg p-6 hover:border-purple-500/50 transition">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              <h3 className="text-xl font-bold">{player.name}</h3>
                              <span className="px-2 py-1 bg-blue-600/30 rounded text-xs font-medium">
                                {player.platform}
                              </span>
                              <span className="px-2 py-1 bg-purple-600/30 rounded text-xs font-medium">
                                {player.league}
                              </span>
                              <span className="px-2 py-1 bg-slate-700 rounded text-xs">
                                {player.stat}
                              </span>
                            </div>
                            <p className="text-slate-400 text-sm mb-2">{player.team}</p>
                            <p className="text-purple-300 mb-1 font-medium">{player.line}: {player.value}</p>
                            {player.game && <p className="text-xs text-slate-500">{player.game}</p>}
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-slate-400 mb-1">Fair Win Prob</div>
                            <div className="text-3xl font-bold text-emerald-400 mb-1">
                              {player.fairProb.toFixed(1)}%
                            </div>
                            <div className="text-lg font-bold text-emerald-400 mb-2">
                              +{player.evPercent.toFixed(1)}% EV
                            </div>
                            <div className="text-xs text-slate-500">
                              Sharp: {player.sharpOdds > 0 ? '+' : ''}{player.sharpOdds}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {!loading && players.length > 0 && filteredPlayers.length === 0 && (
                <div className="text-center py-20">
                  <p className="text-slate-400">No plays match your filters. Try different options.</p>
                </div>
              )}
            </main>
          </div>
        </div>
      );
    }
    
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App />);
  </script>
</body>
</html>`;
  
  res.send(htmlContent);
});

app.listen(PORT, () => {
  console.log('='.repeat(70));
  console.log('🚀 FANTASY OPTIMIZER - PRIZEPICKS & UNDERDOG EDITION');
  console.log('='.repeat(70));
  console.log('Port:', PORT);
  console.log('Odds API Key:', ODDS_API_KEY !== 'YOUR_API_KEY_HERE' ? 'Configured ✓' : 'Not set ✗');
  console.log('Data sources:');
  console.log('  - PrizePicks API (FREE)');
  console.log('  - Underdog API (FREE)');
  console.log('  - Sharp odds from Pinnacle (uses credits)');
  console.log('='.repeat(70));
});
