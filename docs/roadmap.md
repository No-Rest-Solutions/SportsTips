```markdown
# Project Roadmap & To-Do List

## Immediate Priorities
1. **Price Jump Detection**
   - Implement in `analysis.mjs`
   - Compare current odds to original slip odds
   - Add threshold parameters to `config.json`

2. **GUI Integration**
   - Create "Force Check Slips" button
   - Target `desktop/` folder for GUI implementation
   - Integrate with existing `Tipping Bot.vbs` interface

3. **Real API Integration**
   - ESPN, AFL, NRL, TAB APIs
   - Replace placeholder research functions
   - Add rate-limiting and caching

4. **Daemon Scheduler Integration**
   - Update `index.mjs` to include new jobs
   - Add error tracking and logging

## Future Enhancements
- **Sports-Specific Rules**
  - AFL/NRL same-game multi validation
  - Soccer/Tennis H2H validity checks
  - Team availability verification

- **Advanced Analytics**
  - Correlation diversification analysis
  - Market sentiment filtering
  - Historical pattern recognition

- **Reporting System**
  - Daily performance benchmarks
  - Settlement statistics tracking
  - Risk management dashboards

## Quality Assurance
- Implement comprehensive test suite
- Add unit tests for all new features
- Create validation rules for:
  - Price jumps
  - Leg matching
  - Settlement calculations
  - Confidence scoring
```