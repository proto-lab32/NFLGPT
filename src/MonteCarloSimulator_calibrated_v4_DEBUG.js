'use client'

import React, { useState } from "react";
import { Upload, Play, BarChart3, TrendingUp, Database, AlertCircle } from "lucide-react";

/**
 * NFL Monte Carlo Simulator - OPTIMIZED MODEL v2.0
 * 
 * ============================================
 * OPTIMIZATION CHANGES (Based on 120-Game Backtest Analysis)
 * ============================================
 * 
 * VARIANCE CALIBRATION:
 * - sigmaMargin: 6.5-9.5 → 9.5-13.5 (matches empirical NFL variance)
 * - sigmaTotal: 7.5-12.0 → 10.5-15.5 (matches empirical NFL variance)
 * - Root cause fix for 80%+ plays hitting at 55% instead of 85%
 * 
 * HOME FIELD ADVANTAGE:
 * - HOME_FIELD_ADV: 2.3 → 1.5 (reduces away team bias)
 * 
 * CER WEIGHTS:
 * - off_TO: -0.03 → -0.10 (turnovers properly penalized)
 * 
 * OUTDOOR PENALTY:
 * - Now applied to BOTH margins AND totals (was margins only)
 * - Fixes +0.48 point over-projection bias
 * 
 * BUCKET SYSTEM OVERHAUL:
 * - Removed complex compound buckets (were based on n=2-7 samples)
 * - Removed blanket FAV death zone (was based on 15 games)
 * - Removed asymmetric OVER/UNDER filtering (OVER was 61% but blocked)
 * - Replaced with simple probability threshold system (>54% = approved)
 * - FAV/DOG and OVER/UNDER tracked for reporting, not filtering
 * 
 * RETAINED FROM PREVIOUS VERSION:
 * - LAMBDA = 0.85 (team differentiation)
 * - CER_TO_PPD_SCALE = 0.60 (spread differentiation)
 * - Asymmetric HFA for margins, symmetric for totals
 * - Weather adjustments and game script logic
 * - Dynamic league averages from CSV
 */

