# letletme-graphql

**Fantasy Football GraphQL API** - Production-ready Apollo Server with hybrid authentication strategy.

Business-domain GraphQL layer over Supabase Postgres with Redis caching, structured logging, and Prometheus metrics.

## 🎯 Quick Start

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Server runs at http://localhost:4000/graphql
```

## 🏗️ Architecture

- **Apollo Server 4** - Industry-standard GraphQL server
- **Bun Runtime** - Fast JavaScript runtime
- **Better Auth** - Hybrid authentication (OAuth for web, device-based for mobile)
- **Domain-Driven Design** - 6 business domains, 18 GraphQL queries
- **Redis Cache** - Read-through caching (30-60s TTL)
- **Supabase PostgreSQL** - Primary database
- **Strict TypeScript** - No `any` types allowed, 100% typed
- **Prometheus Metrics** - Performance monitoring built-in

## Documentation

### 📄 Start Here
- 📊 **[Project Summary](documentation/PROJECT_SUMMARY.md)** - Complete overview of what's built and what's next
- 🏗️ **[Architecture Overview](documentation/ARCHITECTURE_OVERVIEW.md)** - System architecture diagrams and design principles

### Architecture & Design
- 📋 **[Domain Plan](documentation/DOMAIN_PLAN.md)** - Complete domain architecture and GraphQL schema design
- 🔐 **[Auth Strategy](documentation/AUTH_STRATEGY.md)** - Hybrid authentication design (Better Auth + Device Auth)

### Implementation Tracking
- ✅ **[Implementation Checklist](documentation/IMPLEMENTATION_CHECKLIST.md)** - Domain implementation progress (COMPLETE)
- 📝 **[Auth Implementation Checklist](documentation/AUTH_IMPLEMENTATION_CHECKLIST.md)** - Auth implementation tasks (~87 tasks)

### Operations
- 🚀 **[Deployment Summary](documentation/DEPLOYMENT_SUMMARY.md)** - Production deployment guide

## Project Status

| Domain | Status | Queries | Notes |
|--------|--------|---------|-------|
| Events | ✅ Complete | 3 | Game weeks, deadlines |
| Players | ✅ Complete | 4 | Players, teams, filtering |
| Fixtures | ✅ Complete | 3 | Match schedules, results |
| Live Scores | ✅ Complete | 2 | 30s cache, real-time data |
| Leagues | ✅ Complete | 3 | Standings, event results |
| Entries | ✅ Complete (read-only) | 3 | User data, history |
| Tournaments | ⏭️ Deferred | - | Complex, 7 tables |

**Total:** 6 domains, 18 GraphQL queries, ~4,000 lines of code

## 🔐 Authentication Strategy

This API uses a **hybrid authentication approach**:

### Website (OAuth + Email/Password)
- ✅ Google OAuth
- ✅ Apple OAuth  
- ✅ Email/Password
- 🍪 **HttpOnly cookies** (XSS-safe, automatic)

### Mobile App (Device-Based)
- ✅ **Auto-login** on first launch (frictionless UX)
- ✅ Device ID based (no login screen needed)
- ✅ Optional account linking for cross-device sync
- 🔑 **Bearer tokens** stored in encrypted keychain

See [Auth Strategy](documentation/AUTH_STRATEGY.md) for complete flow details.

---

## Requirements
- Bun (latest stable)
- Supabase project with PostgreSQL
- Redis instance
- Node.js/npm (for frontend clients)

## Environment
Create a local `.env` file (do not commit it) with:

```
SUPABASE_URL=
SUPABASE_KEY=
REDIS_HOST=
REDIS_PORT=6379
REDIS_PASSWORD=
PORT=4000
LOG_LEVEL=info
CACHE_TTL_SECONDS=60
```

## Run
```bash
bun install
bun run dev
```

## Code Quality
```bash
# Linting
bun run lint          # Check for issues
bun run lint:fix      # Auto-fix issues

