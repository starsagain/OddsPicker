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

// Sports to fetch
const SPORTS = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'basketball_ncaab'
];

// Prop markets
const MARKETS = [
  'player_points',
  'player_rebounds', 
  'player_assists',
  'player_threes',
  'player_pass_tds',
  'player_rush_yds'
];

// Helper: Convert American odds to decimal
function americanToDecimal(odds) {
  return odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
}

// Helper: Calculate no-vig probability and EV
function calculateEdge(overOdds, underOdds) {
  const HURDLE = 0.5425;
  
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

// Fetch from Odds API
async function fetchFromAPI(sport, market) {
  const url = `${BASE_URL}/sports/${sport}/events?apiKey=${API_KEY}&markets=${market}&regions=us&bookmakers=pinnacle,betfair`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    return [];
  }
}

// Process API data
function processData(events, sport) {
  const players = [];
  let id = 0;
  
  events.forEach(event => {
    if (!event.bookmakers || event.bookmakers.length === 0) return;
    
    event.bookmakers.forEach(book => {
      if (!book.markets) return;
      
      book.markets.forEach(market => {
        if (!market.outcomes) return;
        
        // Group outcomes by player
        const playerMap = new Map();
        market.outcomes.forEach(outcome => {
          const player = outcome.description;
          if (!playerMap.has(player)) {
            playerMap.set(player, { over: null, under: null, line: outcome.point });
          }
          
          const data = playerMap.get(player);
          if (outcome.name === 'Over') data.over = outcome.price;
          if (outcome.name === 'Under') data.under = outcome.price;
        });
        
        // Calculate edges
        playerMap.forEach((data, playerName) => {
          if (data.over && data.under) {
            const edge = calculateEdge(data.over, data.under);
            
            if (edge.overEV > 0) {
              players.push({
                id: id++,
                name: playerName,
                team: event.home_team,
                league: sport.replace(/_/g, ' ').toUpperCase(),
                game: `${event.home_team} vs ${event.away_team}`,
                stat: 'Over',
                line: market.key.replace('player_', ''),
                value: data.line,
                fairProb: edge.fairOver,
                evPercent: edge.overEV,
                hasEdge: true,
                color: 'green',
                gameTime: event.commence_time
              });
            }
          }
        });
      });
    });
  });
  
  return players;
}

// Refresh data from API
async function refreshData() {
  console.log('🔄 Fetching from Odds API...');
  const startTime = Date.now();
  
  let allPlayers = [];
  
  for (const sport of SPORTS) {
    for (const market of MARKETS) {
      console.log(`  Fetching ${sport} ${market}...`);
      const events = await fetchFromAPI(sport, market);
      const players = processData(events, sport);
      allPlayers = allPlayers.concat(players);
      
      // Rate limit: 1 request per second
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Sort by EV
  allPlayers.sort((a, b) => b.evPercent - a.evPercent);
  
  cachedData = allPlayers;
  lastUpdate = Date.now();
  stats.calls++;
  stats.credits += (SPORTS.length * MARKETS.length);
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Fetched ${allPlayers.length} +EV plays in ${duration}s`);
  console.log(`📊 Total credits used: ~${stats.credits}`);
  
  return allPlayers;
}

// API Routes
app.get('/api/player-props', (req, res) => {
  res.json({
    success: true,
    data: cachedData,
    lastUpdate: lastUpdate,
    count: cachedData.length,
    usageStats: { totalApiCalls: stats.calls, estimatedCreditsUsed: stats.credits }
  });
});

app.post('/api/player-props/refresh', async (req, res) => {
  try {
    console.log('📡 Manual refresh requested');
    const data = await refreshData();
    
    res.json({
      success: true,
      message: 'Data refreshed',
      data: data,
      lastUpdate: lastUpdate,
      count: data.length,
      usageStats: { totalApiCalls: stats.calls, estimatedCreditsUsed: stats.credits }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve HTML (keeping the working UI from before)
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
      
      const sports = ['ALL', 'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB'];
      
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
          setLoading(false);
        }
      }
      
      async function handleRefresh() {
        setShowConfirm(false);
        setRefreshing(true);
        try {
          const response = await fetch('/api/player-props/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const result = await response.json();
          if (result.success) {
            setPlayers(result.data);
            setStats(result.usageStats);
            setLastUpdate(result.lastUpdate);
          }
        } catch (error) {
          console.error('Error:', error);
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
                <p className="text-sm mb-4">This will fetch live data from The Odds API. Uses ~${SPORTS.length * MARKETS.length} credits.</p>
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
                  <p className="text-purple-300">+EV Player Props</p>
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
              
              <div className="flex gap-2 overflow-x-auto">
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
            </header>
            
            <main>
              {loading && (
                <div className="text-center py-20">
                  <div className="text-xl">Loading...</div>
                </div>
              )}
              
              {!loading && players.length === 0 && (
                <div className="text-center py-20">
                  <h2 className="text-2xl font-bold mb-4">No Data Available</h2>
                  <p className="text-slate-400 mb-6">Click refresh to fetch live +EV plays from The Odds API</p>
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="px-8 py-4 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium text-lg"
                  >
                    Fetch Live Data
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
                            </div>
                            <p className="text-slate-400 text-sm mb-2">{player.team}</p>
                            <p className="text-purple-300 mb-1">{player.line}: {player.value}</p>
                            <p className="text-xs text-slate-500">{player.game}</p>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-slate-400 mb-1">Fair Win Prob</div>
                            <div className="text-3xl font-bold text-emerald-400 mb-1">
                              {player.fairProb.toFixed(1)}%
                            </div>
                            <div className="text-lg font-bold text-emerald-400">
                              +{player.evPercent.toFixed(1)}% EV
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
  console.log('Fantasy Optimizer server started on port ' + PORT);
  console.log('Ready to fetch +EV plays!');
});