const NFLTotalsSimulator = () => {
  // State management
  const [teams, setTeams] = useState([]);
  const [selectedHomeTeam, setSelectedHomeTeam] = useState(null);
  const [selectedAwayTeam, setSelectedAwayTeam] = useState(null);
  const [csvUploaded, setCsvUploaded] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [gameSettings, setGameSettings] = useState({
    overUnderLine: 44.5,
    homeTeamTotal: 23.5,
    awayTeamTotal: 21.0,
    spread: -3.0,
    spreadLine: -3.0,
    numSimulations: 10000,
    isDome: false,
    windMPH: 0,
    temperature: 70,
    precipitation: "none"
  });
  const [simulationResults, setSimulationResults] = useState(null);
  const [isSimulating, setIsSimulating] = useState(false);
  
  // Batch processing state
  const [batchGames, setBatchGames] = useState([]);
  const [batchResults, setBatchResults] = useState([]);
  const [isBatchSimulating, setIsBatchSimulating] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [showBatchMode, setShowBatchMode] = useState(false);

  // ============================================
  // LEAGUE PARAMETERS - DYNAMICALLY CALCULATED
  // ============================================
  const [leagueParams, setLeagueParams] = useState({
    lg: {
      // === CORE EFFICIENCY METRICS (Offense) ===
      PPD: 2.07488,           
      PPD_sd: 0.42745,
      EPA: -0.00084,          
      EPA_sd: 0.09376,
      SR: 0.43625,            
      SR_sd: 0.03501,
      RZTD: 0.57717,          
      RZTD_sd: 0.08942,
      TO_pct: 0.10805,        
      TO_pct_sd: 0.03007,
      RZDrives: 3.27107,      
      RZDrives_sd: 0.63882,
      
      // === CORE EFFICIENCY METRICS (Defense) ===
      PPD_def: 2.07108,       
      PPD_def_sd: 0.32496,
      EPA_def: -0.00050,      
      EPA_def_sd: 0.07836,
      SR_def: 0.43604,        
      SR_def_sd: 0.03169,
      RZTD_def: 0.57712,      
      RZTD_def_sd: 0.06917,
      TO_pct_def: 0.10805,    
      TO_pct_def_sd: 0.03007,
      RZDrives_def: 3.27533,  
      RZDrives_def_sd: 0.50185,
      
      // === PACE METRICS ===
      Drives: 10.79735,       
      Drives_sd: 0.61829,
      SecSnap: 28.51460,      
      SecSnap_sd: 1.04923,
      PlaysPerDrive: 5.69904, 
      PlaysPerDrive_sd: 0.44626,
      ThreeOut: 0.20567,      
      ThreeOut_sd: 0.03964,
      Xpl: 0.08818,           
      Xpl_sd: 0.01459,
      NoHuddle: 0.10190,      
      NoHuddle_sd: 0.11488,
      Pen: 0.35424,           
      Pen_sd: 0.06476,
      PassRate: 0.54922,      
      PassRate_sd: 0.04747,
      
      // === DEFENSIVE PACE ===
      Drives_def: 10.79616,
      Drives_def_sd: 0.61571,
      ThreeOut_def: 0.20558,  
      ThreeOut_def_sd: 0.04722,
      Xpl_def: 0.08802,       
      Xpl_def_sd: 0.01661,
      PlaysPerDrive_def: 5.69806,
      PlaysPerDrive_def_sd: 0.36760,
      SecSnap_def: 28.52732,
      SecSnap_def_sd: 1.25079,
      Pen_def: 0.35429,
      Pen_def_sd: 0.05821,
      
      // === OTHER ===
      StartingFP: 30.50313,   
      StartingFP_sd: 1.38715,
    }
  });

  /**
   * Calculate mean and standard deviation of an array
   */
  const calcStats = (values) => {
    const validValues = values.filter(v => v !== null && v !== undefined && !isNaN(v));
    if (validValues.length === 0) return { mean: 0, sd: 1 };
    const mean = validValues.reduce((a, b) => a + b, 0) / validValues.length;
    const variance = validValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / validValues.length;
    const sd = Math.sqrt(variance) || 0.001;
    return { mean, sd };
  };

  /**
   * Calculate league averages from uploaded team data
   */
  const calculateLeagueAverages = (teamData) => {
    console.log("=== CALCULATING LEAGUE AVERAGES FROM UPLOADED DATA ===");
    
    const extractValues = (possibleNames, isPercent = false) => {
      return teamData.map(team => {
        const val = findValue(team, possibleNames);
        if (val === null || val === undefined || val === '') return null;
        return isPercent ? parsePercent(val) : parseFloat(val);
      }).filter(v => v !== null && !isNaN(v));
    };
    
    // Offensive metrics
    const ppdVals = extractValues(['Offensive Pts/Drive', 'Offensive PPD', 'PPD']);
    const epaVals = extractValues(['Offensive EPA/Play', 'Offensive EPA/play', 'EPA/play']);
    const srVals = extractValues(['Offensive Success Rate', 'Offensive Success rate', 'SR'], true);
    const rztdVals = extractValues(['Offensive Red Zone TD Rate', 'Offensive RZ TD%', 'RZ TD%'], true);
    const toVals = extractValues(['Offensive TO%', 'TO%', 'Turnover%'], true);
    const rzDrivesVals = extractValues(['Offensive Red Zone Drives/Game', 'RZ Drives/Game']);
    
    // Defensive metrics
    const ppdDefVals = extractValues(['Defensive Pts/Drive', 'Defensive PPD', 'Def PPD']);
    const epaDefVals = extractValues(['Defensive EPA/Play', 'Defensive EPA/play', 'Def EPA']);
    const srDefVals = extractValues(['Defensive Success Rate', 'Defensive Success rate', 'Def SR'], true);
    const rztdDefVals = extractValues(['Defensive Red Zone TD Rate', 'Defensive RZ TD%', 'Def RZ TD%'], true);
    const toDefVals = extractValues(['Defensive TO%', 'Def TO%', 'Forced TO%'], true);
    const rzDrivesDefVals = extractValues(['Defensive Red Zone Drives/Game', 'Def RZ Drives/Game']);
    
    // Pace metrics
    const drivesVals = extractValues(['Offensive Drives/Game', 'Drives/Game', 'Drives']);
    const secSnapVals = extractValues(['Offensive Seconds/Snap', 'Offensive Sec/snap', 'SecSnap']);
    const playsPerDriveVals = extractValues(['Offensive Plays/Drive', 'Plays/Drive']);
    const threeOutVals = extractValues(['Off 3-out Rate', 'Offensive 3-out Rate', '3-out Rate'], true);
    const xplVals = extractValues(['Offensive Explosive Play Rate', 'Offensive Explosive rate'], true);
    const noHuddleVals = extractValues(['Offensive No Huddle Rate', 'No Huddle Rate'], true);
    const penVals = extractValues(['Offensive Penalties/Drive', 'Penalties/Drive']);
    const passRateVals = extractValues(['Offensive Early Down Pass Rate', 'Early Down Pass Rate'], true);
    
    // Defensive pace
    const drivesDefVals = extractValues(['Defensive Drives/Game', 'Def Drives/Game']);
    const threeOutDefVals = extractValues(['Defensive 3-out Rate', 'Def 3-out Rate'], true);
    const xplDefVals = extractValues(['Defensive Explosive Play Rate', 'Def Explosive rate'], true);
    const playsPerDriveDefVals = extractValues(['Defensive Plays/Drive', 'Def Plays/Drive']);
    const secSnapDefVals = extractValues(['Defensive Seconds/Snap', 'Def Sec/snap']);
    const penDefVals = extractValues(['Defensive Penalties/Drive', 'Def Penalties/Drive']);
    
    // Calculate stats
    const ppdStats = calcStats(ppdVals);
    const epaStats = calcStats(epaVals);
    const srStats = calcStats(srVals);
    const rztdStats = calcStats(rztdVals);
    const toStats = calcStats(toVals);
    const rzDrivesStats = calcStats(rzDrivesVals);
    
    const ppdDefStats = calcStats(ppdDefVals);
    const epaDefStats = calcStats(epaDefVals);
    const srDefStats = calcStats(srDefVals);
    const rztdDefStats = calcStats(rztdDefVals);
    const toDefStats = calcStats(toDefVals);
    const rzDrivesDefStats = calcStats(rzDrivesDefVals);
    
    const drivesStats = calcStats(drivesVals);
    const secSnapStats = calcStats(secSnapVals);
    const playsPerDriveStats = calcStats(playsPerDriveVals);
    const threeOutStats = calcStats(threeOutVals);
    const xplStats = calcStats(xplVals);
    const noHuddleStats = calcStats(noHuddleVals);
    const penStats = calcStats(penVals);
    const passRateStats = calcStats(passRateVals);
    
    const drivesDefStats = calcStats(drivesDefVals);
    const threeOutDefStats = calcStats(threeOutDefVals);
    const xplDefStats = calcStats(xplDefVals);
    const playsPerDriveDefStats = calcStats(playsPerDriveDefVals);
    const secSnapDefStats = calcStats(secSnapDefVals);
    const penDefStats = calcStats(penDefVals);
    
    const newParams = {
      lg: {
        PPD: ppdStats.mean || 2.07,
        PPD_sd: ppdStats.sd || 0.43,
        EPA: epaStats.mean || 0,
        EPA_sd: epaStats.sd || 0.09,
        SR: srStats.mean || 0.44,
        SR_sd: srStats.sd || 0.035,
        RZTD: rztdStats.mean || 0.58,
        RZTD_sd: rztdStats.sd || 0.09,
        TO_pct: toStats.mean || 0.11,
        TO_pct_sd: toStats.sd || 0.03,
        RZDrives: rzDrivesStats.mean || 3.27,
        RZDrives_sd: rzDrivesStats.sd || 0.64,
        
        PPD_def: ppdDefStats.mean || 2.07,
        PPD_def_sd: ppdDefStats.sd || 0.32,
        EPA_def: epaDefStats.mean || 0,
        EPA_def_sd: epaDefStats.sd || 0.08,
        SR_def: srDefStats.mean || 0.44,
        SR_def_sd: srDefStats.sd || 0.032,
        RZTD_def: rztdDefStats.mean || 0.58,
        RZTD_def_sd: rztdDefStats.sd || 0.07,
        TO_pct_def: toDefStats.mean || 0.11,
        TO_pct_def_sd: toDefStats.sd || 0.03,
        RZDrives_def: rzDrivesDefStats.mean || 3.28,
        RZDrives_def_sd: rzDrivesDefStats.sd || 0.50,
        
        Drives: drivesStats.mean || 10.8,
        Drives_sd: drivesStats.sd || 0.62,
        SecSnap: secSnapStats.mean || 28.5,
        SecSnap_sd: secSnapStats.sd || 1.05,
        PlaysPerDrive: playsPerDriveStats.mean || 5.7,
        PlaysPerDrive_sd: playsPerDriveStats.sd || 0.45,
        ThreeOut: threeOutStats.mean || 0.21,
        ThreeOut_sd: threeOutStats.sd || 0.04,
        Xpl: xplStats.mean || 0.088,
        Xpl_sd: xplStats.sd || 0.015,
        NoHuddle: noHuddleStats.mean || 0.10,
        NoHuddle_sd: noHuddleStats.sd || 0.11,
        Pen: penStats.mean || 0.35,
        Pen_sd: penStats.sd || 0.065,
        PassRate: passRateStats.mean || 0.55,
        PassRate_sd: passRateStats.sd || 0.047,
        
        Drives_def: drivesDefStats.mean || 10.8,
        Drives_def_sd: drivesDefStats.sd || 0.62,
        ThreeOut_def: threeOutDefStats.mean || 0.21,
        ThreeOut_def_sd: threeOutDefStats.sd || 0.047,
        Xpl_def: xplDefStats.mean || 0.088,
        Xpl_def_sd: xplDefStats.sd || 0.017,
        PlaysPerDrive_def: playsPerDriveDefStats.mean || 5.7,
        PlaysPerDrive_def_sd: playsPerDriveDefStats.sd || 0.37,
        SecSnap_def: secSnapDefStats.mean || 28.5,
        SecSnap_def_sd: secSnapDefStats.sd || 1.25,
        Pen_def: penDefStats.mean || 0.35,
        Pen_def_sd: penDefStats.sd || 0.058,
        
        StartingFP: 30.5,
        StartingFP_sd: 1.39,
      }
    };
    
    console.log("NEW LEAGUE AVERAGES:");
    console.log(`  PPD: ${newParams.lg.PPD.toFixed(3)} (sd: ${newParams.lg.PPD_sd.toFixed(3)})`);
    console.log(`  Drives: ${newParams.lg.Drives.toFixed(2)} (sd: ${newParams.lg.Drives_sd.toFixed(2)})`);
    
    return newParams;
  };
  
  // ============================================
  // OPTIMIZED MODEL PARAMETERS
  // ============================================
  const params = {
    lg: leagueParams.lg,
    
    // === CER WEIGHTS ===
    weights: {
      // Offensive CER weights
      off_PPD: 0.45,
      off_EPA: 0.20,
      off_SR: 0.15,
      off_RZTD: 0.10,
      off_RZDrives: 0.07,
      off_TO: -0.10,          // OPTIMIZED: Was -0.03, now properly penalizes turnovers
      
      // Defensive CER weights - v2.2: SYMMETRIC with offense (except TO)
      def_PPD: 0.45,
      def_EPA: 0.20,
      def_SR: 0.15,
      def_RZTD: 0.10,
      def_RZDrives: 0.07,
      def_TO: 0.03,   // Kept low - defensive turnovers are luck-driven
    },
    
    // Pace coefficients
    pace: {
      secSnap_coef: -0.08,
      playsPerDrive_coef: -0.05,
      threeOut_coef: 0.09,
      xpl_coef: 0.03,
      noHuddle_coef: 0.06,
      pen_coef: -0.03,
      passRate_coef: 0.015,
    },
    
    // Core parameters
    LAMBDA: 0.85,
    HOME_FIELD_ADV: 2.0,       // v2.2: Playoff HFA
    CER_TO_PPD_SCALE: 0.60,
    
    // Weather parameters
    weather: {
      dome_bonus: 0.5,
      wind_per_mph_above_threshold: -0.06,
      wind_threshold: 10,
      extreme_cold_threshold: 25,
      extreme_cold_penalty: -1.5,
      precip_adjustments: {
        none: 0,
        light_rain: -1.0,
        heavy_rain: -2.0,
        snow: -2.5,
      },
    },
  };

  const RHO_BASELINE = 0.22;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ============================================
  // HELPER FUNCTIONS
  // ============================================
  
  const findValue = (team, possibleNames) => {
    for (let name of possibleNames) {
      if (team[name] !== undefined && team[name] !== '') {
        return team[name];
      }
    }
    return null;
  };

  function parsePercent(val) {
    if (val == null || val === "") return null;
    const originalStr = String(val).trim();
    const hasPercentSign = originalStr.includes('%');
    const numStr = originalStr.replace('%', '').trim();
    const num = parseFloat(numStr);
    if (isNaN(num)) return null;
    
    if (hasPercentSign) {
      return num / 100;
    }
    if (num > 1) return num / 100;
    return num;
  }

  function zScore(value, mean, sd) {
    if (sd === 0) return 0;
    return (value - mean) / sd;
  }

  const toAmericanOdds = (prob) => {
    if (prob <= 0) return Infinity;
    if (prob >= 1) return -Infinity;
    return prob >= 0.5 
      ? -Math.round((prob / (1 - prob)) * 100)
      : Math.round(((1 - prob) / prob) * 100);
  };

  // ============================================
  // OPTIMIZED DECISION LAYER - Simplified Bet Selection
  // ============================================
  
  // Probability threshold for approval (break-even at -110 is ~52.4%)
  const APPROVAL_THRESHOLD = 54.0;
  
  /**
   * OPTIMIZED: Simplified spread bet evaluation
   * - Removed complex compound buckets (were based on n=2-7 samples)
   * - Removed blanket FAV death zone
   * - Uses simple probability threshold
   * - Tracks FAV/DOG for reporting, not filtering
   */
  const evaluateSpreadBet = (rawHomeCoverPct, rawAwayCoverPct, modelMargin, marketSpread) => {
    // Determine if home is favorite (negative spread = home favored)
    const homeIsFavorite = marketSpread < 0;
    const absSpread = Math.abs(marketSpread);
    
    // Determine which side the model likes
    const modelLikesHome = rawHomeCoverPct > rawAwayCoverPct;
    const modelLikesFavorite = (modelLikesHome && homeIsFavorite) || (!modelLikesHome && !homeIsFavorite);
    
    const relevantProb = modelLikesHome ? rawHomeCoverPct : rawAwayCoverPct;
    const signal = modelLikesHome ? 'HOME' : 'AWAY';
    const sideType = modelLikesFavorite ? 'FAV' : 'DOG';
    
    // Determine spread size category for reporting
    let spreadCategory = '';
    if (absSpread <= 3) spreadCategory = '0-3';
    else if (absSpread <= 7) spreadCategory = '3-7';
    else if (absSpread <= 10) spreadCategory = '7-10';
    else spreadCategory = '10+';
    
    // Simple approval logic: approve if probability exceeds threshold
    const approved = relevantProb >= APPROVAL_THRESHOLD;
    
    // Tier based on probability strength
    let tier = 0;
    if (relevantProb >= 60) tier = 1;
    else if (relevantProb >= 57) tier = 2;
    else if (relevantProb >= APPROVAL_THRESHOLD) tier = 3;
    
    // Descriptive bucket for reporting
    const bucket = approved 
      ? `✓ ${sideType} ${spreadCategory} @ ${relevantProb.toFixed(1)}%`
      : `✗ ${sideType} ${spreadCategory} @ ${relevantProb.toFixed(1)}%`;
    
    return {
      signal,
      rawProb: relevantProb,
      calibratedProb: relevantProb,
      modelLikesFavorite,
      sideType,
      spreadCategory,
      absSpread,
      tier,
      bucket,
      approved,
      modelMargin
    };
  };

  /**
   * OPTIMIZED: Simplified totals bet evaluation
   * - Removed asymmetric OVER/UNDER death zones
   * - Uses simple probability threshold
   * - Tracks edge and total size for reporting, not filtering
   */
  const evaluateTotalsBet = (rawOverPct, rawUnderPct, modelTotal, marketTotal, absSpread, isDome) => {
    const modelEdge = modelTotal - marketTotal;
    
    // Determine signal
    const signal = rawOverPct > rawUnderPct ? 'OVER' : 'UNDER';
    const relevantProb = signal === 'OVER' ? rawOverPct : rawUnderPct;
    
    // Determine total size category for reporting
    let totalCategory = '';
    if (marketTotal < 42) totalCategory = 'Low (<42)';
    else if (marketTotal <= 46) totalCategory = 'Mid (42-46)';
    else totalCategory = 'High (>46)';
    
    // Determine edge category for reporting
    let edgeCategory = '';
    if (modelEdge < -3) edgeCategory = 'Edge <-3';
    else if (modelEdge < 0) edgeCategory = 'Edge -3 to 0';
    else if (modelEdge < 3) edgeCategory = 'Edge 0 to 3';
    else edgeCategory = 'Edge 3+';
    
    // Simple approval logic: approve if probability exceeds threshold
    const approved = relevantProb >= APPROVAL_THRESHOLD;
    
    // Tier based on probability strength
    let tier = 0;
    if (relevantProb >= 60) tier = 1;
    else if (relevantProb >= 57) tier = 2;
    else if (relevantProb >= APPROVAL_THRESHOLD) tier = 3;
    
    // Descriptive bucket for reporting
    const bucket = approved
      ? `✓ ${signal} ${totalCategory} ${edgeCategory} @ ${relevantProb.toFixed(1)}%`
      : `✗ ${signal} ${totalCategory} ${edgeCategory} @ ${relevantProb.toFixed(1)}%`;
    
    return {
      signal,
      rawProb: relevantProb,
      calibratedProb: relevantProb,
      modelEdge,
      totalCategory,
      edgeCategory,
      tier,
      bucket,
      approved
    };
  };

  // ============================================
  // TIER 1: COMPOSITE EFFICIENCY RATING (CER)
  // ============================================
  
  function calculateOffensiveCER(team) {
    const getNumeric = (val, fallback) => {
      const parsed = parseFloat(val);
      return (val !== null && val !== undefined && val !== '' && !isNaN(parsed)) ? parsed : fallback;
    };
    const getPercent = (val, fallback) => {
      const parsed = parsePercent(val);
      return parsed !== null ? parsed : fallback;
    };
    
    const ppd = getNumeric(findValue(team, ['Offensive Pts/Drive', 'Offensive PPD', 'PPD']), params.lg.PPD);
    const epa = getNumeric(findValue(team, ['Offensive EPA/Play', 'Offensive EPA/play', 'EPA/play']), params.lg.EPA);
    const sr = getPercent(findValue(team, ['Offensive Success Rate', 'Offensive Success rate', 'SR']), params.lg.SR);
    const rztd = getPercent(findValue(team, ['Offensive Red Zone TD Rate', 'Offensive RZ TD%', 'RZ TD%']), params.lg.RZTD);
    const to_pct = getPercent(findValue(team, ['Offensive TO%', 'TO%', 'Turnover%']), params.lg.TO_pct);
    const rzDrives = getNumeric(findValue(team, ['Offensive Red Zone Drives/Game', 'RZ Drives/Game']), params.lg.RZDrives);
    
    const z_ppd = zScore(ppd, params.lg.PPD, params.lg.PPD_sd);
    const z_epa = zScore(epa, params.lg.EPA, params.lg.EPA_sd);
    const z_sr = zScore(sr, params.lg.SR, params.lg.SR_sd);
    const z_rztd = zScore(rztd, params.lg.RZTD, params.lg.RZTD_sd);
    const z_to = zScore(to_pct, params.lg.TO_pct, params.lg.TO_pct_sd);
    const z_rzDrives = zScore(rzDrives, params.lg.RZDrives, params.lg.RZDrives_sd);
    
    const CER = (
      params.weights.off_PPD * z_ppd +
      params.weights.off_EPA * z_epa +
      params.weights.off_SR * z_sr +
      params.weights.off_RZTD * z_rztd +
      params.weights.off_TO * z_to +
      params.weights.off_RZDrives * z_rzDrives
    );
    
    console.log(`  OFF CER ${team.Team}: PPD=${ppd.toFixed(2)} (z=${z_ppd.toFixed(2)}), EPA=${epa.toFixed(3)} (z=${z_epa.toFixed(2)}), SR=${(sr*100).toFixed(1)}% (z=${z_sr.toFixed(2)}), TO=${(to_pct*100).toFixed(1)}% (z=${z_to.toFixed(2)}) → CER=${CER.toFixed(3)}`);
    
    return {
      CER,
      components: { ppd, epa, sr, rztd, to_pct, rzDrives },
      zScores: { z_ppd, z_epa, z_sr, z_rztd, z_to, z_rzDrives }
    };
  }

  function calculateDefensiveCER(team) {
    const getNumeric = (val, fallback) => {
      const parsed = parseFloat(val);
      return (val !== null && val !== undefined && val !== '' && !isNaN(parsed)) ? parsed : fallback;
    };
    const getPercent = (val, fallback) => {
      const parsed = parsePercent(val);
      return parsed !== null ? parsed : fallback;
    };
    
    const ppd = getNumeric(findValue(team, ['Defensive Pts/Drive', 'Defensive PPD', 'Def PPD']), params.lg.PPD_def);
    const epa = getNumeric(findValue(team, ['Defensive EPA/Play', 'Defensive EPA/play', 'Def EPA']), params.lg.EPA_def);
    const sr = getPercent(findValue(team, ['Defensive Success Rate', 'Defensive Success rate', 'Def SR']), params.lg.SR_def);
    const rztd = getPercent(findValue(team, ['Defensive Red Zone TD Rate', 'Defensive RZ TD%', 'Def RZ TD%']), params.lg.RZTD_def);
    const to_forced = getPercent(findValue(team, ['Defensive TO%', 'Def TO%', 'Forced TO%']), params.lg.TO_pct_def);
    const rzDrives = getNumeric(findValue(team, ['Defensive Red Zone Drives/Game', 'Def RZ Drives/Game']), params.lg.RZDrives_def);
    
    const z_ppd = -zScore(ppd, params.lg.PPD_def, params.lg.PPD_def_sd);
    const z_epa = -zScore(epa, params.lg.EPA_def, params.lg.EPA_def_sd);
    const z_sr = -zScore(sr, params.lg.SR_def, params.lg.SR_def_sd);
    const z_rztd = -zScore(rztd, params.lg.RZTD_def, params.lg.RZTD_def_sd);
    const z_to = zScore(to_forced, params.lg.TO_pct_def, params.lg.TO_pct_def_sd);
    const z_rzDrives = -zScore(rzDrives, params.lg.RZDrives_def, params.lg.RZDrives_def_sd);
    
    const CER = (
      params.weights.def_PPD * z_ppd +
      params.weights.def_EPA * z_epa +
      params.weights.def_SR * z_sr +
      params.weights.def_RZTD * z_rztd +
      params.weights.def_TO * z_to +
      params.weights.def_RZDrives * z_rzDrives
    );
    
    console.log(`  DEF CER ${team.Team}: PPD_allowed=${ppd.toFixed(2)} (z=${z_ppd.toFixed(2)}), EPA=${epa.toFixed(3)} (z=${z_epa.toFixed(2)}) → CER=${CER.toFixed(3)}`);
    
    return {
      CER,
      components: { ppd, epa, sr, rztd, to_forced, rzDrives },
      zScores: { z_ppd, z_epa, z_sr, z_rztd, z_to, z_rzDrives }
    };
  }

  // ============================================
  // TIER 2: PACE-BASED DRIVES MODEL
  // ============================================
  
  function calculatePaceAdjustment(team, isOffense = true) {
    const prefix = isOffense ? 'Offensive' : 'Defensive';
    
    const secSnap = parseFloat(findValue(team, [`${prefix} Seconds/Snap`, `${prefix} Sec/snap`, 'SecSnap'])) || 
                    (isOffense ? params.lg.SecSnap : params.lg.SecSnap_def);
    const playsPerDrive = parseFloat(findValue(team, [`${prefix} Plays/Drive`, 'Plays/Drive'])) || 
                          (isOffense ? params.lg.PlaysPerDrive : params.lg.PlaysPerDrive_def);
    const threeOut = parsePercent(findValue(team, [isOffense ? 'Off 3-out Rate' : 'Defensive 3-out Rate', `${prefix} 3-out Rate`, '3-out Rate'])) || 
                     (isOffense ? params.lg.ThreeOut : params.lg.ThreeOut_def);
    const xpl = parsePercent(findValue(team, [`${prefix} Explosive Play Rate`, `${prefix} Explosive rate`])) || 
                (isOffense ? params.lg.Xpl : params.lg.Xpl_def);
    const noHuddle = parsePercent(findValue(team, [`${prefix} No Huddle Rate`, 'No Huddle Rate'])) || params.lg.NoHuddle;
    const pen = parseFloat(findValue(team, [`${prefix} Penalties/Drive`, 'Penalties/Drive'])) || 
                (isOffense ? params.lg.Pen : params.lg.Pen_def);
    const passRate = parsePercent(findValue(team, [`${prefix} Early Down Pass Rate`, 'Early Down Pass Rate'])) || params.lg.PassRate;
    
    const lg_secSnap = isOffense ? params.lg.SecSnap : params.lg.SecSnap_def;
    const lg_secSnap_sd = isOffense ? params.lg.SecSnap_sd : params.lg.SecSnap_def_sd;
    const lg_playsPerDrive = isOffense ? params.lg.PlaysPerDrive : params.lg.PlaysPerDrive_def;
    const lg_playsPerDrive_sd = isOffense ? params.lg.PlaysPerDrive_sd : params.lg.PlaysPerDrive_def_sd;
    const lg_threeOut = isOffense ? params.lg.ThreeOut : params.lg.ThreeOut_def;
    const lg_threeOut_sd = isOffense ? params.lg.ThreeOut_sd : params.lg.ThreeOut_def_sd;
    const lg_xpl = isOffense ? params.lg.Xpl : params.lg.Xpl_def;
    const lg_xpl_sd = isOffense ? params.lg.Xpl_sd : params.lg.Xpl_def_sd;
    const lg_pen = isOffense ? params.lg.Pen : params.lg.Pen_def;
    const lg_pen_sd = isOffense ? params.lg.Pen_sd : params.lg.Pen_def_sd;
    
    const z_secSnap = zScore(secSnap, lg_secSnap, lg_secSnap_sd);
    const z_playsPerDrive = zScore(playsPerDrive, lg_playsPerDrive, lg_playsPerDrive_sd);
    const z_threeOut = zScore(threeOut, lg_threeOut, lg_threeOut_sd);
    const z_xpl = zScore(xpl, lg_xpl, lg_xpl_sd);
    const z_noHuddle = zScore(noHuddle, params.lg.NoHuddle, params.lg.NoHuddle_sd);
    const z_pen = zScore(pen, lg_pen, lg_pen_sd);
    const z_passRate = zScore(passRate, params.lg.PassRate, params.lg.PassRate_sd);
    
    const paceAdj = (
      params.pace.secSnap_coef * z_secSnap +
      params.pace.playsPerDrive_coef * z_playsPerDrive +
      params.pace.threeOut_coef * z_threeOut +
      params.pace.xpl_coef * z_xpl +
      params.pace.noHuddle_coef * z_noHuddle +
      params.pace.pen_coef * z_pen +
      params.pace.passRate_coef * z_passRate
    );
    
    return {
      paceAdj,
      components: { secSnap, playsPerDrive, threeOut, xpl, noHuddle, pen, passRate },
      zScores: { z_secSnap, z_playsPerDrive, z_threeOut, z_xpl, z_noHuddle, z_pen, z_passRate }
    };
  }

  function calculateExpectedDrives(homeTeam, awayTeam) {
    const homePace = calculatePaceAdjustment(homeTeam, true);
    const awayPace = calculatePaceAdjustment(awayTeam, true);
    const homeDefPace = calculatePaceAdjustment(homeTeam, false);
    const awayDefPace = calculatePaceAdjustment(awayTeam, false);
    
    const gamePaceAdj = (homePace.paceAdj + awayPace.paceAdj + homeDefPace.paceAdj + awayDefPace.paceAdj) / 4;
    const totalGameDrives = params.lg.Drives * 2 * (1 + gamePaceAdj);
    const baseDrivesEach = totalGameDrives / 2;
    
    const homeTO = parsePercent(findValue(homeTeam, ['Offensive TO%', 'TO%'])) || params.lg.TO_pct;
    const awayTO = parsePercent(findValue(awayTeam, ['Offensive TO%', 'TO%'])) || params.lg.TO_pct;
    
    const homeExpectedTOs = baseDrivesEach * homeTO;
    const awayExpectedTOs = baseDrivesEach * awayTO;
    
    const turnoverSwing = (awayExpectedTOs - homeExpectedTOs) * 0.8;
    
    const paceEdge = (homePace.paceAdj - awayPace.paceAdj) * 0.3;
    const cappedPaceEdge = clamp(paceEdge, -0.3, 0.3);
    
    let homeDrives = baseDrivesEach + (turnoverSwing / 2) + cappedPaceEdge;
    let awayDrives = baseDrivesEach - (turnoverSwing / 2) - cappedPaceEdge;
    
    const differential = homeDrives - awayDrives;
    if (Math.abs(differential) > 1.0) {
      const excess = (Math.abs(differential) - 1.0) / 2;
      if (differential > 0) {
        homeDrives -= excess;
        awayDrives += excess;
      } else {
        homeDrives += excess;
        awayDrives -= excess;
      }
    }
    
    homeDrives = clamp(homeDrives, 9.0, 13.0);
    awayDrives = clamp(awayDrives, 9.0, 13.0);
    
    console.log(`  DRIVES MODEL: Total ${totalGameDrives.toFixed(1)}, Home ${homeDrives.toFixed(2)}, Away ${awayDrives.toFixed(2)}`);
    
    return {
      homeDrives,
      awayDrives,
      totalGameDrives,
      differential: homeDrives - awayDrives,
      turnoverSwing,
      gamePaceAdj,
      homePaceDetails: homePace,
      awayPaceDetails: awayPace
    };
  }

  // ============================================
  // TIER 3: MATCHUP ADJUSTMENT
  // ============================================
  
  function calculateMatchupPPD(homeTeam, awayTeam) {
    console.log("\n=== COMPOSITE EFFICIENCY RATINGS ===");
    
    const homeOffCER = calculateOffensiveCER(homeTeam);
    const homeDefCER = calculateDefensiveCER(homeTeam);
    const awayOffCER = calculateOffensiveCER(awayTeam);
    const awayDefCER = calculateDefensiveCER(awayTeam);
    
    const homeMatchupCER = homeOffCER.CER - awayDefCER.CER;
    const awayMatchupCER = awayOffCER.CER - homeDefCER.CER;
    
    const homePPDAdj = homeMatchupCER * params.CER_TO_PPD_SCALE;
    const awayPPDAdj = awayMatchupCER * params.CER_TO_PPD_SCALE;
    
    const homeRawPPD = params.lg.PPD + homePPDAdj;
    const awayRawPPD = params.lg.PPD + awayPPDAdj;
    
    const homePPD = params.lg.PPD + params.LAMBDA * (homeRawPPD - params.lg.PPD);
    const awayPPD = params.lg.PPD + params.LAMBDA * (awayRawPPD - params.lg.PPD);
    
    // Calculate HFA per drive
    const hfaPerDrive = params.HOME_FIELD_ADV / params.lg.Drives;
    
    // FOR SPREADS: Use asymmetric HFA
    const homeFinalPPD_forSpread = homePPD + hfaPerDrive;
    const awayFinalPPD_forSpread = awayPPD;
    
    // FOR TOTALS: Use symmetric HFA
    const homeFinalPPD_forTotal = homePPD + (hfaPerDrive / 2);
    const awayFinalPPD_forTotal = awayPPD - (hfaPerDrive / 2);
    
    console.log(`\n=== MATCHUP PPD (OPTIMIZED HFA=${params.HOME_FIELD_ADV}) ===`);
    console.log(`  Home matchup CER: ${homeMatchupCER.toFixed(3)}, Away: ${awayMatchupCER.toFixed(3)}`);
    console.log(`  For Spreads - Home PPD: ${homeFinalPPD_forSpread.toFixed(3)}, Away: ${awayFinalPPD_forSpread.toFixed(3)}`);
    console.log(`  For Totals  - Home PPD: ${homeFinalPPD_forTotal.toFixed(3)}, Away: ${awayFinalPPD_forTotal.toFixed(3)}`);
    
    return {
      homePPD_spread: clamp(homeFinalPPD_forSpread, 1.2, 3.5),
      awayPPD_spread: clamp(awayFinalPPD_forSpread, 1.2, 3.5),
      homePPD_total: clamp(homeFinalPPD_forTotal, 1.2, 3.5),
      awayPPD_total: clamp(awayFinalPPD_forTotal, 1.2, 3.5),
      homePPD: clamp(homeFinalPPD_forSpread, 1.2, 3.5),
      awayPPD: clamp(awayFinalPPD_forSpread, 1.2, 3.5),
      homeOffCER,
      homeDefCER,
      awayOffCER,
      awayDefCER
    };
  }

  // ============================================
  // CORRELATION CALCULATION
  // ============================================
  
  function calculateAdaptiveCorrelation(homeTeam, awayTeam, spread, isDome, windMPH, precip) {
    let rho = RHO_BASELINE;
    
    const absSpread = Math.abs(spread);
    if (absSpread <= 3) rho += 0.10;
    else if (absSpread <= 7) rho += 0.05;
    else if (absSpread >= 14) rho -= 0.10;
    
    const homePassRate = parsePercent(findValue(homeTeam, ['Offensive Early Down Pass Rate', 'PassRate'])) || params.lg.PassRate;
    const awayPassRate = parsePercent(findValue(awayTeam, ['Offensive Early Down Pass Rate', 'PassRate'])) || params.lg.PassRate;
    const passRateDiff = Math.abs(homePassRate - awayPassRate);
    if (passRateDiff < 0.05) rho += 0.08;
    else if (passRateDiff > 0.15) rho -= 0.05;
    
    const homeXpl = parsePercent(findValue(homeTeam, ['Offensive Explosive Play Rate'])) || params.lg.Xpl;
    const awayXpl = parsePercent(findValue(awayTeam, ['Offensive Explosive Play Rate'])) || params.lg.Xpl;
    if (homeXpl + awayXpl > 0.19) rho += 0.05;
    
    if (isDome) rho += 0.05;
    if (windMPH > 15) rho -= 0.15;
    else if (windMPH > 10) rho -= 0.08;
    
    if (precip === "heavy_rain" || precip === "snow") rho -= 0.10;
    else if (precip === "light_rain") rho -= 0.05;
    
    const homeSecSnap = parseFloat(findValue(homeTeam, ['Offensive Seconds/Snap'])) || params.lg.SecSnap;
    const awaySecSnap = parseFloat(findValue(awayTeam, ['Offensive Seconds/Snap'])) || params.lg.SecSnap;
    const avgPace = (homeSecSnap + awaySecSnap) / 2;
    if (avgPace < 27.4) rho += 0.05;
    else if (avgPace > 29.8) rho -= 0.03;
    
    return clamp(rho, -0.05, 0.50);
  }

  // ============================================
  // WEATHER ADJUSTMENT
  // ============================================
  
  function calculateWeatherAdjustment(settings) {
    let weatherAdj = 0;
    
    if (settings.isDome) {
      weatherAdj += params.weather.dome_bonus;
    } else {
      if (settings.windMPH > params.weather.wind_threshold) {
        const windEffect = (settings.windMPH - params.weather.wind_threshold) * 
                          params.weather.wind_per_mph_above_threshold;
        weatherAdj += windEffect;
      }
      
      if (settings.temperature < params.weather.extreme_cold_threshold) {
        weatherAdj += params.weather.extreme_cold_penalty;
      }
      
      weatherAdj += params.weather.precip_adjustments[settings.precipitation] || 0;
    }
    
    return weatherAdj;
  }

  // ============================================
  // CSV PARSING
  // ============================================
  
  function parseCSV(csvText) {
    let cleanedText = csvText;
    if (cleanedText.charCodeAt(0) === 0xFEFF) {
      cleanedText = cleanedText.slice(1);
    }
    
    const lines = cleanedText.trim().split('\n');
    if (lines.length < 2) {
      throw new Error("CSV file appears to be empty or invalid");
    }

    const headers = parseCSVLine(lines[0]);
    const teamData = [];

    console.log("CSV Headers found:", headers);

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length < headers.length - 5) continue;

      const team = {};
      headers.forEach((header, index) => {
        if (index < values.length) {
          const cleanHeader = header.replace(/^\uFEFF/, '');
          team[cleanHeader] = values[index];
        }
      });

      const teamName = team.team || team.Team || team['\ufeffteam'];
      if (teamName) {
        team.Team = teamName;
        teamData.push(team);
      }
    }

    if (teamData.length === 0) {
      throw new Error("No valid team data found. Please check CSV format.");
    }

    return teamData;
  }

  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    result.push(current.trim());
    return result;
  }

  const getDisplayValue = (team, possibleNames) => {
    for (let name of possibleNames) {
      const value = team[name];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return 'N/A';
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setUploadError(null);
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const csvText = e.target.result;
        const parsedTeams = parseCSV(csvText);
        
        if (parsedTeams.length === 0) {
          throw new Error("No valid team data found in CSV");
        }

        setTeams(parsedTeams);
        setCsvUploaded(true);
        
        const newLeagueParams = calculateLeagueAverages(parsedTeams);
        setLeagueParams(newLeagueParams);
        
        console.log(`Successfully loaded ${parsedTeams.length} teams`);
        console.log("League averages updated from uploaded data");
      } catch (error) {
        setUploadError(error.message);
        console.error("CSV parsing error:", error);
      }
    };

    reader.onerror = () => {
      setUploadError("Failed to read file");
    };

    reader.readAsText(file);
  };

  // ============================================
  // MAIN SIMULATION (OPTIMIZED)
  // ============================================
  
  const runSimulation = () => {
    if (!selectedHomeTeam || !selectedAwayTeam) {
      alert("Please select both home and away teams");
      return;
    }

    setIsSimulating(true);
    
    setTimeout(() => {
      try {
        const results = simulateGame(selectedHomeTeam, selectedAwayTeam, gameSettings);
        setSimulationResults(results);
      } catch (error) {
        alert(`Simulation error: ${error.message}`);
        console.error(error);
      } finally {
        setIsSimulating(false);
      }
    }, 100);
  };

  function simulateGame(homeTeam, awayTeam, settings) {
    const numSims = settings.numSimulations;
    
    console.log("\n========================================");
    console.log(`OPTIMIZED SIMULATION: ${homeTeam.Team} vs ${awayTeam.Team}`);
    console.log("========================================");
    
    const matchup = calculateMatchupPPD(homeTeam, awayTeam);
    const drives = calculateExpectedDrives(homeTeam, awayTeam);
    
    const rho = calculateAdaptiveCorrelation(
      homeTeam, awayTeam,
      settings.spread,
      settings.isDome,
      settings.windMPH,
      settings.precipitation
    );
    
    const weatherAdj = calculateWeatherAdjustment(settings);
    const outdoorPenalty = settings.outdoorPenalty || 0;
    
    // Game script adjustment for blowouts
    const absSpread = Math.abs(settings.spread || 0);
    let gameScriptAdj = 0;
    if (absSpread >= 14) {
      gameScriptAdj = -1.5;
    } else if (absSpread >= 10) {
      gameScriptAdj = -0.75;
    }
    
    // Calculate expected points for MARGINS
    const homeExpPts_forMargin = matchup.homePPD_spread * drives.homeDrives + (weatherAdj / 2) + (outdoorPenalty / 2);
    const awayExpPts_forMargin = matchup.awayPPD_spread * drives.awayDrives + (weatherAdj / 2) + (outdoorPenalty / 2);
    
    // Calculate expected points for TOTALS - OPTIMIZED: Now includes outdoor penalty
    const homeExpPts_forTotal = matchup.homePPD_total * drives.homeDrives + (weatherAdj / 2) + (gameScriptAdj / 2) + (outdoorPenalty / 2);
    const awayExpPts_forTotal = matchup.awayPPD_total * drives.awayDrives + (weatherAdj / 2) + (gameScriptAdj / 2) + (outdoorPenalty / 2);
    
    console.log(`\n=== OPTIMIZED PROJECTIONS ===`);
    console.log(`  For MARGINS: Home ${homeExpPts_forMargin.toFixed(1)}, Away ${awayExpPts_forMargin.toFixed(1)}, Margin ${(homeExpPts_forMargin - awayExpPts_forMargin).toFixed(1)}`);
    console.log(`  For TOTALS:  Home ${homeExpPts_forTotal.toFixed(1)}, Away ${awayExpPts_forTotal.toFixed(1)}, Total ${(homeExpPts_forTotal + awayExpPts_forTotal).toFixed(1)}`);
    console.log(`  Correlation: ${rho.toFixed(3)} | Game Script: ${gameScriptAdj.toFixed(1)} | Outdoor: ${outdoorPenalty.toFixed(2)}`);
    console.log(`========================================\n`);
    
    const results = {
      homeScores: [],
      awayScores: [],
      totals: [],
      margins: [],
      correlationUsed: rho,
      weatherAdjustment: weatherAdj,
      homeExpectedPts: homeExpPts_forMargin,
      awayExpectedPts: awayExpPts_forMargin,
      homeExpectedPts_total: homeExpPts_forTotal,
      awayExpectedPts_total: awayExpPts_forTotal,
      homeDrives: drives.homeDrives,
      awayDrives: drives.awayDrives,
      totalGameDrives: drives.totalGameDrives,
      driveDifferential: drives.differential,
      turnoverSwing: drives.turnoverSwing,
      gamePaceAdj: drives.gamePaceAdj,
      matchupDetails: matchup,
      gameScriptAdj,
      outdoorPenalty
    };
    
    // OPTIMIZED SIGMA FUNCTIONS: Increased to match empirical NFL variance
    const sigmaMargin = (expectedPts) => Math.max(9.5, Math.min(13.5, 8.0 + 0.18 * (expectedPts - 20)));
    const sigmaTotal = (expectedPts) => Math.max(10.5, Math.min(15.5, 8.5 + 0.25 * (expectedPts - 20)));
    
    for (let i = 0; i < numSims; i++) {
      // Generate correlated random values (Box-Muller)
      const u1 = Math.random();
      const u2 = Math.random();
      const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const z2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
      
      // Generate second pair for independent total variance
      const u3 = Math.random();
      const u4 = Math.random();
      const z3 = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u4);
      const z4 = Math.sqrt(-2 * Math.log(u3)) * Math.sin(2 * Math.PI * u4);
      
      const homeRandom = z1;
      const awayRandom = rho * z1 + Math.sqrt(1 - rho * rho) * z2;
      
      // Calculate scores for MARGINS
      const homeScore_margin = Math.max(0, homeExpPts_forMargin + homeRandom * sigmaMargin(homeExpPts_forMargin));
      const awayScore_margin = Math.max(0, awayExpPts_forMargin + awayRandom * sigmaMargin(awayExpPts_forMargin));
      
      // Calculate scores for TOTALS
      const homeRandom_total = 0.7 * z1 + 0.3 * z3;
      const awayRandom_total = 0.7 * (rho * z1 + Math.sqrt(1 - rho * rho) * z2) + 0.3 * z4;
      const homeScore_total = Math.max(0, homeExpPts_forTotal + homeRandom_total * sigmaTotal(homeExpPts_forTotal));
      const awayScore_total = Math.max(0, awayExpPts_forTotal + awayRandom_total * sigmaTotal(awayExpPts_forTotal));
      
      // Round for final scores
      const homeScoreRounded = Math.round(homeScore_margin);
      const awayScoreRounded = Math.round(awayScore_margin);
      const totalRounded = Math.round(homeScore_total + awayScore_total);
      
      results.homeScores.push(homeScoreRounded);
      results.awayScores.push(awayScoreRounded);
      results.totals.push(totalRounded);
      results.margins.push(homeScoreRounded - awayScoreRounded);
    }
    
    return calculateResults(results, settings, homeTeam.Team, awayTeam.Team);
  }

  function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  function calculateResults(results, settings, homeTeamName, awayTeamName) {
    const homeScores = results.homeScores;
    const awayScores = results.awayScores;
    const totals = results.totals;
    const margins = results.margins;
    const n = settings.numSimulations;

    const totalMean = totals.reduce((a, b) => a + b, 0) / n;

    // Over/Under analysis
    let overCount = 0, underCount = 0, pushCount = 0;
    totals.forEach(total => {
      if (total > settings.overUnderLine) overCount++;
      else if (total < settings.overUnderLine) underCount++;
      else pushCount++;
    });

    // Home team total
    let homeOverCount = 0, homeUnderCount = 0, homePushCount = 0;
    homeScores.forEach(score => {
      if (score > settings.homeTeamTotal) homeOverCount++;
      else if (score < settings.homeTeamTotal) homeUnderCount++;
      else homePushCount++;
    });

    // Away team total
    let awayOverCount = 0, awayUnderCount = 0, awayPushCount = 0;
    awayScores.forEach(score => {
      if (score > settings.awayTeamTotal) awayOverCount++;
      else if (score < settings.awayTeamTotal) awayUnderCount++;
      else awayPushCount++;
    });

    // Moneyline
    let homeWinCount = 0, awayWinCount = 0;
    margins.forEach(margin => {
      if (margin > 0) homeWinCount++;
      else if (margin < 0) awayWinCount++;
    });

    // Spread analysis
    const spreadLine = settings.spreadLine;
    let homeCoverCount = 0, awayCoverCount = 0, spreadPushCount = 0;
    margins.forEach(margin => {
      const threshold = -spreadLine;
      if (margin > threshold) homeCoverCount++;
      else if (margin < threshold) awayCoverCount++;
      else spreadPushCount++;
    });

    // Alt-lines
    const altLines = [-14, -10.5, -7, -6.5, -3.5, -3, -2.5, -1.5, 0, +1.5, +2.5, +3, +3.5, +6.5, +7, +10.5, +14];
    const altLinesAnalysis = altLines.map(line => {
      let coverCount = 0;
      margins.forEach(margin => {
        if (margin > -line) coverCount++;
      });
      return { line, coverPct: (coverCount / n) * 100 };
    });

    return {
      numSimulations: n,
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
      correlationUsed: results.correlationUsed,
      weatherAdjustment: results.weatherAdjustment,
      homeExpectedPts: results.homeExpectedPts,
      awayExpectedPts: results.awayExpectedPts,
      homeDrives: results.homeDrives,
      awayDrives: results.awayDrives,
      totalGameDrives: results.totalGameDrives,
      driveDifferential: results.driveDifferential,
      turnoverSwing: results.turnoverSwing,
      gamePaceAdj: results.gamePaceAdj,
      matchupDetails: results.matchupDetails,
      gameScriptAdj: results.gameScriptAdj,
      outdoorPenalty: results.outdoorPenalty,
      
      overUnder: {
        line: settings.overUnderLine,
        overPct: (overCount / n) * 100,
        underPct: (underCount / n) * 100,
        pushPct: (pushCount / n) * 100,
      },
      
      homeTeamOverUnder: {
        line: settings.homeTeamTotal,
        overPct: (homeOverCount / n) * 100,
        underPct: (homeUnderCount / n) * 100,
        pushPct: (homePushCount / n) * 100,
      },
      
      awayTeamOverUnder: {
        line: settings.awayTeamTotal,
        overPct: (awayOverCount / n) * 100,
        underPct: (awayUnderCount / n) * 100,
        pushPct: (awayPushCount / n) * 100,
      },
      
      moneyline: {
        homeWinPct: (homeWinCount / n) * 100,
        awayWinPct: (awayWinCount / n) * 100,
        homeFairOdds: toAmericanOdds(homeWinCount / n),
        awayFairOdds: toAmericanOdds(awayWinCount / n),
      },
      
      spread: {
        line: spreadLine,
        homeCoverPct: (homeCoverCount / n) * 100,
        awayCoverPct: (awayCoverCount / n) * 100,
        pushPct: (spreadPushCount / n) * 100,
        altLines: altLinesAnalysis,
      },
      
      homeProjection: {
        mean: homeScores.reduce((a, b) => a + b, 0) / n,
        median: percentile(homeScores, 50),
        p10: percentile(homeScores, 10),
        p90: percentile(homeScores, 90),
      },
      
      awayProjection: {
        mean: awayScores.reduce((a, b) => a + b, 0) / n,
        median: percentile(awayScores, 50),
        p10: percentile(awayScores, 10),
        p90: percentile(awayScores, 90),
      },
      
      totalProjection: {
        mean: totalMean,
        median: percentile(totals, 50),
        p10: percentile(totals, 10),
        p90: percentile(totals, 90),
      },
      
      marginProjection: {
        mean: margins.reduce((a, b) => a + b, 0) / n,
        median: percentile(margins, 50),
        p10: percentile(margins, 10),
        p90: percentile(margins, 90),
      },
    };
  }

  // ============================================
  // BATCH PROCESSING
  // ============================================
  
  function parseGamesCSV(csvText) {
    let cleanedText = csvText;
    if (cleanedText.charCodeAt(0) === 0xFEFF) {
      cleanedText = cleanedText.slice(1);
    }
    
    cleanedText = cleanedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    const lines = cleanedText.trim().split('\n').filter(line => line.trim() !== '');
    if (lines.length < 2) {
      throw new Error("Games CSV appears to be empty or invalid");
    }

    const rawHeaders = parseCSVLine(lines[0]);
    const headers = rawHeaders.map(h => h.toLowerCase().trim().replace(/[^a-z0-9]/g, ''));
    
    console.log("Games CSV Headers:", headers);

    const games = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const values = parseCSVLine(line);
      if (values.length < 2) continue;

      const row = {};
      headers.forEach((header, index) => {
        if (index < values.length) {
          row[header] = values[index].trim();
        }
      });

      const homeTeamName = row.home || row.hometeam || '';
      const awayTeamName = row.away || row.awayteam || '';
      
      if (!homeTeamName || !awayTeamName) continue;

      const homeTeam = teams.find(t => 
        t.Team.toLowerCase().includes(homeTeamName.toLowerCase()) ||
        homeTeamName.toLowerCase().includes(t.Team.toLowerCase())
      );
      const awayTeam = teams.find(t => 
        t.Team.toLowerCase().includes(awayTeamName.toLowerCase()) ||
        awayTeamName.toLowerCase().includes(t.Team.toLowerCase())
      );

      if (!homeTeam || !awayTeam) {
        console.warn(`Could not find teams: ${homeTeamName} vs ${awayTeamName}`);
        continue;
      }

      const isDome = ['y', 'yes', '1', 'true'].includes((row.dome || '').toLowerCase());
      const total = parseFloat(row.total || row.ou || row.overunder) || 44.5;
      const spread = parseFloat(row.spread || row.line) || -3;
      const homeTotal = parseFloat(row.hometotal || row.homett) || (total / 2 - spread / 2);
      const awayTotal = parseFloat(row.awaytotal || row.awaytt) || (total / 2 + spread / 2);

      games.push({
        homeTeam,
        awayTeam,
        settings: {
          overUnderLine: total,
          homeTeamTotal: homeTotal,
          awayTeamTotal: awayTotal,
          spread: spread,
          spreadLine: spread,
          numSimulations: 10000,
          isDome,
          windMPH: 0,
          temperature: 70,
          precipitation: "none",
          outdoorPenalty: isDome ? 0 : -1.25
        }
      });
    }

    return games;
  }

  const handleBatchUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const games = parseGamesCSV(e.target.result);
        setBatchGames(games);
        console.log(`Loaded ${games.length} games for batch processing`);
      } catch (error) {
        alert(`Error parsing games CSV: ${error.message}`);
      }
    };
    reader.readAsText(file);
  };

  const runBatchSimulation = async () => {
    if (batchGames.length === 0) {
      alert("Please upload a games CSV first");
      return;
    }

    setIsBatchSimulating(true);
    setBatchProgress(0);
    setBatchResults([]);

    const results = [];
    
    for (let i = 0; i < batchGames.length; i++) {
      const game = batchGames[i];
      try {
        const result = simulateGame(game.homeTeam, game.awayTeam, game.settings);
        results.push({
          ...result,
          settings: game.settings
        });
      } catch (error) {
        console.error(`Error simulating ${game.homeTeam.Team} vs ${game.awayTeam.Team}:`, error);
      }
      setBatchProgress(((i + 1) / batchGames.length) * 100);
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    setBatchResults(results);
    setIsBatchSimulating(false);
  };

  // ============================================
  // UI RENDER
  // ============================================

  // CSV Export function
  const exportBatchResults = () => {
    if (batchResults.length === 0) return;

    const headers = [
      'Home', 'Away', 'Dome',
      'Home Proj', 'Away Proj', 'Total Proj', 'Proj Margin',
      'Market Total', 'Total Edge', 'Total Signal', 'Total %', 'Total Approved', 'Total Bucket', 'Total Tier',
      'Spread', 'Spread Signal', 'Spread %', 'Side Type', 'Spread Approved', 'Spread Bucket', 'Spread Tier',
      'Home Win %', 'Away Win %'
    ];

    const rows = batchResults.map(r => {
      const totalProj = r.totalProjection.mean;
      const totalEdge = totalProj - r.overUnder.line;
      
      const totalsEval = evaluateTotalsBet(
        r.overUnder.overPct,
        r.overUnder.underPct,
        totalProj,
        r.overUnder.line,
        Math.abs(r.spread.line),
        r.settings?.isDome || false
      );
      
      const spreadEval = evaluateSpreadBet(
        r.spread.homeCoverPct,
        r.spread.awayCoverPct,
        r.marginProjection.mean,
        r.spread.line
      );

      return [
        r.homeTeam,
        r.awayTeam,
        r.settings?.isDome ? 'Y' : 'N',
        r.homeProjection.mean.toFixed(1),
        r.awayProjection.mean.toFixed(1),
        totalProj.toFixed(1),
        ((-r.marginProjection.mean) >= 0 ? '+' : '') + (-r.marginProjection.mean).toFixed(1),
        r.overUnder.line,
        (totalEdge >= 0 ? '+' : '') + totalEdge.toFixed(1),
        totalsEval.signal,
        totalsEval.rawProb.toFixed(1) + '%',
        totalsEval.approved ? 'YES' : 'NO',
        totalsEval.bucket,
        totalsEval.tier > 0 ? `Tier ${totalsEval.tier}` : '-',
        (r.spread.line > 0 ? '+' : '') + r.spread.line,
        spreadEval.signal,
        spreadEval.rawProb.toFixed(1) + '%',
        spreadEval.sideType,
        spreadEval.approved ? 'YES' : 'NO',
        spreadEval.bucket,
        spreadEval.tier > 0 ? `Tier ${spreadEval.tier}` : '-',
        r.moneyline.homeWinPct.toFixed(1) + '%',
        r.moneyline.awayWinPct.toFixed(1) + '%'
      ];
    });

    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gamble-tron-optimized-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center py-8 mb-8">
          <div className="inline-block bg-gradient-to-b from-gray-300 to-gray-400 p-6 rounded-lg border-4 border-gray-500 shadow-2xl mb-4">
            <h1 className="text-6xl font-bold mb-1 text-black tracking-wider" style={{ 
              fontFamily: 'Impact, "Arial Black", sans-serif',
              textShadow: '3px 3px 0px rgba(0,0,0,0.3)',
              letterSpacing: '0.1em'
            }}>
              GAMBLE-TRON
            </h1>
            <div className="text-5xl font-bold text-black tracking-widest" style={{ 
              fontFamily: 'Impact, "Arial Black", sans-serif',
              letterSpacing: '0.3em'
            }}>
              2025
            </div>
          </div>
          
          {/* Spinning Reels */}
          <div className="flex justify-center gap-64 mt-6 mb-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-full border-4 border-gray-800 bg-gradient-to-br from-gray-500 to-gray-700 flex items-center justify-center animate-spin shadow-lg" style={{ animationDuration: '3s' }}>
                <div className="w-4 h-4 bg-gray-900 rounded-full"></div>
                <div className="absolute w-1 h-12 bg-gray-800 top-2" style={{ transform: 'rotate(45deg)' }}></div>
                <div className="absolute w-1 h-12 bg-gray-800 top-2" style={{ transform: 'rotate(-45deg)' }}></div>
              </div>
            </div>
            <div className="relative">
              <div className="w-16 h-16 rounded-full border-4 border-gray-800 bg-gradient-to-br from-gray-500 to-gray-700 flex items-center justify-center animate-spin shadow-lg" style={{ animationDuration: '3s', animationDirection: 'reverse' }}>
                <div className="w-4 h-4 bg-gray-900 rounded-full"></div>
                <div className="absolute w-1 h-12 bg-gray-800 top-2" style={{ transform: 'rotate(45deg)' }}></div>
                <div className="absolute w-1 h-12 bg-gray-800 top-2" style={{ transform: 'rotate(-45deg)' }}></div>
              </div>
            </div>
          </div>
          
          {/* Control Panel Lights */}
          <div className="flex justify-center gap-2 mb-2">
            <div className="w-4 h-4 rounded-full bg-orange-500 animate-pulse" style={{ animationDuration: '1s' }}></div>
            <div className="w-4 h-4 rounded-full bg-red-500 animate-pulse" style={{ animationDuration: '1.5s' }}></div>
            <div className="w-4 h-4 rounded-full bg-white animate-pulse" style={{ animationDuration: '2s' }}></div>
            <div className="w-4 h-4 rounded-full bg-pink-300 animate-pulse" style={{ animationDuration: '1.2s' }}></div>
            <div className="w-4 h-4 rounded-full bg-white animate-pulse" style={{ animationDuration: '1.8s' }}></div>
            <div className="w-4 h-4 rounded-full bg-orange-500 animate-pulse" style={{ animationDuration: '1.4s' }}></div>
            <div className="w-4 h-4 rounded-full bg-red-500 animate-pulse" style={{ animationDuration: '2.2s' }}></div>
          </div>
          
          <p className="text-yellow-300 text-lg font-semibold mb-2">
            🏈 OPTIMIZED Model v2.0 🎰
          </p>
          <div className="flex justify-center gap-3 text-xs text-slate-300">
            <span className="bg-green-600/30 px-3 py-1 rounded-full border border-green-500">● Sigma: Calibrated</span>
            <span className="bg-blue-600/30 px-3 py-1 rounded-full border border-blue-500">● HFA: 1.5</span>
            <span className="bg-purple-600/30 px-3 py-1 rounded-full border border-purple-500">● Buckets: Simplified</span>
            <span className="bg-yellow-600/30 px-3 py-1 rounded-full border border-yellow-500">● TO Penalty: -0.10</span>
          </div>
        </div>

        {/* Step 1: Upload Team Stats */}
        {!csvUploaded ? (
          <div className="bg-gradient-to-b from-gray-400 to-gray-500 p-8 mb-8 border-4 border-gray-600 shadow-2xl rounded-lg">
            <div className="flex items-center gap-3 mb-6">
              <Database className="w-8 h-8 text-orange-600" />
              <h2 className="text-2xl font-bold text-black">STEP 1: UPLOAD TEAM DATABASE</h2>
            </div>
            
            <div className="bg-slate-900/70 rounded-lg p-6 mb-6 border-2 border-yellow-600">
              <p className="text-yellow-200 mb-4 font-semibold">
                Upload your NFL team statistics CSV. Required columns:
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm text-yellow-200 mb-4 font-semibold">
                <div className="text-green-400">✓ Offensive Pts/Drive</div>
                <div className="text-green-400">✓ Offensive EPA/Play</div>
                <div className="text-green-400">✓ Offensive Success Rate</div>
                <div className="text-green-400">✓ Offensive Red Zone TD Rate</div>
                <div className="text-green-400">✓ Offensive TO%</div>
                <div className="text-blue-400">✓ Offensive Seconds/Snap</div>
                <div className="text-blue-400">✓ Offensive Plays/Drive</div>
                <div className="text-purple-400">✓ All Defensive equivalents</div>
              </div>
            </div>

            <label className="flex flex-col items-center justify-center w-full h-64 border-4 border-dashed border-orange-600 rounded-lg cursor-pointer bg-slate-800 hover:bg-slate-700 transition-all shadow-xl">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <Upload className="w-16 h-16 mb-4 text-orange-400" />
                <p className="mb-2 text-lg font-semibold text-yellow-300">
                  CLICK TO UPLOAD CSV FILE
                </p>
                <p className="text-sm text-yellow-200">
                  CSV FILES ONLY
                </p>
              </div>
              <input
                type="file"
                className="hidden"
                accept=".csv"
                onChange={handleFileUpload}
              />
            </label>

            {uploadError && (
              <div className="mt-4 p-4 bg-red-900/30 border border-red-700 rounded-lg flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-red-300">Upload Error</p>
                  <p className="text-sm text-red-200">{uploadError}</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Mode Toggle */}
            <div className="flex justify-center gap-4 mb-6">
              <button
                onClick={() => setShowBatchMode(false)}
                className={`px-6 py-2 rounded-lg font-semibold transition-colors ${
                  !showBatchMode ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                Single Game
              </button>
              <button
                onClick={() => setShowBatchMode(true)}
                className={`px-6 py-2 rounded-lg font-semibold transition-colors ${
                  showBatchMode ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                Batch Mode
              </button>
            </div>

            {showBatchMode ? (
              // Batch Mode UI
              <div className="bg-slate-800 p-6 rounded-lg border border-slate-700">
                <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                  <BarChart3 className="w-6 h-6 text-orange-400" />
                  Batch Simulation
                </h2>
                
                <div className="mb-6">
                  <label className="block text-sm font-medium mb-2">Upload Games CSV</label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleBatchUpload}
                    className="block w-full text-sm text-slate-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-orange-600 file:text-white hover:file:bg-orange-700"
                  />
                  <p className="text-xs text-slate-400 mt-1">
                    Required columns: home, away, spread, total, dome (Y/N)
                  </p>
                </div>

                {batchGames.length > 0 && (
                  <div className="mb-4">
                    <p className="text-green-400">✓ {batchGames.length} games loaded</p>
                  </div>
                )}

                <div className="flex gap-4">
                  <button
                    onClick={runBatchSimulation}
                    disabled={batchGames.length === 0 || isBatchSimulating}
                    className="px-6 py-3 bg-green-600 hover:bg-green-700 disabled:bg-slate-600 rounded-lg font-semibold flex items-center gap-2"
                  >
                    <Play className="w-5 h-5" />
                    {isBatchSimulating ? `Simulating... ${batchProgress.toFixed(0)}%` : 'Run Batch Simulation'}
                  </button>
                  
                  {batchResults.length > 0 && (
                    <button
                      onClick={exportBatchResults}
                      className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold"
                    >
                      Export CSV
                    </button>
                  )}
                </div>

                {batchResults.length > 0 && (
                  <div className="mt-6 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-600">
                          <th className="text-left p-2">Game</th>
                          <th className="text-center p-2">Proj Total</th>
                          <th className="text-center p-2">Line</th>
                          <th className="text-center p-2">Total Signal</th>
                          <th className="text-center p-2">Spread</th>
                          <th className="text-center p-2">Spread Signal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batchResults.map((r, idx) => {
                          const totalsEval = evaluateTotalsBet(
                            r.overUnder.overPct,
                            r.overUnder.underPct,
                            r.totalProjection.mean,
                            r.overUnder.line,
                            Math.abs(r.spread.line),
                            r.settings?.isDome || false
                          );
                          const spreadEval = evaluateSpreadBet(
                            r.spread.homeCoverPct,
                            r.spread.awayCoverPct,
                            r.marginProjection.mean,
                            r.spread.line
                          );
                          return (
                            <tr key={idx} className="border-b border-slate-700">
                              <td className="p-2">{r.awayTeam} @ {r.homeTeam}</td>
                              <td className="text-center p-2">{r.totalProjection.mean.toFixed(1)}</td>
                              <td className="text-center p-2">{r.overUnder.line}</td>
                              <td className={`text-center p-2 ${totalsEval.approved ? 'text-green-400' : 'text-slate-400'}`}>
                                {totalsEval.signal} {totalsEval.rawProb.toFixed(0)}%
                              </td>
                              <td className="text-center p-2">{r.spread.line}</td>
                              <td className={`text-center p-2 ${spreadEval.approved ? 'text-green-400' : 'text-slate-400'}`}>
                                {spreadEval.signal} ({spreadEval.sideType}) {spreadEval.rawProb.toFixed(0)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              // Single Game UI
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                  {/* Team Selection */}
                  <div className="bg-slate-800 p-6 rounded-lg border border-slate-700">
                    <h3 className="text-xl font-bold mb-4">Select Teams</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium mb-2">Home Team</label>
                        <select
                          value={selectedHomeTeam?.Team || ''}
                          onChange={(e) => setSelectedHomeTeam(teams.find(t => t.Team === e.target.value))}
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2"
                        >
                          <option value="">Select home team...</option>
                          {teams.map(team => (
                            <option key={team.Team} value={team.Team}>{team.Team}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-2">Away Team</label>
                        <select
                          value={selectedAwayTeam?.Team || ''}
                          onChange={(e) => setSelectedAwayTeam(teams.find(t => t.Team === e.target.value))}
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2"
                        >
                          <option value="">Select away team...</option>
                          {teams.map(team => (
                            <option key={team.Team} value={team.Team}>{team.Team}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Game Settings */}
                  <div className="bg-slate-800 p-6 rounded-lg border border-slate-700">
                    <h3 className="text-xl font-bold mb-4">Game Settings</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium mb-2">O/U Line</label>
                        <input
                          type="number"
                          step="0.5"
                          value={gameSettings.overUnderLine}
                          onChange={(e) => setGameSettings({...gameSettings, overUnderLine: parseFloat(e.target.value)})}
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-2">Spread</label>
                        <input
                          type="number"
                          step="0.5"
                          value={gameSettings.spread}
                          onChange={(e) => setGameSettings({...gameSettings, spread: parseFloat(e.target.value), spreadLine: parseFloat(e.target.value)})}
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-2">Dome?</label>
                        <select
                          value={gameSettings.isDome ? 'yes' : 'no'}
                          onChange={(e) => setGameSettings({...gameSettings, isDome: e.target.value === 'yes'})}
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2"
                        >
                          <option value="no">No</option>
                          <option value="yes">Yes</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-2">Wind (MPH)</label>
                        <input
                          type="number"
                          value={gameSettings.windMPH}
                          onChange={(e) => setGameSettings({...gameSettings, windMPH: parseInt(e.target.value) || 0})}
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg p-2"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Run Simulation Button */}
                <div className="text-center mb-6">
                  <button
                    onClick={runSimulation}
                    disabled={!selectedHomeTeam || !selectedAwayTeam || isSimulating}
                    className="px-8 py-4 bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-700 hover:to-red-700 disabled:from-slate-600 disabled:to-slate-700 rounded-lg font-bold text-xl shadow-lg flex items-center gap-3 mx-auto"
                  >
                    <Play className="w-6 h-6" />
                    {isSimulating ? 'SIMULATING...' : 'RUN SIMULATION'}
                  </button>
                </div>

                {/* Results Display */}
                {simulationResults && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Over/Under Analysis */}
                    <div className="bg-slate-800 p-6 rounded-lg border border-purple-700/50">
                      <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                        <BarChart3 className="w-6 h-6 text-purple-400" />
                        Over/Under Analysis (Line: {simulationResults.overUnder.line})
                      </h3>
                      
                      <div className="grid grid-cols-3 gap-4 mb-6">
                        <div className="bg-gradient-to-br from-green-600/20 to-green-800/20 p-4 rounded-lg border border-green-600/30">
                          <div className="text-sm text-green-300 mb-1">Over</div>
                          <div className="text-3xl font-bold text-green-400">
                            {simulationResults.overUnder.overPct.toFixed(1)}%
                          </div>
                          <div className="text-xs text-green-300 mt-1">
                            {simulationResults.overUnder.overPct > 52.4 ? '✓ +EV vs -110' : ''}
                          </div>
                        </div>
                        <div className="bg-gradient-to-br from-red-600/20 to-red-800/20 p-4 rounded-lg border border-red-600/30">
                          <div className="text-sm text-red-300 mb-1">Under</div>
                          <div className="text-3xl font-bold text-red-400">
                            {simulationResults.overUnder.underPct.toFixed(1)}%
                          </div>
                          <div className="text-xs text-red-300 mt-1">
                            {simulationResults.overUnder.underPct > 52.4 ? '✓ +EV vs -110' : ''}
                          </div>
                        </div>
                        <div className="bg-gradient-to-br from-slate-600/20 to-slate-800/20 p-4 rounded-lg border border-slate-600/30">
                          <div className="text-sm text-slate-300 mb-1">Push</div>
                          <div className="text-3xl font-bold text-slate-400">
                            {simulationResults.overUnder.pushPct.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      <div className="text-center text-slate-400">
                        Projected Total: <span className="text-purple-400 font-bold text-xl">{simulationResults.totalProjection.mean.toFixed(1)}</span>
                        {' '}| Edge: <span className={(simulationResults.totalProjection.mean - simulationResults.overUnder.line) >= 0 ? "text-green-400" : "text-red-400"}>
                          {(simulationResults.totalProjection.mean - simulationResults.overUnder.line) >= 0 ? '+' : ''}
                          {(simulationResults.totalProjection.mean - simulationResults.overUnder.line).toFixed(1)}
                        </span>
                      </div>
                    </div>

                    {/* Spread Analysis */}
                    <div className="bg-slate-800 p-6 rounded-lg border border-yellow-700/50">
                      <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                        <TrendingUp className="w-6 h-6 text-yellow-400" />
                        Spread Analysis (Line: {simulationResults.spread.line})
                      </h3>
                      <div className="grid grid-cols-3 gap-4 mb-6">
                        <div className="bg-gradient-to-br from-orange-600/20 to-orange-800/20 p-4 rounded-lg border border-orange-600/30">
                          <div className="text-sm text-orange-300 mb-1">
                            {simulationResults.homeTeam} {simulationResults.spread.line}
                          </div>
                          <div className="text-3xl font-bold text-orange-400">
                            {simulationResults.spread.homeCoverPct.toFixed(1)}%
                          </div>
                          <div className="text-xs text-orange-300 mt-1">
                            {simulationResults.spread.homeCoverPct > 52.4 ? '✓ +EV vs -110' : ''}
                          </div>
                        </div>
                        <div className="bg-gradient-to-br from-purple-600/20 to-purple-800/20 p-4 rounded-lg border border-purple-600/30">
                          <div className="text-sm text-purple-300 mb-1">
                            {simulationResults.awayTeam} {-simulationResults.spread.line > 0 ? '+' : ''}{-simulationResults.spread.line}
                          </div>
                          <div className="text-3xl font-bold text-purple-400">
                            {simulationResults.spread.awayCoverPct.toFixed(1)}%
                          </div>
                          <div className="text-xs text-purple-300 mt-1">
                            {simulationResults.spread.awayCoverPct > 52.4 ? '✓ +EV vs -110' : ''}
                          </div>
                        </div>
                        <div className="bg-gradient-to-br from-slate-600/20 to-slate-800/20 p-4 rounded-lg border border-slate-600/30">
                          <div className="text-sm text-slate-300 mb-1">Push</div>
                          <div className="text-3xl font-bold text-slate-400">
                            {simulationResults.spread.pushPct.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      <div className="text-center text-slate-400">
                        Projected Margin: <span className="text-yellow-400 font-bold text-xl">
                          {-simulationResults.marginProjection.mean > 0 ? '+' : ''}{(-simulationResults.marginProjection.mean).toFixed(1)}
                        </span>
                      </div>
                    </div>

                    {/* Moneyline */}
                    <div className="bg-slate-800 p-6 rounded-lg border border-slate-700">
                      <h3 className="text-xl font-bold mb-4">💰 Moneyline</h3>
                      <div className="grid grid-cols-2 gap-6">
                        <div className="text-center">
                          <div className="text-orange-400 font-semibold">{simulationResults.homeTeam}</div>
                          <div className="text-2xl font-bold">{simulationResults.moneyline.homeWinPct.toFixed(1)}%</div>
                          <div className="text-slate-400">Fair: {simulationResults.moneyline.homeFairOdds}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-purple-400 font-semibold">{simulationResults.awayTeam}</div>
                          <div className="text-2xl font-bold">{simulationResults.moneyline.awayWinPct.toFixed(1)}%</div>
                          <div className="text-slate-400">Fair: {simulationResults.moneyline.awayFairOdds}</div>
                        </div>
                      </div>
                    </div>

                    {/* Projected Scores */}
                    <div className="bg-slate-800 p-6 rounded-lg border border-slate-700">
                      <h3 className="text-xl font-bold mb-4">📊 Projected Scores</h3>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="text-center">
                          <div className="text-orange-400 font-semibold mb-2">{simulationResults.homeTeam}</div>
                          <div className="text-4xl font-bold text-orange-400">{simulationResults.homeProjection.mean.toFixed(1)}</div>
                          <div className="text-xs text-slate-400 mt-2">
                            10-90%: {simulationResults.homeProjection.p10.toFixed(0)} - {simulationResults.homeProjection.p90.toFixed(0)}
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="text-purple-400 font-semibold mb-2">{simulationResults.awayTeam}</div>
                          <div className="text-4xl font-bold text-purple-400">{simulationResults.awayProjection.mean.toFixed(1)}</div>
                          <div className="text-xs text-slate-400 mt-2">
                            10-90%: {simulationResults.awayProjection.p10.toFixed(0)} - {simulationResults.awayProjection.p90.toFixed(0)}
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="text-blue-400 font-semibold mb-2">Total</div>
                          <div className="text-4xl font-bold text-blue-400">{simulationResults.totalProjection.mean.toFixed(1)}</div>
                          <div className="text-xs text-slate-400 mt-2">
                            10-90%: {simulationResults.totalProjection.p10.toFixed(0)} - {simulationResults.totalProjection.p90.toFixed(0)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default NFLTotalsSimulator;