# Formatting
bun run format        # Format all files
bun run format:check  # Check formatting
```

## Endpoints
- `POST /graphql` - Apollo Server GraphQL endpoint
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

## Testing the API

### Apollo Sandbox (Recommended)
Visit [Apollo Sandbox](https://studio.apollographql.com/sandbox/explorer) and connect to:
```
http://localhost:4000/graphql
```

### cURL
```bash
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ currentEventInfo { currentEvent nextUtcDeadline } }"}'
```

### Other Clients
- **Postman** - Native GraphQL support
- **Insomnia** - Lightweight GraphQL client
- **VS Code** - Apollo GraphQL extension

## Example Queries

### Events Domain
```graphql
# Get a single event by ID
query EventById {
  event(id: 1) {
    id
    name
    isCurrent
    deadlineTime
  }
}

# List events with filtering
query EventsList {
  events(filter: { isCurrent: true }, limit: 20, offset: 0) {
    id
    name
    finished
  }
}

# Get current event ID and next deadline
query CurrentEventInfo {
  currentEventInfo {
    currentEvent
    nextUtcDeadline
  }
}
```

### Players Domain
```graphql
# Get a single player with team info
query PlayerById {
  player(id: 350) {
    id
    webName
    position
    price
    team {
      name
      shortName
    }
  }
}

# List all players with filtering
query PlayersList {
  players(filter: { position: MIDFIELDER, maxPrice: 8000 }, limit: 20) {
    id
    webName
    position
    price
    team {
      shortName
    }
  }
}

# Get all teams
query AllTeams {
  teams {
    id
    name
    shortName
    position
    points
  }
}
```

### Fixtures Domain
```graphql
# Get current gameweek fixtures
query CurrentFixtures {
  currentFixtures {
    id
    kickoffTime
    finished
    homeTeam {
      name
    }
    awayTeam {
      name
    }
    homeScore
    awayScore
  }
}

# Filter fixtures by team
query TeamFixtures {
  fixtures(filter: { teamId: 1 }, limit: 10) {
    kickoffTime
    homeTeam {
      shortName
    }
    awayTeam {
      shortName
    }
    homeTeamDifficulty
    awayTeamDifficulty
  }
}
```

### Live Scores Domain
```graphql
# Get live scores for current event
query LiveScores {
  liveScores {
    player {
      webName
      team {
        shortName
      }
    }
    totalPoints
    goalsScored
    assists
    bonus
  }
}

# Get specific player's live performance
query PlayerLive {
  playerLive(playerId: 350) {
    player {
      webName
    }
    totalPoints
    minutes
    goalsScored
    assists
    cleanSheets
    bonus
    bps
  }
}
```

### Leagues Domain
```graphql
# Get all leagues for an entry
query EntryLeagues {
  entryLeagues(entryId: 12345) {
    id
    name
    type
    startedEvent
  }
}

# Get league standings
query LeagueStandings {
  leagueStandings(leagueId: 123, limit: 20) {
    league {
      name
      type
    }
    entryId
    rank
    lastRank
    overallPoints
  }
}

# Get league results for a specific event
query LeagueEventResults {
  leagueEventResults(leagueId: 123, eventId: 21) {
    league {
      name
    }
    event {
      name
    }
    entryName
    playerName
    eventPoints
    eventRank
    overallPoints
    overallRank
  }
}
```

### Entries Domain
```graphql
# Get entry/team information
query GetEntry {
  entry(id: 12345) {
    id
    entryName
    playerName
    region
    overallPoints
    overallRank
    bank
    teamValue
    totalTransfers
  }
}

# Get entry history across all events
query EntryHistory {
  entryHistory(entryId: 12345) {
    event {
      id
      name
    }
    eventPoints
    eventRank
    overallPoints
    overallRank
    eventTransfers
    eventTransfersCost
    eventNetPoints
  }
}

# Get entry result for a specific event
query EntryEventResult {
  entryEventResult(entryId: 12345, eventId: 21) {
    entry {
      entryName
    }
    event {
      name
    }
    eventPoints
    overallPoints
    overallRank
  }
}
```
