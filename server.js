const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

let cachedData = [];
let lastUpdate = null;
let stats = { calls: 0, credits: 0 };

// API endpoints
app.get('/api/player-props', (req, res) => {
  res.json({
    success: true,
    data: cachedData,
    lastUpdate: lastUpdate,
    count: cachedData.length,
    usageStats: { totalApiCalls: stats.calls, estimatedCreditsUsed: stats.credits }
  });
});

app.post('/api/player-props/refresh', (req, res) => {
  cachedData = [
    {
      id: 0,
      name: "LeBron James",
      team: "Lakers",
      league: "NBA",
      line: "points",
      value: 25.5,
      fairProb: 58.5,
      evPercent: 7.8
    },
    {
      id: 1,
      name: "Stephen Curry",
      team: "Warriors", 
      league: "NBA",
      line: "3-pointers",
      value: 4.5,
      fairProb: 61.2,
      evPercent: 12.8
    }
  ];
  lastUpdate = Date.now();
  stats.calls = stats.calls + 1;
  stats.credits = stats.credits + 50;
  
  res.json({
    success: true,
    message: 'Data refreshed',
    data: cachedData,
    lastUpdate: lastUpdate,
    count: cachedData.length,
    usageStats: { totalApiCalls: stats.calls, estimatedCreditsUsed: stats.credits }
  });
});

// Serve HTML
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
      
      async function loadData() {
        try {
          const response = await fetch('/api/player-props');
          const result = await response.json();
          if (result.success) {
            setPlayers(result.data);
            setStats(result.usageStats);
          }
          setLoading(false);
        } catch (error) {
          console.error('Error:', error);
          setLoading(false);
        }
      }
      
      async function handleRefresh() {
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
          }
        } catch (error) {
          console.error('Error:', error);
        }
        setRefreshing(false);
      }
      
      useEffect(() => {
        loadData();
      }, []);
      
      return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">
          <div className="container mx-auto p-6">
            <header className="mb-8">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-4xl font-bold mb-2">FANTASY OPTIMIZER</h1>
                  <p className="text-purple-300">+EV Player Props</p>
                </div>
                <div className="text-right">
                  <div className="text-sm text-slate-400 mb-2">
                    API Calls: {stats.totalApiCalls} | Credits: ~{stats.estimatedCreditsUsed}
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
                  <p className="text-slate-400 mb-6">Click the button below to fetch sample +EV plays</p>
                  <button
                    onClick={handleRefresh}
                    className="px-8 py-4 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium text-lg"
                  >
                    Fetch Sample Data
                  </button>
                </div>
              )}
              
              {!loading && players.length > 0 && (
                <div>
                  <div className="bg-slate-800/50 rounded-lg p-4 mb-6">
                    <h2 className="text-2xl font-bold">{players.length} +EV Plays Found</h2>
                    <p className="text-slate-400 text-sm">Sample data for testing</p>
                  </div>
                  
                  <div className="space-y-4">
                    {players.map((player) => (
                      <div key={player.id} className="bg-slate-800/50 border border-purple-500/30 rounded-lg p-6">
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="text-xl font-bold mb-1">{player.name}</h3>
                            <p className="text-slate-400 text-sm">{player.team} - {player.league}</p>
                            <p className="text-purple-300 mt-2">{player.line}: {player.value}</p>
                          </div>
                          <div className="text-right">
                            <div className="text-sm text-slate-400">Fair Win Prob</div>
                            <div className="text-2xl font-bold text-emerald-400">{player.fairProb}%</div>
                            <div className="text-lg text-emerald-400">+{player.evPercent}% EV</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  <div className="mt-6 text-center">
                    <button
                      onClick={handleRefresh}
                      disabled={refreshing}
                      className="px-8 py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium disabled:opacity-50"
                    >
                      {refreshing ? 'Refreshing...' : 'Refresh Data'}
                    </button>
                  </div>
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
});
