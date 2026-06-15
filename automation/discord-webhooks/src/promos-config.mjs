/**
 * Promos Configuration Module
 * 
 * Loads, validates, and manages promo configurations.
 * Handles active/schedule checking and provides config access.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(here, './promos-config.json');

let cachedConfig = null;

/**
 * Load promos configuration from file
 * @returns {Promise<Object>}
 */
export async function loadPromoConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf8');
    cachedConfig = JSON.parse(content);
    validateConfig(cachedConfig);
    return cachedConfig;
  } catch (err) {
    console.error(`[promos-config] Failed to load config:`, err.message);
    throw new Error(`Invalid or missing promos-config.json: ${err.message}`);
  }
}

/**
 * Validate promo config structure
 * @param {Object} config
 */
function validateConfig(config) {
  if (!config.promos || !Array.isArray(config.promos)) {
    throw new Error('Config must contain "promos" array');
  }

  for (const promo of config.promos) {
    if (!promo.id || typeof promo.id !== 'string') {
      throw new Error('Each promo must have a string "id"');
    }
    if (!promo.sport || typeof promo.sport !== 'string') {
      throw new Error(`Promo ${promo.id} must have a string "sport"`);
    }
    if (!promo.type || typeof promo.type !== 'string') {
      throw new Error(`Promo ${promo.id} must have a string "type"`);
    }
    if (!Number.isFinite(promo.legCount) || promo.legCount < 1) {
      throw new Error(`Promo ${promo.id} must have legCount >= 1`);
    }
    if (!Number.isFinite(promo.minOdds) || promo.minOdds < 1) {
      throw new Error(`Promo ${promo.id} must have minOdds >= 1`);
    }
    if (!Number.isFinite(promo.maxOdds) || promo.maxOdds < promo.minOdds) {
      throw new Error(`Promo ${promo.id} maxOdds must be >= minOdds`);
    }
    if (promo.webhook !== undefined && typeof promo.webhook !== 'string') {
      throw new Error(`Promo ${promo.id} webhook must be a string channel key`);
    }
    validatePromoSettlementRule(promo);
  }
}

const PROMO_SETTLEMENT_RULE_TYPES = new Set(['standard', 'leg-insurance', 'margin-forgiveness']);

/**
 * Validate a promo's optional settlementRule.
 * @param {Object} promo
 */
function validatePromoSettlementRule(promo) {
  const rule = promo.settlementRule;
  if (rule === undefined) {
    return; // defaults to standard at settlement time
  }
  if (typeof rule !== 'object' || rule === null) {
    throw new Error(`Promo ${promo.id} settlementRule must be an object`);
  }
  if (!PROMO_SETTLEMENT_RULE_TYPES.has(String(rule.type))) {
    throw new Error(`Promo ${promo.id} settlementRule.type must be one of: ${[...PROMO_SETTLEMENT_RULE_TYPES].join(', ')}`);
  }
  if (rule.type === 'leg-insurance' && rule.insuredLegs !== undefined
    && (!Number.isFinite(rule.insuredLegs) || rule.insuredLegs < 0)) {
    throw new Error(`Promo ${promo.id} settlementRule.insuredLegs must be a number >= 0`);
  }
  if (rule.type === 'margin-forgiveness' && rule.marginTolerance !== undefined
    && (!Number.isFinite(rule.marginTolerance) || rule.marginTolerance < 0)) {
    throw new Error(`Promo ${promo.id} settlementRule.marginTolerance must be a number >= 0`);
  }
}

/**
 * Get all active promos for today
 * @param {Date} date - Date to check (default: now)
 * @returns {Promise<Array>}
 */
export async function getActivePromos(date = new Date()) {
  const config = await loadPromoConfig();
  const dayName = getDayName(date);

  return config.promos.filter(promo => {
    if (!promo.active) {
      return false;
    }
    if (!Array.isArray(promo.daysActive) || promo.daysActive.length === 0) {
      return true; // No day restriction = active all days
    }
    return promo.daysActive.includes(dayName);
  });
}

/**
 * Get a specific promo by ID
 * @param {string} promoId
 * @returns {Promise<Object|null>}
 */
export async function getPromoById(promoId) {
  const config = await loadPromoConfig();
  return config.promos.find(p => p.id === promoId) || null;
}

/**
 * Get all promos of a specific sport
 * @param {string} sport - 'afl', 'nrl', 'tennis', 'soccer'
 * @returns {Promise<Array>}
 */
export async function getPromosBySport(sport) {
  const config = await loadPromoConfig();
  return config.promos.filter(p => p.sport.toLowerCase() === sport.toLowerCase());
}

/**
 * Check if a promo is active right now
 * @param {string} promoId
 * @param {Date} date
 * @returns {Promise<boolean>}
 */
export async function isPromoActive(promoId, date = new Date()) {
  const promo = await getPromoById(promoId);
  if (!promo || !promo.active) {
    return false;
  }

  const dayName = getDayName(date);
  if (Array.isArray(promo.daysActive) && promo.daysActive.length > 0) {
    return promo.daysActive.includes(dayName);
  }

  return true;
}

/**
 * Reload config from file (cache invalidation)
 * @returns {Promise<Object>}
 */
export async function reloadPromoConfig() {
  cachedConfig = null;
  return loadPromoConfig();
}

/**
 * Get day name for date
 * @param {Date} date
 * @returns {string}
 */
function getDayName(date) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[date.getDay()];
}

/**
 * Validate a promo slip configuration against promo rules
 * @param {Object} promo - The promo config
 * @param {Array} legs - The selected legs
 * @returns {Object} Validation result
 */
export function validatePromoSlip(promo, legs) {
  const errors = [];
  const warnings = [];

  // Check leg count
  if (legs.length !== promo.legCount) {
    errors.push(`Expected ${promo.legCount} legs, got ${legs.length}`);
  }

  // Calculate combined odds
  const combinedOdds = legs.reduce((acc, leg) => acc * leg.odds, 1);

  if (combinedOdds < promo.minOdds) {
    errors.push(`Combined odds ${combinedOdds.toFixed(2)}x below minimum ${promo.minOdds}x`);
  }

  if (combinedOdds > promo.maxOdds) {
    warnings.push(`Combined odds ${combinedOdds.toFixed(2)}x exceeds target ${promo.maxOdds}x`);
  }

  // Check for duplicate teams (in same-game multis)
  if (promo.type === 'same-game-multi') {
    const matchIds = new Set();
    for (const leg of legs) {
      if (leg.matchId) {
        if (matchIds.has(leg.matchId)) {
          warnings.push(`Multiple legs from same match detected`);
        }
        matchIds.add(leg.matchId);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    combinedOdds,
    slipIsValid: errors.length === 0
  };
}

export const __testables = {
  getDayName,
  validateConfig
};
