const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Configuration
const API_KEY = process.env.ODDS_API_KEY || 'YOUR_API_KEY_HERE';
const BASE_URL = 'https://api.the-odds-api.com/v4';

// Cache
let cachedData = [];
let lastUpdate = null;
let stats = { calls: 0, credits: 0 };
let lastError = null;

// Sports to fetch
const SPORTS = [
  'basketball_nba',
  'americanfootball_nfl',
  'icehockey_nhl',
  'baseball_mlb',
  'basketball_ncaab'
];

// Prop markets  
const MARKETS = [
  'player_points',
  'player_rebounds',
  'player_assists',
  'player_threes',
  'player_pass_tds',
  'player_rush_yds',
  'player_receptions'
];

// Helper: Convert American odds to decimal
function americanToDecimal(odds) {
  return odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
}

// Helper: Calculate no-vig probability and EV
function calculateEdge(overOdds, underOdds) {
  const HURDLE = 0.5425; // 54.25% PrizePicks breakeven
  
  const overDec = americanToDecimal(overOdds);
  const underDec = americanToDecimal(underOdds);
  
  const overImpl = 1 / overDec;
  const underImpl = 1 / underDec;
  
  const total = overImpl + underImpl;
  const fairOver = (overImpl / total) * 100;
  const fairUnder = (underImpl / total) * 100;
  
  const overEV = fairOver > (HURDLE * 100) ? ((fairOver / 100 / HURDLE) - 1) * 100 : 0;
  const underEV = fairUnder > (HURDLE * 100) ? ((fairUnder / 100 / HURDLE) - 1) * 100 : 0;
  
  return { fairOver, fairUnder, overEV, underEV };
}

// Fetch from Odds API - CORRECTED to use /odds endpoint
async function fetchFromAPI(sport, market) {
  // Use the /odds endpoint which includes upcoming games with odds
  const url = `${BASE_URL}/sports/${sport}/odds?apiKey=${API_KEY}&regions=us&markets=${market}&oddsFormat=american&bookmakers=draftkings,fanduel`;
  
  console.log(`Fetching ${sport} ${market}...`);
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      console.log(`API Error: ${response.status} ${response.statusText}`);
      return [];
    }
    
    const data = await response.json();
    console.log(`  Found ${data.length} upcoming games with odds`);
    return data;
    
  } catch (error) {
    console.error(`Fetch error:`, error.message);
    return [];
  }
}

// Process API data
function processData(events, sport) {
  const players = [];
  let id = 0;
  
  console.log(`Processing ${events.length} events for ${sport}...`);
  
  events.forEach(event => {
    if (!event.bookmakers || event.bookmakers.length === 0) {
      console.log(`  No bookmakers for ${event.home_team} vs ${event.away_team}`);
      return;
    }
    
    event.bookmakers.forEach(book => {
      if (!book.markets) return;
      
      book.markets.forEach(market => {
        if (!market.outcomes) return;
        
        // Group outcomes by player
        const playerMap = new Map();
        
        market.outcomes.forEach(outcome => {
          const playerName = outcome.description || outcome.name;
          const line = outcome.point;
          
          if (!playerMap.has(playerName)) {
            playerMap.set(playerName, { over: null, under: null, line: line });
          }
          
          const data = playerMap.get(playerName);
          
          // Check if this is Over or Under
          if (outcome.name === 'Over' || outcome.name.includes('Over')) {
            data.over = outcome.price;
          } else if (outcome.name === 'Under' || outcome.name.includes('Under')) {
            data.under = outcome.price;
          }
        });
        
        // Calculate edges for each player
        playerMap.forEach((data, playerName) => {
          if (data.over && data.under && data.line) {
            const edge = calculateEdge(data.over, data.under);
            
            // Only include if Over has positive EV
            if (edge.overEV > 0) {
              players.push({
                id: id++,
                name: playerName,
                team: event.home_team,
                league: sport.replace(/_/g, ' ').toUpperCase(),
                game: `${event.home_team} vs ${event.away_team}`,
                stat: 'Over',
                line: market.key.replace('player_', '').replace(/_/g, ' '),
                value: data.line,
                fairProb: edge.fairOver,
                evPercent: edge.overEV,
                sharpOdds: data.over,
                gameTime: event.commence_time,
                bookmaker: book.key
              });
            }
            
            // Also check if Under has positive EV
            if (edge.underEV > 0) {
              players.push({
                id: id++,
                name: playerName,
                team: event.away_team,
                league: sport.replace(/_/g, ' ').toUpperCase(),
                game: `${event.home_team} vs ${event.away_team}`,
                stat: 'Under',
                line: market.key.replace('player_', '').replace(/_/g, ' '),
                value: data.line,
                fairProb: edge.fairUnder,
                evPercent: edge.underEV,
                sharpOdds: data.under,
                gameTime: event.commence_time,
                bookmaker: book.key
              });
            }
          }
        });
      });
    });
  });
  
  console.log(`  Generated ${players.length} +EV plays`);
  return players;
}

