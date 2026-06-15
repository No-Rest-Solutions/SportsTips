/**
 * Promos Research Module
 * 
 * Fetches team form, injuries, stats, and other research factors
 * for promo slip generation. Includes caching to avoid repeated API calls.
 * 
 * Sources:
 * - Flashscore API for recent match results
 * - AFL.com.au for AFL team/player data
 * - NRL.com.au for NRL team/player data
 * - ATP.com for tennis rankings
 * - League-specific websites for soccer
 * - Google web scraping (fallback)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, '../research-cache');
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Ensure cache dir exists
try {
  await fs.mkdir(CACHE_DIR, { recursive: true });
} catch {
  // Already exists
}

/**
 * Cached fetch wrapper
 * @param {string} cacheKey - Unique cache identifier
 * @param {Function} fetchFn - Async function to call if cache miss
 * @param {number} ttlMs - Cache TTL in ms
 * @returns {Promise<any>}
 */
async function cachedFetch(cacheKey, fetchFn, ttlMs = CACHE_TTL_MS) {
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  
  try {
    const stat = await fs.stat(cacheFile);
    if (Date.now() - stat.mtimeMs < ttlMs) {
      const cached = await fs.readFile(cacheFile, 'utf8');
      return JSON.parse(cached);
    }
  } catch {
    // Cache miss or file doesn't exist
  }

  try {
    const result = await fetchFn();
    await fs.writeFile(cacheFile, JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.error(`[promos-research] Fetch failed for ${cacheKey}:`, err.message);
    throw err;
  }
}

/**
 * Fetch recent form (last N matches) for a team
 * @param {string} sport - 'afl' | 'nrl' | 'soccer' | 'tennis'
 * @param {string} teamName - Team or player name
 * @returns {Promise<Array>} Recent matches
 */
export async function fetchRecentForm(sport, teamName) {
  const cacheKey = `form-${sport}-${teamName}`.toLowerCase().replace(/\s+/g, '-');
  
  return cachedFetch(cacheKey, async () => {
    // Placeholder implementation - will be expanded per sport
    console.log(`[promos-research] Fetching form for ${sport} - ${teamName}`);
    
    switch (sport.toLowerCase()) {
      case 'afl':
        return fetchAFLTeamForm(teamName);
      case 'nrl':
        return fetchNRLTeamForm(teamName);
      case 'soccer':
        return fetchSoccerTeamForm(teamName);
      case 'tennis':
        return fetchTennisPlayerForm(teamName);
      default:
        return [];
    }
  });
}

/**
 * Fetch AFL team form from afl.com.au
 * @param {string} teamName
 * @returns {Promise<Array>}
 */
async function fetchAFLTeamForm(teamName) {
  try {
    // TODO: Implement AFL.com.au scraping
    // For now, return placeholder
    console.log(`[promos-research] AFL form for ${teamName} (placeholder)`);
    return [
      { date: '2026-05-31', opponent: 'Geelong', result: 'win', score: '105-92' },
      { date: '2026-05-24', opponent: 'Melbourne', result: 'loss', score: '88-95' },
      { date: '2026-05-17', opponent: 'Sydney', result: 'win', score: '112-87' }
    ];
  } catch (err) {
    console.error(`[promos-research] Failed to fetch AFL form for ${teamName}:`, err.message);
    return [];
  }
}

/**
 * Fetch NRL team form from nrl.com.au
 * @param {string} teamName
 * @returns {Promise<Array>}
 */
async function fetchNRLTeamForm(teamName) {
  try {
    // TODO: Implement NRL.com.au scraping
    console.log(`[promos-research] NRL form for ${teamName} (placeholder)`);
    return [
      { date: '2026-05-31', opponent: 'Melbourne', result: 'win', score: '24-18' },
      { date: '2026-05-24', opponent: 'Sydney', result: 'loss', score: '12-20' },
      { date: '2026-05-17', opponent: 'Brisbane', result: 'win', score: '28-16' }
    ];
  } catch (err) {
    console.error(`[promos-research] Failed to fetch NRL form for ${teamName}:`, err.message);
    return [];
  }
}

/**
 * Fetch soccer team form
 * @param {string} teamName
 * @returns {Promise<Array>}
 */
async function fetchSoccerTeamForm(teamName) {
  try {
    // TODO: Implement Flashscore/league-specific scraping
    console.log(`[promos-research] Soccer form for ${teamName} (placeholder)`);
    return [
      { date: '2026-05-31', opponent: 'Team A', result: 'win', score: '2-0' },
      { date: '2026-05-25', opponent: 'Team B', result: 'draw', score: '1-1' },
      { date: '2026-05-18', opponent: 'Team C', result: 'loss', score: '0-1' }
    ];
  } catch (err) {
    console.error(`[promos-research] Failed to fetch soccer form for ${teamName}:`, err.message);
    return [];
  }
}

/**
 * Fetch tennis player form from ATP
 * @param {string} playerName
 * @returns {Promise<Array>}
 */
async function fetchTennisPlayerForm(playerName) {
  try {
    // TODO: Implement ATP.com scraping
    console.log(`[promos-research] Tennis form for ${playerName} (placeholder)`);
    return [
      { date: '2026-06-01', tournament: 'French Open', result: 'win', opponent: 'Player A' },
      { date: '2026-05-28', tournament: 'French Open', result: 'win', opponent: 'Player B' },
      { date: '2026-05-15', tournament: 'Other', result: 'loss', opponent: 'Player C' }
    ];
  } catch (err) {
    console.error(`[promos-research] Failed to fetch tennis form for ${playerName}:`, err.message);
    return [];
  }
}

/**
 * Fetch injury information for a team/player
 * @param {string} sport
 * @param {string} teamOrPlayer
 * @returns {Promise<Array>}
 */
export async function fetchInjuryInfo(sport, teamOrPlayer) {
  const cacheKey = `injuries-${sport}-${teamOrPlayer}`.toLowerCase().replace(/\s+/g, '-');
  
  return cachedFetch(cacheKey, async () => {
    console.log(`[promos-research] Fetching injuries for ${sport} - ${teamOrPlayer}`);
    
    switch (sport.toLowerCase()) {
      case 'afl':
        return fetchAFLInjuries(teamOrPlayer);
      case 'nrl':
        return fetchNRLInjuries(teamOrPlayer);
      case 'soccer':
        return fetchSoccerInjuries(teamOrPlayer);
      case 'tennis':
        return []; // Tennis doesn't use team injuries
      default:
        return [];
    }
  }, CACHE_TTL_MS / 2); // Injuries change frequently, shorter cache
}

async function fetchAFLInjuries(teamName) {
  try {
    // TODO: Implement AFL injury scraping
    console.log(`[promos-research] AFL injuries for ${teamName} (placeholder)`);
    return [
      { player: 'Key Player A', status: 'out', estimatedReturn: '2026-06-15' },
      { player: 'Key Player B', status: 'doubtful', estimatedReturn: '2026-06-08' }
    ];
  } catch (err) {
    console.error(`[promos-research] Failed to fetch AFL injuries:`, err.message);
    return [];
  }
}

async function fetchNRLInjuries(teamName) {
  try {
    // TODO: Implement NRL injury scraping
    console.log(`[promos-research] NRL injuries for ${teamName} (placeholder)`);
    return [];
  } catch (err) {
    console.error(`[promos-research] Failed to fetch NRL injuries:`, err.message);
    return [];
  }
}

async function fetchSoccerInjuries(teamName) {
  try {
    // TODO: Implement soccer injury scraping
    console.log(`[promos-research] Soccer injuries for ${teamName} (placeholder)`);
    return [];
  } catch (err) {
    console.error(`[promos-research] Failed to fetch soccer injuries:`, err.message);
    return [];
  }
}

/**
 * Fetch player statistics
 * @param {string} sport
 * @param {string} playerName
 * @param {string} statType - e.g., 'disposals', 'goals', 'assists'
 * @returns {Promise<Object>}
 */
export async function fetchPlayerStats(sport, playerName, statType) {
  const cacheKey = `stats-${sport}-${playerName}-${statType}`.toLowerCase().replace(/\s+/g, '-');
  
  return cachedFetch(cacheKey, async () => {
    console.log(`[promos-research] Fetching ${statType} stats for ${sport} - ${playerName}`);
    
    // Placeholder
    return {
      player: playerName,
      sport,
      statType,
      average: 25,
      last5Games: [24, 28, 22, 26, 21],
      trend: 'stable'
    };
  });
}

/**
 * Fetch head-to-head history between two teams/players
 * @param {string} sport
 * @param {string} entity1
 * @param {string} entity2
 * @returns {Promise<Array>}
 */
export async function fetchHeadToHead(sport, entity1, entity2) {
  const cacheKey = `h2h-${sport}-${entity1}-${entity2}`.toLowerCase().replace(/\s+/g, '-');
  
  return cachedFetch(cacheKey, async () => {
    console.log(`[promos-research] Fetching H2H for ${sport} - ${entity1} vs ${entity2}`);
    
    // Placeholder
    return [
      { date: '2026-05-01', winner: entity1, score: '2-1' },
      { date: '2026-04-01', winner: entity2, score: '1-2' },
      { date: '2026-03-01', winner: entity1, score: '3-0' }
    ];
  });
}

/**
 * Calculate research confidence score (0-100)
 * Takes recent form, injuries, H2H into account
 * @param {string} sport
 * @param {string} teamOrPlayer
 * @param {Object} legs - Legs being evaluated
 * @returns {Promise<number>}
 */
export async function calculateResearchConfidence(sport, teamOrPlayer, legs) {
  try {
    const form = await fetchRecentForm(sport, teamOrPlayer);
    const injuries = await fetchInjuryInfo(sport, teamOrPlayer);
    
    let score = 50; // Base score
    
    // Recent form bonus
    if (form.length > 0) {
      const wins = form.slice(0, 3).filter(m => m.result === 'win').length;
      score += wins * 10; // +10 per recent win (max +30)
    }
    
    // Injury penalty
    if (injuries.length > 0) {
      const outCount = injuries.filter(i => i.status === 'out').length;
      score -= outCount * 15; // -15 per injured key player
    }
    
    // Ensure score stays in bounds
    return Math.max(0, Math.min(100, score));
  } catch (err) {
    console.error(`[promos-research] Error calculating confidence:`, err.message);
    return 50; // Default neutral score on error
  }
}

/**
 * Get research summary for logging/validation
 * @param {string} sport
 * @param {Array} legs
 * @returns {Promise<Object>}
 */
export async function getResearchSummary(sport, legs) {
  try {
    const summary = {
      sport,
      legCount: legs.length,
      details: []
    };

    for (const leg of legs) {
      const entity = leg.player || leg.team;
      // Prefer the leg's own market-derived confidence (real signal from the
      // live snapshot). Only fall back to the slower form/injury research when a
      // leg arrives without one.
      const confidence = Number.isFinite(leg.confidence)
        ? leg.confidence
        : await calculateResearchConfidence(sport, entity, legs);

      summary.details.push({
        entity,
        confidence,
        passed: confidence >= 40 // Adjust threshold as needed
      });
    }

    summary.overallScore = Math.round(
      summary.details.reduce((sum, d) => sum + d.confidence, 0) / summary.details.length
    );
    summary.allLegsPass = summary.details.every(d => d.passed);

    return summary;
  } catch (err) {
    console.error(`[promos-research] Error getting research summary:`, err.message);
    return {
      sport,
      legCount: legs.length,
      overallScore: 50,
      allLegsPass: false,
      details: [],
      error: err.message
    };
  }
}

/**
 * Clear cache (for testing or manual reset)
 * @param {string} pattern - Optional glob pattern to match
 */
export async function clearCache(pattern) {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const toDelete = pattern
      ? files.filter(f => f.includes(pattern))
      : files;

    for (const file of toDelete) {
      await fs.unlink(path.join(CACHE_DIR, file));
    }
    
    console.log(`[promos-research] Cleared ${toDelete.length} cache files`);
  } catch (err) {
    console.error(`[promos-research] Error clearing cache:`, err.message);
  }
}

export const __testables = {
  fetchAFLTeamForm,
  fetchNRLTeamForm,
  fetchSoccerTeamForm,
  fetchTennisPlayerForm,
  fetchAFLInjuries,
  fetchNRLInjuries,
  fetchSoccerInjuries,
  cachedFetch
};
