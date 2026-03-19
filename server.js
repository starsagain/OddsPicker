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
let creditsUsed = 0;

// Sports and markets to fetch
const SPORTS_MARKETS = [
  { sport: 'basketball_nba', markets: ['player_points', 'player_rebounds', 'player_assists', 'player_threes'] },
  { sport: 'americanfootball_nfl', markets: ['player_pass_tds', 'player_pass_yds', 'player_rush_yds', 'player_receptions'] },
  { sport: 'icehockey_nhl', markets: ['player_points', 'player_shots_on_goal'] },
  { sport: 'baseball_mlb', markets: ['player_hits', 'player_total_bases', 'player_rbis'] }
];

// Bookmakers that have player props
const BOOKMAKERS = 'draftkings,fanduel,betmgm';

// Helper: American to Decimal odds
function americanToDecimal(odds) {
  if (!odds) return 2.0;
  return odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
}

// Helper: Calculate no-vig probability
function calculateNoVig(overOdds, underOdds) {
  const HURDLE = 0.5425; // 54.25% PrizePicks breakeven
  
  const overDec = americanToDecimal(overOdds);
  const underDec = americanToDecimal(underOdds);
  
  const overImplied = 1 / overDec;
  const underImplied = 1 / underDec;
  const totalImplied = overImplied + underImplied;
  
  if (totalImplied === 0 || !isFinite(totalImplied)) {
    return { fairOver: 50, fairUnder: 50, overEV: 0, underEV: 0 };
  }
  
  const fairOver = (overImplied / totalImplied) * 100;
  const fairUnder = (underImplied / totalImplied) * 100;
  
  const overEV = fairOver > (HURDLE * 100) ? ((fairOver / 100 / HURDLE) - 1) * 100 : 0;
  const underEV = fairUnder > (HURDLE * 100) ? ((fairUnder / 100 / HURDLE) - 1) * 100 : 0;
  
  return { fairOver, fairUnder, overEV, underEV };
}

// Fetch player props from The Odds API
async function fetchPlayerProps(sport, market) {
  const url = `${BASE_URL}/sports/${sport}/odds?apiKey=${API_KEY}&regions=us&markets=${market}&oddsFormat=american&bookmakers=${BOOKMAKERS}`;
  
  console.log(`Fetching ${sport} - ${market}...`);
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      console.log(`  ✗ Error ${response.status}`);
      return [];
    }
    
    const events = await response.json();
    console.log(`  ✓ Found ${events.length} games`);
    
    creditsUsed++;
    return events;
    
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
    return [];
  }
}

// Parse events and extract player props - SHOW ALL (no EV filter)
function parsePlayerProps(events, sport, market) {
  const plays = [];
  
  console.log(`  Parsing ${events.length} events...`);
  
  events.forEach(event => {
    if (!event.bookmakers || event.bookmakers.length === 0) {
      console.log(`  Event has no bookmakers: ${event.away_team} @ ${event.home_team}`);
      return;
    }
    
    const gameInfo = `${event.away_team} @ ${event.home_team}`;
    const gameTime = event.commence_time;
    
    event.bookmakers.forEach(book => {
      if (!book.markets) return;
      
      book.markets.forEach(mkt => {
        if (mkt.key !== market) return;
        
        if (!mkt.outcomes) {
          console.log(`  Market has no outcomes`);
          return;
        }
        
        console.log(`  Found ${mkt.outcomes.length} outcomes in ${market} market`);
        
        // Group outcomes by player
        const playerMap = new Map();
        
        mkt.outcomes.forEach(outcome => {
          const playerName = outcome.description || outcome.name;
          const line = outcome.point;
          const key = `${playerName}|${line}`;
          
          if (!playerMap.has(key)) {
            playerMap.set(key, { player: playerName, line: line, over: null, under: null });
          }
          
          const player = playerMap.get(key);
          if (outcome.name === 'Over') player.over = outcome.price;
          if (outcome.name === 'Under') player.under = outcome.price;
        });
        
        console.log(`  Grouped into ${playerMap.size} unique player/line combinations`);
        
        // Add ALL props (no EV filter)
        playerMap.forEach((data, key) => {
          if (!data.over || !data.under) return;
          
          const edge = calculateNoVig(data.over, data.under);
          
          // Add Over
          plays.push({
            id: plays.length,
            name: data.player,
            league: sport.replace(/_/g, ' ').toUpperCase(),
            game: gameInfo,
            gameTime: gameTime,
            stat: 'Over',
            line: market.replace('player_', '').replace(/_/g, ' '),
            value: data.line,
            fairProb: edge.fairOver,
            odds: data.over,
            book: book.title
          });
          
          // Add Under
          plays.push({
            id: plays.length,
            name: data.player,
            league: sport.replace(/_/g, ' ').toUpperCase(),
            game: gameInfo,
            gameTime: gameTime,
            stat: 'Under',
            line: market.replace('player_', '').replace(/_/g, ' '),
            value: data.line,
            fairProb: edge.fairUnder,
            odds: data.under,
            book: book.title
          });
        });
      });
    });
  });
  
  console.log(`  Total props extracted: ${plays.length}`);
  return plays;
}

