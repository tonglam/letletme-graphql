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
- **Better Auth** - ✅ Hybrid authentication implemented (OAuth for web, device-based for mobile)
- **Domain-Driven Design** - 7 business domains, 20 queries, 1 mutation
- **Redis Cache** - Read-through caching (30-60s TTL)
- **Supabase PostgreSQL** - Primary database with auth tables
- **Strict TypeScript** - No `any` types allowed, 100% typed
- **Prometheus Metrics** - Performance monitoring built-in

## Documentation

### 📄 Start Here
- 📊 **[Project Summary](documentation/PROJECT_SUMMARY.md)** - Complete overview of what's built and what's next
- 🏗️ **[Architecture Overview](documentation/ARCHITECTURE_OVERVIEW.md)** - System architecture diagrams and design principles

### Architecture & Design
- 📋 **[Domain Plan](documentation/DOMAIN_PLAN.md)** - Complete domain architecture and GraphQL schema design
- 🔐 **[Auth Strategy](documentation/AUTH_STRATEGY.md)** - Hybrid authentication design (Better Auth + Device Auth)
- 🔒 **[RLS Security](documentation/RLS_SECURITY.md)** - Row Level Security implementation (7 policies)

### Implementation Tracking
- ✅ **[Implementation Checklist](documentation/IMPLEMENTATION_CHECKLIST.md)** - Domain implementation progress (COMPLETE)
- 📝 **[Auth Implementation Checklist](documentation/AUTH_IMPLEMENTATION_CHECKLIST.md)** - Auth implementation tasks (~87 tasks)

### Operations
- 🚀 **[Deployment Summary](documentation/DEPLOYMENT_SUMMARY.md)** - Production deployment guide

## Project Status

| Domain | Status | Queries/Mutations | Notes |
|--------|--------|-------------------|-------|
| **Authentication** | ✅ Complete | 2 queries, 1 mutation | Device auth + OAuth ready |
| Events | ✅ Complete | 3 queries | Game weeks, deadlines |
| Players | ✅ Complete | 4 queries | Players, teams, filtering |
| Fixtures | ✅ Complete | 3 queries | Match schedules, results |
| Live Scores | ✅ Complete | 2 queries | 30s cache, real-time data |
| Leagues | ✅ Complete | 3 queries | Standings, event results |
| Entries | ✅ Complete (read-only) | 3 queries | User data, history |
| Tournaments | ⏭️ Deferred | - | Complex, 7 tables |

**Total:** 7 domains, 20 queries, 1 mutation, ~5,500 lines of code

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

```bash
# Database & Supabase
DATABASE_URL=
SUPABASE_URL=
SUPABASE_KEY=

# Redis
REDIS_HOST=
REDIS_PORT=6379
REDIS_PASSWORD=

# Server
PORT=4000
LOG_LEVEL=info
CACHE_TTL_SECONDS=60

# Authentication (Optional for development, defaults provided)
JWT_SECRET=dev-secret-change-in-production
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# OAuth Providers (Optional - only needed for web OAuth)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
APPLE_CLIENT_ID=
APPLE_CLIENT_SECRET=
APP_URL=http://localhost:3000
```

**Note**: For production, generate a strong JWT_SECRET: `openssl rand -base64 32`

## Run
```bash
bun install

# Run database migrations (first time only)
bun run migrate        # Create auth tables
bun run migrate:rls    # Apply RLS policies

# Start development server
bun run dev
```

## Authentication Setup

### Quick Start (Device Authentication)

Device authentication works out of the box for mobile apps - no additional setup needed!

```bash
# Create an anonymous user with device authentication
curl -X POST http://localhost:4000/api/device/auth \
  -H "Content-Type: application/json" \
  -d '{"device_id":"my-device-123","device_name":"iPhone 14","device_os":"iOS 17.2"}'

# Response: { "token": "...", "userId": "...", "isAnonymous": true }
```

### GraphQL with Authentication

```bash
# Query with device token
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{"query":"{ me { id email name isAnonymous } }"}'
```

### OAuth Setup (Optional - for web)

1. Get Google OAuth credentials from [Google Cloud Console](https://console.cloud.google.com)
2. Get Apple OAuth credentials from [Apple Developer](https://developer.apple.com)
3. Add to `.env`:
```bash
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
APPLE_CLIENT_ID=your_client_id
APPLE_CLIENT_SECRET=your_client_secret
```

OAuth endpoints:
- `GET /api/auth/sign-in/google` - Google OAuth
- `GET /api/auth/sign-in/apple` - Apple OAuth
- `POST /api/auth/sign-in/email` - Email/password login

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

### GraphQL & Health
- `POST /graphql` - Apollo Server GraphQL endpoint
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

### Authentication
- `POST /api/device/auth` - Device authentication (mobile)
- `GET /api/auth/sign-in/google` - Google OAuth (web)
- `GET /api/auth/sign-in/apple` - Apple OAuth (web)
- `POST /api/auth/sign-in/email` - Email/password login
- `POST /api/auth/sign-up/email` - Email/password registration
- `POST /api/auth/sign-out` - Logout

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

### Authentication Domain

```graphql
# Get current authenticated user
query Me {
  me {
    id
    email
    name
    emailVerified
    isAnonymous
  }
}

# Get all devices for current user
query MyDevices {
  myDevices {
    id
    deviceId
    deviceName
    deviceOs
    lastActive
    createdAt
  }
}

# Revoke a device session
mutation RevokeDevice {
  revokeDevice(deviceId: "device-123")
}
```

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