// Refresh data from API
async function refreshData() {
  console.log('='.repeat(60));
  console.log('🔄 FETCHING UPCOMING GAMES FROM ODDS API');
  console.log('='.repeat(60));
  console.log('API Key set:', API_KEY !== 'YOUR_API_KEY_HERE' ? 'YES ✓' : 'NO ✗');
  console.log('Time:', new Date().toLocaleString());
  console.log('='.repeat(60));
  
  const startTime = Date.now();
  let allPlayers = [];
  let totalGames = 0;
  let apiCallsMade = 0;
  
  try {
    for (const sport of SPORTS) {
      for (const market of MARKETS) {
        const events = await fetchFromAPI(sport, market);
        totalGames += events.length;
        apiCallsMade++;
        
        const players = processData(events, sport);
        allPlayers = allPlayers.concat(players);
        
        // Rate limit: 1 request per second to avoid hitting API limits
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    }
    
    // Sort by highest EV first
    allPlayers.sort((a, b) => b.evPercent - a.evPercent);
    
    // Remove duplicates (same player, same line, same stat)
    const uniquePlayers = [];
    const seen = new Set();
    
    allPlayers.forEach(player => {
      const key = `${player.name}-${player.line}-${player.value}-${player.stat}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniquePlayers.push(player);
      }
    });
    
    cachedData = uniquePlayers;
    lastUpdate = Date.now();
    stats.calls += apiCallsMade;
    stats.credits += apiCallsMade; // Roughly 1 credit per API call
    lastError = null;
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('='.repeat(60));
    console.log('✅ FETCH COMPLETE');
    console.log('='.repeat(60));
    console.log(`Upcoming games scanned: ${totalGames}`);
    console.log(`API calls made: ${apiCallsMade}`);
    console.log(`Raw +EV plays found: ${allPlayers.length}`);
    console.log(`Unique +EV plays: ${uniquePlayers.length}`);
    console.log(`Duration: ${duration}s`);
    console.log(`Credits used this refresh: ~${apiCallsMade}`);
    console.log(`Total credits used: ~${stats.credits}`);
    console.log('='.repeat(60));
    
    return {
      success: true,
      players: uniquePlayers,
      gamesScanned: totalGames,
      message: uniquePlayers.length > 0 
        ? `Found ${uniquePlayers.length} +EV plays from ${totalGames} upcoming games!` 
        : totalGames > 0
          ? `Scanned ${totalGames} upcoming games but found no plays above 54.25% threshold`
          : 'No upcoming games found in the next 24-48 hours'
    };
    
  } catch (error) {
    console.error('❌ ERROR:', error);
    lastError = error.message;
    
    return {
      success: false,
      players: [],
      gamesScanned: 0,
      message: `Error: ${error.message}`
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
    lastError: lastError,
    usageStats: { totalApiCalls: stats.calls, estimatedCreditsUsed: stats.credits }
  });
});

app.post('/api/player-props/refresh', async (req, res) => {
  try {
    console.log('📡 Manual refresh requested by user');
    const result = await refreshData();
    
    res.json({
      success: result.success,
      message: result.message,
      data: result.players,
      lastUpdate: lastUpdate,
      count: result.players.length,
      gamesScanned: result.gamesScanned,
      usageStats: { totalApiCalls: stats.calls, estimatedCreditsUsed: stats.credits }
    });
  } catch (error) {
    console.error('Error in refresh endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Failed to fetch from API'
    });
  }
});

// Serve HTML (keeping the debug version UI)
app.get('/', (req, res) => {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fantasy Optimizer</title>
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
      const [stats, setStats] = useState({ totalApiCalls: 0, estimatedCreditsUsed: 0 });
      const [lastUpdate, setLastUpdate] = useState(null);
      const [selectedSport, setSelectedSport] = useState('ALL');
      const [showConfirm, setShowConfirm] = useState(false);
      const [message, setMessage] = useState('');
      const [gamesScanned, setGamesScanned] = useState(0);
      
      const sports = ['ALL', 'NBA', 'NFL', 'NHL', 'MLB', 'NCAAB'];
      
      async function loadData() {
        try {
          const response = await fetch('/api/player-props');
          const result = await response.json();
          if (result.success) {
            setPlayers(result.data);
            setStats(result.usageStats);
            setLastUpdate(result.lastUpdate);
          }
          setLoading(false);
        } catch (error) {
          console.error('Error:', error);
          setMessage('Error loading data');
          setLoading(false);
        }
      }
      
      async function handleRefresh() {
        setShowConfirm(false);
        setRefreshing(true);
        setMessage('Fetching upcoming games from Odds API... This may take 30-60 seconds.');
        
        try {
          const response = await fetch('/api/player-props/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const result = await response.json();
          
          setPlayers(result.data || []);
          setStats(result.usageStats);
          setLastUpdate(result.lastUpdate);
          setMessage(result.message || '');
          setGamesScanned(result.gamesScanned || 0);
          
          if (!result.success) {
            setMessage('API Error: ' + (result.error || 'Unknown error'));
          }
        } catch (error) {
          console.error('Error:', error);
          setMessage('Network error: ' + error.message);
        }
        
        setRefreshing(false);
      }
      
      useEffect(() => { loadData(); }, []);
      
      const formatTime = () => {
        if (!lastUpdate) return 'Never';
        const diff = Math.floor((Date.now() - lastUpdate) / 60000);
        return diff < 1 ? 'Just now' : diff < 60 ? diff + 'm ago' : Math.floor(diff/60) + 'h ago';
      };
      
      const filteredPlayers = selectedSport === 'ALL' 
        ? players 
        : players.filter(p => p.league.includes(selectedSport));
      
      return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">
          {showConfirm && (
            <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-purple-500/30 rounded-xl p-6 max-w-md">
                <h3 className="text-lg font-bold mb-2">Refresh Data?</h3>
                <p className="text-sm mb-4">This will fetch upcoming games and player props from The Odds API. Uses ~35 credits. Takes 30-60 seconds.</p>
                <div className="bg-slate-800/50 rounded p-3 mb-4 text-sm">
                  <div className="flex justify-between mb-1">
                    <span className="text-slate-400">API Calls:</span>
                    <span>{stats.totalApiCalls}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Credits Used:</span>
                    <span className="text-amber-400">~{stats.estimatedCreditsUsed}</span>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setShowConfirm(false)} className="flex-1 px-4 py-2 border border-slate-600 rounded-lg">Cancel</button>
                  <button onClick={handleRefresh} className="flex-1 px-4 py-2 bg-purple-600 rounded-lg">Fetch Now</button>
                </div>
              </div>
            </div>
          )}
          
          <div className="container mx-auto p-6">
            <header className="mb-8">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-4xl font-bold mb-2">FANTASY OPTIMIZER</h1>
                  <p className="text-purple-300">+EV Player Props · Upcoming Games</p>
                </div>
                <div className="text-right">
                  <div className="text-sm text-slate-400 mb-2">
                    Last: {formatTime()} | Calls: {stats.totalApiCalls} | Credits: ~{stats.estimatedCreditsUsed}
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
              
              <div className="flex gap-2 overflow-x-auto mb-4">
                {sports.map(sport => (
                  <button
                    key={sport}
                    onClick={() => setSelectedSport(sport)}
                    className={\`px-4 py-2 rounded-lg font-medium transition \${
                      selectedSport === sport 
                        ? 'bg-purple-600 text-white' 
                        : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700/50'
                    }\`}
                  >
                    {sport}
                  </button>
                ))}
              </div>
              
              {message && (
                <div className="bg-blue-950/30 border border-blue-500/30 rounded-lg p-4 mb-4">
                  <p className="text-sm text-blue-300">{message}</p>
                  {gamesScanned > 0 && <p className="text-xs text-slate-400 mt-2">Scanned {gamesScanned} upcoming games</p>}
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
                  <p className="text-slate-400 mb-6">Click refresh to fetch +EV plays from upcoming games</p>
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="px-8 py-4 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium text-lg"
                  >
                    Fetch Upcoming Games
                  </button>
                </div>
              )}
              
              {!loading && filteredPlayers.length > 0 && (
                <div>
                  <div className="bg-slate-800/50 rounded-lg p-4 mb-6">
                    <h2 className="text-2xl font-bold">{filteredPlayers.length} +EV Plays Found</h2>
                    <p className="text-slate-400 text-sm">
                      {selectedSport === 'ALL' ? 'All sports' : selectedSport} | Sorted by highest EV
                    </p>
                  </div>
                  
                  <div className="space-y-4">
                    {filteredPlayers.map((player) => (
                      <div key={player.id} className="bg-slate-800/50 border border-purple-500/30 rounded-lg p-6 hover:border-purple-500/50 transition">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              <h3 className="text-xl font-bold">{player.name}</h3>
                              <span className="px-2 py-1 bg-purple-600/30 rounded text-xs font-medium">
                                {player.league}
                              </span>
                              <span className="px-2 py-1 bg-slate-700 rounded text-xs">
                                {player.stat}
                              </span>
                            </div>
                            <p className="text-slate-400 text-sm mb-2">{player.team}</p>
                            <p className="text-purple-300 mb-1 font-medium">{player.line}: {player.value}</p>
                            <p className="text-xs text-slate-500 mb-1">{player.game}</p>
                            <p className="text-xs text-slate-600">Game: {new Date(player.gameTime).toLocaleString()}</p>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-slate-400 mb-1">Fair Win Prob</div>
                            <div className="text-3xl font-bold text-emerald-400 mb-1">
                              {player.fairProb.toFixed(1)}%
                            </div>
                            <div className="text-lg font-bold text-emerald-400">
                              +{player.evPercent.toFixed(1)}% EV
                            </div>
                            <div className="text-xs text-slate-500 mt-2">
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
                  <p className="text-slate-400">No {selectedSport} plays found. Try another sport.</p>
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
  console.log('='.repeat(60));
  console.log('🚀 FANTASY OPTIMIZER SERVER STARTED');
  console.log('='.repeat(60));
  console.log('Port:', PORT);
  console.log('API Key configured:', API_KEY !== 'YOUR_API_KEY_HERE' ? 'YES ✓' : 'NO ✗');
  console.log('Mode: Fetching UPCOMING games (pre-match)');
  console.log('='.repeat(60));
});
