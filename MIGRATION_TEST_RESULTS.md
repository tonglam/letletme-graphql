# Migration Test Results - deadline_time to TEXT

**Date**: 2026-01-18  
**Migration**: `003_events_deadline_text.sql`  
**Status**: ✅ SUCCESS

---

## Migration Summary

Changed `events.deadline_time` from `TIMESTAMP` to `TEXT` to store ISO 8601 strings directly.

### Before
- Type: `TIMESTAMP`
- Format: `2026-01-24 11:00:00` (no timezone info)

### After
- Type: `TEXT`
- Format: `2026-01-24T11:00:00Z` (ISO 8601 with UTC timezone)

---

## Test Results

### 1. ✅ Migration Execution
```bash
$ bun run migrate:deadline
✅ Migration completed successfully

📊 Column updated:
  ✓ deadline_time: text
    ISO 8601 datetime string in UTC (e.g., "2026-01-24T11:00:00Z")

📄 Sample data:
  GW 23: 2026-01-24T11:00:00Z
  GW 24: 2026-01-31T13:30:00Z
  GW 25: 2026-02-06T18:30:00Z
```

### 2. ✅ Database Storage Verification
```
📊 Database Storage:
GW 22 [CURRENT]:
  Deadline: 2026-01-17T11:00:00Z
  Type: text
  Length: 20 chars

GW 23 [NEXT]:
  Deadline: 2026-01-24T11:00:00Z
  Type: text
  Length: 20 chars
```

### 3. ✅ GraphQL Integration Tests

#### Test 1: Query Next Event
```graphql
query {
  events(filter: { isNext: true }, limit: 1) {
    id
    name
    deadlineTime
  }
}
```
**Result**: 
```json
{
  "data": {
    "events": [{
      "id": 23,
      "name": "Gameweek 23",
      "deadlineTime": "2026-01-24T11:00:00.000Z"
    }]
  }
}
```

#### Test 2: Query Current Event Info
```graphql
query {
  currentEventInfo {
    currentEvent
    nextUtcDeadline
  }
}
```
**Result**:
```json
{
  "data": {
    "currentEventInfo": {
      "currentEvent": 22,
      "nextUtcDeadline": "2026-01-24T11:00:00.000Z"
    }
  }
}
```

#### Test 3: Query Current and Next Events
```graphql
query {
  current: events(filter: { isCurrent: true }, limit: 1) {
    id
    name
    deadlineTime
    finished
  }
  next: events(filter: { isNext: true }, limit: 1) {
    id
    name
    deadlineTime
    finished
  }
}
```
**Result**:
```json
{
  "data": {
    "current": [{
      "id": 22,
      "name": "Gameweek 22",
      "deadlineTime": "2026-01-17T11:00:00.000Z",
      "finished": false
    }],
    "next": [{
      "id": 23,
      "name": "Gameweek 23",
      "deadlineTime": "2026-01-24T11:00:00.000Z",
      "finished": false
    }]
  }
}
```

#### Test 4: Single Event with All Fields
```graphql
query {
  event(id: 23) {
    id
    name
    deadlineTime
    deadlineTimeEpoch
    isPrevious
    isCurrent
    isNext
  }
}
```
**Result**:
```json
{
  "data": {
    "event": {
      "id": 23,
      "name": "Gameweek 23",
      "deadlineTime": "2026-01-24T11:00:00.000Z",
      "deadlineTimeEpoch": 1769252400,
      "isPrevious": false,
      "isCurrent": false,
      "isNext": true
    }
  }
}
```

---

## Code Changes

### Repository
- **File**: `src/domains/events/repository.ts`
- **Change**: Removed `toIso()` conversion - deadline_time now passes through as-is
- **Reason**: Database stores ISO 8601 strings directly

```typescript
// Before
deadlineTime: toIso(row.deadline_time),

// After
deadlineTime: row.deadline_time, // Already ISO 8601 string from DB
```

---

## Notes

- ✅ All existing data was successfully converted to ISO 8601 format
- ✅ GraphQL DateTime scalar adds milliseconds (`.000`) - this is expected behavior
- ✅ Database stores exact format: `"2026-01-24T11:00:00Z"` (20 chars)
- ✅ No breaking changes to GraphQL API
- ✅ Timezone info now preserved in database (UTC: `Z` suffix)

---

## Benefits

1. **Accurate Format**: Stores exact ISO 8601 string from source API
2. **No Conversion**: Eliminates timezone conversion issues
3. **Simpler Import**: Data sync/import scripts can store strings directly
4. **Explicit Timezone**: UTC timezone (`Z`) is now explicit in the data
5. **Type Safety**: String type matches GraphQL schema expectation

---

## Migration Command

```bash
# Run migration
bun run migrate:deadline

# Verify results
bun scripts/verify-deadline.ts
```

---

## Conclusion

✅ **Migration Successful**  
✅ **All Integration Tests Passing**  
✅ **No Breaking Changes**  
✅ **Data Format Improved**

The `deadline_time` field now correctly stores ISO 8601 strings with UTC timezone: `"2026-01-24T11:00:00Z"`
