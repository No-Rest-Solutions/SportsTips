```markdown
# Implemented Features Reference

## Promo System Implementation
### 1. Research Layer
- **File**: `promos-research.mjs`
- **Functions**:
  - `fetchRecentForm()` - Team/player form analysis
  - `fetchInjuryInfo()` - Injury status tracking
  - `fetchHeadToHead()` - Historical match analysis
  - `calculateResearchConfidence()` - 0-100 confidence scoring
  - `getResearchSummary()` - Batch research analysis

### 2. Configuration System
- **File**: `promos-config.mjs`
- **Functions**:
  - `loadPromoConfig()` - Config loader/validator
  - `getActivePromos()` - Get promos for date
  - `validatePromoSlip()` - Validate legs against promo rules

### 3. Generation Engine
- **File**: `promos-generator.mjs`
- **Functions**:
  - `generatePromoSlip()` - Create single promo slip
  - `selectLegsForOddsRange()` - Greedy leg selection algorithm
  - `buildSlipId()` - Generate unique slip IDs

### 4. Settlement Logic
- **File**: `promos-settlement.mjs`
- **Functions**:
  - `settlePromoSlip()` - Match legs to results
  - `calculateSlipOutcome()` - Win/loss/void/pending determination
  - `logSettlementToTracker()` - CSV logging

### 5. Formatting System
- **File**: `promos-formatter.mjs`
- **Functions**:
  - `buildPromoEmbedMessage()` - Discord embed generation
  - `buildDailyPromoReport()` - Markdown report creation
  - `getColorForConfidence()` - Confidence-based color coding
```