// Main refresh function
async function refreshData() {
  console.log('='.repeat(60));
  console.log('🔄 FETCHING PLAYER PROPS FROM THE ODDS API');
  console.log('='.repeat(60));
  console.log('Time:', new Date().toLocaleString());
  console.log('API Key:', API_KEY !== 'YOUR_API_KEY_HERE' ? 'Set ✓' : 'Missing ✗');
  console.log('='.repeat(60));
  
  const startTime = Date.now();
  const allPlays = [];
  let totalGames = 0;
  
  try {
    for (const config of SPORTS_MARKETS) {
      console.log(`\n📊 ${config.sport.toUpperCase()}`);
      
      for (const market of config.markets) {
        const events = await fetchPlayerProps(config.sport, market);
        totalGames += events.length;
        
        const plays = parsePlayerProps(events, config.sport, market);
        allPlays.push(...plays);
        
        console.log(`  → ${plays.length} +EV plays found`);
        
        // Rate limit: 1 req/sec
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    }
    
      // Sort by probability (highest first)
      allPlays.sort((a, b) => b.fairProb - a.fairProb);
    
    cachedData = allPlays;
    lastUpdate = Date.now();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ REFRESH COMPLETE');
    console.log('='.repeat(60));
    console.log(`Games scanned: ${totalGames}`);
    console.log(`Props found: ${allPlays.length}`);
    console.log(`Duration: ${duration}s`);
    console.log(`Credits used: ${creditsUsed}`);
    console.log('='.repeat(60));
    
    return {
      success: true,
      message: `Found ${allPlays.length} player props from ${totalGames} games`,
      data: allPlays
    };
    
  } catch (error) {
    console.error('❌ Error:', error);
    return {
      success: false,
      message: error.message,
      data: []
    };
  }
}

// API endpoints
app.get('/api/player-props', (req, res) => {
  res.json({
    success: true,
    data: cachedData,
    lastUpdate: lastUpdate,
    count: cachedData.length,
    creditsUsed: creditsUsed
  });
});

app.post('/api/player-props/refresh', async (req, res) => {
  console.log('📡 Refresh requested');
  const result = await refreshData();
  
  res.json({
    success: result.success,
    message: result.message,
    data: result.data,
    lastUpdate: lastUpdate,
    count: result.data.length,
    creditsUsed: creditsUsed
  });
});

// Serve HTML
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fantasy Optimizer - Player Props</title>
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
      const [plays, setPlays] = useState([]);
      const [loading, setLoading] = useState(true);
      const [refreshing, setRefreshing] = useState(false);
      const [lastUpdate, setLastUpdate] = useState(null);
      const [credits, setCredits] = useState(0);
      const [message, setMessage] = useState('');
      const [selectedLeague, setSelectedLeague] = useState('ALL');
      
      const leagues = ['ALL', 'BASKETBALL NBA', 'AMERICANFOOTBALL NFL', 'ICEHOCKEY NHL', 'BASEBALL MLB'];
      
      async function loadData() {
        try {
          const res = await fetch('/api/player-props');
          const data = await res.json();
          setPlays(data.data || []);
          setLastUpdate(data.lastUpdate);
          setCredits(data.creditsUsed || 0);
          setLoading(false);
        } catch (err) {
          console.error(err);
          setLoading(false);
        }
      }
      
      async function handleRefresh() {
        setRefreshing(true);
        setMessage('Fetching player props from The Odds API...');
        
        try {
          const res = await fetch('/api/player-props/refresh', { method: 'POST' });
          const data = await res.json();
          setPlays(data.data || []);
          setLastUpdate(data.lastUpdate);
          setCredits(data.creditsUsed || 0);
          setMessage(data.message || '');
        } catch (err) {
          setMessage('Error: ' + err.message);
        }
        
        setRefreshing(false);
      }
      
      useEffect(() => { loadData(); }, []);
      
      const formatTime = () => {
        if (!lastUpdate) return 'Never';
        const diff = Math.floor((Date.now() - lastUpdate) / 60000);
        return diff < 1 ? 'Just now' : diff < 60 ? diff + 'm ago' : Math.floor(diff/60) + 'h ago';
      };
      
      const filtered = selectedLeague === 'ALL' 
        ? plays 
        : plays.filter(p => p.league === selectedLeague);
      
      return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">
          <div className="container mx-auto p-6">
            <header className="mb-8">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-4xl font-bold mb-2">FANTASY OPTIMIZER</h1>
                  <p className="text-purple-300">Player Props & Parlay Builder</p>
                </div>
                <div className="text-right">
                  <div className="text-sm text-slate-400 mb-2">
                    Last: {formatTime()} | Credits: {credits}
                  </div>
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing}
                    className="px-6 py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium disabled:opacity-50"
                  >
                    {refreshing ? 'Refreshing...' : 'Refresh Data'}
                  </button>
                </div>
              </div>
              
              <div className="flex gap-2 flex-wrap mb-4">
                {leagues.map(league => (
                  <button
                    key={league}
                    onClick={() => setSelectedLeague(league)}
                    className={\`px-4 py-2 rounded-lg text-sm font-medium \${
                      selectedLeague === league 
                        ? 'bg-purple-600' 
                        : 'bg-slate-800/50 hover:bg-slate-700/50'
                    }\`}
                  >
                    {league}
                  </button>
                ))}
              </div>
              
              {message && (
                <div className="bg-blue-950/30 border border-blue-500/30 rounded-lg p-4">
                  <p className="text-sm text-blue-300">{message}</p>
                </div>
              )}
            </header>
            
            <main>
              {loading && <div className="text-center py-20">Loading...</div>}
              
              {!loading && plays.length === 0 && !refreshing && (
                <div className="text-center py-20">
                  <h2 className="text-2xl font-bold mb-4">No Data</h2>
                  <p className="text-slate-400 mb-6">Click refresh to fetch player props</p>
                  <button
                    onClick={handleRefresh}
                    className="px-8 py-4 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium text-lg"
                  >
                    Fetch Player Props
                  </button>
                </div>
              )}
              
              {!loading && filtered.length > 0 && (
                <div>
                  <div className="bg-slate-800/50 rounded-lg p-4 mb-6">
                    <h2 className="text-2xl font-bold">{filtered.length} Player Props</h2>
                    <p className="text-slate-400 text-sm">Sorted by highest probability</p>
                  </div>
                  
                  <div className="space-y-4">
                    {filtered.map((play) => (
                      <div key={play.id} className="bg-slate-800/50 border border-purple-500/30 rounded-lg p-6">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              <h3 className="text-xl font-bold">{play.name}</h3>
                              <span className="px-2 py-1 bg-purple-600/30 rounded text-xs">
                                {play.league}
                              </span>
                              <span className="px-2 py-1 bg-slate-700 rounded text-xs">
                                {play.stat}
                              </span>
                            </div>
                            <p className="text-purple-300 mb-1">{play.line}: {play.value}</p>
                            <p className="text-xs text-slate-500">{play.game}</p>
                            <p className="text-xs text-slate-600 mt-1">Book: {play.book} ({play.odds > 0 ? '+' : ''}{play.odds})</p>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-slate-400 mb-1">Win Probability</div>
                            <div className="text-3xl font-bold text-emerald-400">
                              {play.fairProb.toFixed(1)}%
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </main>
          </div>
        </div>
      );
    }
    
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('🚀 FANTASY OPTIMIZER - THE ODDS API EDITION');
  console.log('='.repeat(60));
  console.log('Port:', PORT);
  console.log('API Key:', API_KEY !== 'YOUR_API_KEY_HERE' ? 'Configured ✓' : 'Missing ✗');
  console.log('='.repeat(60));
});
