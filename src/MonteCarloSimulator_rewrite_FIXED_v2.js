import React, { useState, useMemo } from "react";
import { Upload, Play, BarChart3, TrendingUp, Settings } from "lucide-react";

/**
 * NFL Monte Carlo Game Simulator (FIXED VERSION)
 * 
 * FIXES:
 * 1. Corrected variance calculation - uses per-team SD, not total/2
 * 2. Fixed variance modifiers to use z-scores from nets
 * 3. Better base variance for realistic score distributions
 */

const MonteCarloSimulator = () => {
  // League baseline parameters
  const params = {
    lg: {
      PPD: 2.06,
      PPD_sd: 0.42,
      EPA: 0.022,
      EPA_sd: 0.127,
      SR: 0.43,
      SR_sd: 0.05,
      Xpl: 0.113,
      Xpl_sd: 0.033,
      RZ: 0.56,
      RZ_sd: 0.12,
      ThreeOut: 0.24,
      ThreeOut_sd: 0.05,
      Pen: 0.44,
      Pen_sd: 0.12,
      Drives: 24,
      Plays: 62,
    },
    // Rebalanced mean weights (EPA-dominant; DVOA as prior)
    weights: {
      PPD: 0.20,      // use residual if available
      EPA: 0.40,
      SR:  0.20,
      Xpl: 0.10,
      RZ:  0.10,
      ThreeOut_eff: 0.25,
      Pen: 0.05,
      Pen_def: 0.05,
      DVOA_off: 0.15,
      DVOA_def: 0.15,
      TO_EPA: 0.10,
      FP: 0.10,
      Pace_EDPass: 0.10,
      NoHuddle: 0.20,
    },
    // Base per-team standard deviation (NOT total game SD)
    BaseTeamSD: 9.0,  // Each team has ~9 point SD, giving ~12.7 total game SD
  };

  // Residualization coefficients for PPD ~ EPA + SR (from prior discussion)
  const PPD_RESID_C1 = 0.56; // coefficient on EPA_net
  const PPD_RESID_C2 = 0.21; // coefficient on SR_net

  const [teamDB, setTeamDB] = useState({});
  const [teamList, setTeamList] = useState([]);
  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  const [hfaAdjustment, setHfaAdjustment] = useState(0);
  const [numSimulations, setNumSimulations] = useState(10000);
  const [marketTotal, setMarketTotal] = useState("");
  const [marketSpread, setMarketSpread] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [simulationResults, setSimulationResults] = useState(null);
  const [isSimulating, setIsSimulating] = useState(false);

  const parseNum = (val, def) => {
    if (val === null || val === undefined || val === "") return def;
    const str = String(val);
    const hasPercent = str.includes("%");
    const n = typeof val === "number" ? val : parseFloat(str.replace(/%/g, ""));
    if (isNaN(n)) return def;
    // Only convert to decimal if it has a % sign
    if (hasPercent) {
      return n / 100;
    }
    return n;
  };

  // Helper to parse percentage fields - converts to decimal if needed
  const parsePct = (val, def) => {
    if (val === null || val === undefined || val === "") return def;
    const str = String(val);
    const hasPercent = str.includes("%");
    const n = typeof val === "number" ? val : parseFloat(str.replace(/%/g, ""));
    if (isNaN(n)) return def;
    // If has % sign, convert to decimal
    return hasPercent ? n / 100 : n;
  };

  const zScore = (value, mean, sd) => {
    if (value === null || value === undefined) return 0;
    if (!isFinite(sd) || sd === 0) return 0;
    return (value - mean) / sd;
  };

  // Compute net z-features (offense vs opponent defense), and residualize PPD
  const computeNetFeatures = (team, oppDefense) => {
    const lg = params.lg;
    // offensive z
    const z_ppd_o = zScore(team.off_ppd, lg.PPD, lg.PPD_sd);
    const z_epa_o = zScore(team.off_epa, lg.EPA, lg.EPA_sd);
    const z_sr_o  = zScore(team.off_sr,  lg.SR,  lg.SR_sd);
    const z_xpl_o = zScore(team.off_xpl, lg.Xpl, lg.Xpl_sd);
    const z_rz_o  = zScore(team.off_rz,  lg.RZ,  lg.RZ_sd);
    const z_out_o = zScore(team.off_3out, lg.ThreeOut, lg.ThreeOut_sd);
    const z_pen_o = zScore(team.off_penalties, lg.Pen, lg.Pen_sd);

    // defensive z (opponent)
    const z_ppd_d = zScore(oppDefense.def_ppd_allowed, lg.PPD, lg.PPD_sd);
    const z_epa_d = zScore(oppDefense.def_epa_allowed, lg.EPA, lg.EPA_sd);
    const z_sr_d  = zScore(oppDefense.def_sr,  lg.SR,  lg.SR_sd);
    const z_xpl_d = zScore(oppDefense.def_xpl, lg.Xpl, lg.Xpl_sd);
    const z_rz_d  = zScore(oppDefense.def_rz,  lg.RZ,  lg.RZ_sd);
    const z_out_d = zScore(oppDefense.def_3out, lg.ThreeOut, lg.ThreeOut_sd);
    const z_pen_d = zScore(oppDefense.def_penalties, lg.Pen, lg.Pen_sd);

    const epa_net = z_epa_o - z_epa_d;
    const sr_net  = z_sr_o  - z_sr_d;
    const ppd_net = z_ppd_o - z_ppd_d;
    const xpl_net = z_xpl_o - z_xpl_d;
    const rz_net  = z_rz_o  - z_rz_d;
    const out_net = (z_out_d - z_out_o); // higher is worse for offense

    // Residualize PPD on EPA and SR
    const ppd_resid = ppd_net - (PPD_RESID_C1 * epa_net + PPD_RESID_C2 * sr_net);

    return { epa_net, sr_net, ppd_resid, xpl_net, rz_net, out_net, z_pen_o, z_pen_d };
  };

  // Compute shared game drives and possession share tilt
  const computeGamePace = (homeTeam, awayTeam, awayDef, homeDef, netsHome) => {
    const w = params.weights;
    // baseline shared drives from offense/defense
    const baseDrives = ((homeTeam.off_drives + awayDef.def_drives) / 2 + (awayTeam.off_drives + homeDef.def_drives) / 2) / 2;
    const nh_boost = ((homeTeam.no_huddle || 0) + (awayTeam.no_huddle || 0)) / 2 * w.NoHuddle * 0.5;
    const ed_adj   = (((homeTeam.ed_pass || 0) - 0.5) + ((awayTeam.ed_pass || 0) - 0.5)) / 2 * w.Pace_EDPass;
    let gameDrives = baseDrives * (1 + nh_boost + ed_adj);
    gameDrives = Math.min(28, Math.max(18, gameDrives));

    // Possession share tilt by SR/EPA nets (home perspective)
    let posShare = 0.5 + 0.15 * (netsHome.sr_net + 0.5 * netsHome.epa_net);
    posShare = Math.max(0.35, Math.min(0.65, posShare));

    return { gameDrives, posShare };
  };

  const projectTeamFromDB = (teamName) => {
    const r = teamDB[teamName] || {};
    
    // Helper to try multiple header variations (snake_case or Readable Format)
    const getVal = (keys) => {
      for (let key of keys) {
        if (r[key] !== undefined && r[key] !== null && r[key] !== "") {
          return r[key];
        }
      }
      return undefined;
    };
    
    return {
      name: teamName,
      // Offense - try both header formats
      off_ppd: parseNum(getVal(['off_ppd', 'Off PPD']), 2.06),
      off_epa: parseNum(getVal(['off_epa', 'Off EPA/play']), 0.022),
      off_sr: parsePct(getVal(['off_sr', 'Off Success Rate']), 0.43),
      off_xpl: parsePct(getVal(['off_xpl', 'Off Explosive Rate']), 0.113),
      off_rz: parsePct(getVal(['off_rz', 'Off Red-Zone TD%', 'Off Red Zone TD%']), 0.56),
      off_3out: parsePct(getVal(['off_3out', 'Off 3-Out %']), 0.24),
      off_penalties: parseNum(getVal(['off_penalties', 'Off Penalties per Drive']), 0.44),
      off_to_epa: parseNum(getVal(['off_to_epa', 'Off TO EPA per Drive']), 0),
      off_fp: parseNum(getVal(['off_fp', 'Off Avg Starting FP']), 25),
      // Defense (allowed/forced) - try both header formats
      def_ppd_allowed: parseNum(getVal(['def_ppd_allowed', 'Def PPD Allowed']), 2.06),
      def_epa_allowed: parseNum(getVal(['def_epa_allowed', 'Def EPA/play allowed']), 0.022),
      def_sr: parsePct(getVal(['def_sr', 'Def Success Rate']), 0.43),
      def_xpl: parsePct(getVal(['def_xpl', 'Def Explosive Rate']), 0.113),
      def_rz: parsePct(getVal(['def_rz', 'Def Red Zone TD %', 'Def Red-Zone TD%']), 0.56),
      def_3out: parsePct(getVal(['def_3out', 'Def 3-Out %']), 0.24),
      def_penalties: parseNum(getVal(['def_penalties', 'DEF Penalties per Drive', 'Def Penalties per Drive']), 0.44),
      // Macro - try both header formats
      off_dvoa: parseNum(getVal(['off_dvoa', 'Off DVOA']), 0),
      def_dvoa: parseNum(getVal(['def_dvoa', 'Def DVOA']), 0),
      // Pace - try both header formats
      off_drives: parseNum(getVal(['off_drives', 'Off Drives/G']), 12),
      def_drives: parseNum(getVal(['def_drives', 'Def Drives/G']), 12),
      off_plays: parseNum(getVal(['off_plays', 'Off Plays/Drive']), 62),
      def_plays: parseNum(getVal(['def_plays', 'Def Plays/Drive Allowed']), 62),
      ed_pass: parsePct(getVal(['ed_pass', 'Neutral Early-Down Pass %']), 0.5),
      no_huddle: parsePct(getVal(['no_huddle', 'No-Huddle %']), 0.02),
    };
  };

  // CSV uploader
  const handleCSVUpload = async (file) => {
    setUploadStatus("Reading file…");
    try {
      const text = await file.text();
      const Papa = await import("papaparse");
      const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });

      if (!parsed.data || parsed.data.length === 0) {
        setUploadStatus("❌ Error: empty CSV");
        return;
      }

      const nextDB = {};
      const names = [];

      parsed.data.forEach((row) => {
        const name = String(row["Team"] || row["team"] || "").trim();
        if (!name) return;
        names.push(name);
        nextDB[name] = { ...row };
      });

      if (names.length === 0) {
        setUploadStatus("❌ Error: No teams found. Make sure CSV has 'Team' column.");
        return;
      }

      setTeamDB(nextDB);
      setTeamList(names.sort());
      
      // DIAGNOSTIC: Check if headers match and data is being read correctly
      if (names.length > 0) {
        const firstTeam = names[0];
        const projected = projectTeamFromDB(firstTeam);
        
        // Check if all key stats are defaulting (indicates header mismatch)
        const isAllDefaults = 
          projected.off_ppd === 2.06 &&
          projected.off_epa === 0.022 &&
          projected.off_sr === 0.43 &&
          projected.def_ppd_allowed === 2.06;
        
        if (isAllDefaults) {
          console.warn("⚠️ WARNING: Team stats appear to be all defaults!");
          console.warn("CSV Headers:", Object.keys(parsed.data[0]));
          console.warn("This likely means your CSV headers don't match the expected format.");
          setUploadStatus(`⚠️ Loaded ${names.length} teams - WARNING: Headers may not match! Check console.`);
        } else {
          console.log("✅ Successfully mapped team data");
          console.log("Sample team:", firstTeam);
          console.log("Off PPD:", projected.off_ppd, "Off EPA:", projected.off_epa);
          setUploadStatus(`✅ Loaded ${names.length} teams`);
        }
      } else {
        setUploadStatus(`✅ Loaded ${names.length} teams`);
      }
      
      setSimulationResults(null);
    } catch (e) {
      setUploadStatus(`❌ Error: ${e?.message || e}`);
    }
  };

  // Core: map nets & priors to expected points and variance (Gaussian sampling)
  const estimateScore = (team, oppDefense, isHome, hfa, gameDrives, posShare, nets) => {
    const lg = params.lg;
    const w = params.weights;

    // Use provided nets
    const { epa_net, sr_net, ppd_resid, xpl_net, rz_net, out_net, z_pen_o, z_pen_d } = nets;

    // Mean advantage from nets
    const eff_net =
      ppd_resid * w.PPD +
      epa_net   * w.EPA +
      sr_net    * w.SR  +
      xpl_net   * w.Xpl +
      rz_net    * w.RZ  +
      out_net   * w.ThreeOut_eff;

    // DVOA prior & ancillaries (use raw values passed on team/def)
    const dvoa_adj = (team.off_dvoa / 100) * w.DVOA_off - (oppDefense.def_dvoa / 100) * w.DVOA_def;
    const to_adj   = (team.off_to_epa * w.TO_EPA) / lg.Drives;
    const fp_adj   = ((team.off_fp - 25) / 10) * w.FP;
    const pen_adj  = (-z_pen_o * w.Pen + z_pen_d * w.Pen_def);

    const net_adv = eff_net + dvoa_adj + to_adj + fp_adj + pen_adj;

    // Drives for this team from shared game drives
    const drives = isHome ? gameDrives * posShare : gameDrives * (1 - posShare);

    // Convert advantage in z-space to PPD
    let ppd = lg.PPD + net_adv * lg.PPD_sd;

    // Apply HFA to home side only (so total margin shift equals hfa)
    if (isHome && hfa) {
      ppd += (hfa / Math.max(1, drives));
    }

    // Safety clamp to plausible range
    ppd = Math.max(0.4, Math.min(4.0, ppd));

    const pts = ppd * drives;

    // FIXED VARIANCE CALCULATION
    // Start with base per-team SD
    let std_dev = params.BaseTeamSD;
    
    // Adjust variance based on matchup characteristics using z-scores from nets
    // Higher 3&out differential → more variance (more unpredictable)
    const var_inflater = 1 + 0.3 * Math.abs(out_net);
    
    // Higher SR differential → less variance (more predictable)
    const var_deflater = 1 - 0.15 * Math.abs(sr_net);
    
    // Apply modifiers
    std_dev = std_dev * var_inflater * Math.max(0.7, var_deflater);
    
    // Clamp to reasonable bounds
    std_dev = Math.max(6.0, Math.min(13.0, std_dev));

    return { points: Math.max(0, pts), std_dev };
  };

  const runSimulation = () => {
    if (!homeTeam || !awayTeam) {
      setUploadStatus("❌ Pick both teams");
      return;
    }
    if (!teamDB[homeTeam] || !teamDB[awayTeam]) {
      setUploadStatus("❌ Missing team data");
      return;
    }

    const homeData = projectTeamFromDB(homeTeam);
    const awayData = projectTeamFromDB(awayTeam);

    const effectiveHFA = hfaAdjustment;

    // Build nets from each perspective
    const netsHome = computeNetFeatures(homeData, awayData);
    const netsAway = computeNetFeatures(awayData, homeData);

    // Shared pace and possession share (home perspective nets)
    const { gameDrives, posShare } = computeGamePace(homeData, awayData, awayData, homeData, netsHome);

    // Calculate projections with their standard deviations
    const homeProjection = estimateScore(homeData, awayData, true, effectiveHFA, gameDrives, posShare, netsHome);
    const awayProjection = estimateScore(awayData, homeData, false, effectiveHFA, gameDrives, posShare, netsAway);

    const homeScores = [];
    const awayScores = [];
    const totals = [];
    const spreads = [];

    for (let i = 0; i < numSimulations; i++) {
      // Box-Muller normals
      const u1 = Math.random();
      const u2 = Math.random();
      const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const homeScore = Math.max(0, Math.round(homeProjection.points + z1 * homeProjection.std_dev));

      const u3 = Math.random();
      const u4 = Math.random();
      const z2 = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u4);
      const awayScore = Math.max(0, Math.round(awayProjection.points + z2 * awayProjection.std_dev));

      homeScores.push(homeScore);
      awayScores.push(awayScore);
      totals.push(homeScore + awayScore);
      spreads.push(homeScore - awayScore);
    }

    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const median = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const percentile = (arr, p) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.floor(sorted.length * p);
      return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
    };

    const totMean = mean(totals), sprMean = mean(spreads);

    const mktTot = parseNum(marketTotal, null);
    const mktSpr = parseNum(marketSpread, null);

    const result = {
      home: homeTeam,
      away: awayTeam,
      homeMean: mean(homeScores),
      awayMean: mean(awayScores),
      totalMean: totMean,
      totalMedian: median(totals),
      spreadMean: sprMean,
      spreadMedian: median(spreads),
      homeSD: homeProjection.std_dev,
      awaySD: awayProjection.std_dev,
      pOver: mktTot !== null ? totals.filter((x) => x > mktTot).length / totals.length : null,
      pUnder: mktTot !== null ? totals.filter((x) => x < mktTot).length / totals.length : null,
      pHomeCover: mktSpr !== null ? spreads.filter((s) => s + (-mktSpr) > 0).length / spreads.length : null, // home - spread > 0
      pAwayCover: mktSpr !== null ? spreads.filter((s) => s + (-mktSpr) < 0).length / spreads.length : null,
      totalDist: {
        p10: percentile(totals, 0.10), p25: percentile(totals, 0.25), p50: percentile(totals, 0.50), p75: percentile(totals, 0.75), p90: percentile(totals, 0.90)
      },
      spreadDist: {
        p10: percentile(spreads, 0.10), p25: percentile(spreads, 0.25), p50: percentile(spreads, 0.50), p75: percentile(spreads, 0.75), p90: percentile(spreads, 0.90)
      },
    };

    setSimulationResults(result);
  };

  const handleSimulateClick = async () => {
    setIsSimulating(true);
    try {
      runSimulation();
    } finally {
      setIsSimulating(false);
    }
  };

  const TeamSelector = ({ label, value, onChange }) => (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-gray-600">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="border rounded px-3 py-2">
        <option value="">Select team</option>
        {teamList.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-4 flex items-center gap-2"><BarChart3 size={22}/> NFL Monte Carlo Game Simulator (FIXED)</h1>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="md:col-span-1 border rounded p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2"><Upload size={18}/> Load Teams</h2>
          <input type="file" accept=".csv" onChange={(e) => e.target.files && handleCSVUpload(e.target.files[0])} />
          <p className="text-sm text-gray-600 mt-2">CSV must include a <code>Team</code> column.</p>
          <p className="text-sm mt-2">{uploadStatus}</p>
        </div>

        <div className="md:col-span-2 border rounded p-4">
          <h2 className="font-semibold mb-2">Matchup</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TeamSelector label="Home Team" value={homeTeam} onChange={setHomeTeam} />
            <TeamSelector label="Away Team" value={awayTeam} onChange={setAwayTeam} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div>
              <label className="text-sm text-gray-600">HFA (points)</label>
              <input type="number" className="border rounded px-3 py-2 w-full" value={hfaAdjustment} onChange={(e) => setHfaAdjustment(parseFloat(e.target.value || 0))} />
            </div>
            <div>
              <label className="text-sm text-gray-600">Simulations</label>
              <input type="number" className="border rounded px-3 py-2 w-full" value={numSimulations} onChange={(e) => setNumSimulations(parseInt(e.target.value || 10000))} />
            </div>
            <div>
              <label className="text-sm text-gray-600">Market Total</label>
              <input type="text" className="border rounded px-3 py-2 w-full" value={marketTotal} onChange={(e) => setMarketTotal(e.target.value)} placeholder="e.g., 44.5" />
            </div>
            <div>
              <label className="text-sm text-gray-600">Market Spread (home -)</label>
              <input type="text" className="border rounded px-3 py-2 w-full" value={marketSpread} onChange={(e) => setMarketSpread(e.target.value)} placeholder="e.g., -3" />
            </div>
          </div>

          <button onClick={handleSimulateClick} disabled={!homeTeam || !awayTeam || isSimulating} className="mt-4 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
            <Play size={16}/> {isSimulating ? "Simulating..." : "Run Monte Carlo"}
          </button>
        </div>
      </div>

      {simulationResults && (
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><TrendingUp size={18}/> Results</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <h3 className="font-semibold">Means & Standard Deviations</h3>
              <ul className="text-sm mt-2">
                <li><strong>{simulationResults.home}</strong> mean: {simulationResults.homeMean.toFixed(2)} (SD: {simulationResults.homeSD.toFixed(1)})</li>
                <li><strong>{simulationResults.away}</strong> mean: {simulationResults.awayMean.toFixed(2)} (SD: {simulationResults.awaySD.toFixed(1)})</li>
                <li>Total mean: {simulationResults.totalMean.toFixed(2)} (median {simulationResults.totalMedian.toFixed(2)})</li>
                <li>Home spread mean: {simulationResults.spreadMean.toFixed(2)} (median {simulationResults.spreadMedian.toFixed(2)})</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold">Market Probabilities</h3>
              <ul className="text-sm mt-2">
                {simulationResults.pOver !== null && (
                  <li>Over {marketTotal}: {(simulationResults.pOver * 100).toFixed(1)}%</li>
                )}
                {simulationResults.pUnder !== null && (
                  <li>Under {marketTotal}: {(simulationResults.pUnder * 100).toFixed(1)}%</li>
                )}
                {simulationResults.pHomeCover !== null && (
                  <li>Home cover vs {marketSpread}: {(simulationResults.pHomeCover * 100).toFixed(1)}%</li>
                )}
                {simulationResults.pAwayCover !== null && (
                  <li>Away cover vs {marketSpread}: {(simulationResults.pAwayCover * 100).toFixed(1)}%</li>
                )}
              </ul>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4 mt-4">
            <div>
              <h4 className="font-semibold">Total Distribution (p10/p25/p50/p75/p90)</h4>
              <div className="text-sm mt-2">
                {Object.values(simulationResults.totalDist).map((v, i) => (
                  <span key={i} className="inline-block mr-3">{v}</span>
                ))}
              </div>
            </div>
            <div>
              <h4 className="font-semibold">Spread Distribution (p10/p25/p50/p75/p90)</h4>
              <div className="text-sm mt-2">
                {Object.values(simulationResults.spreadDist).map((v, i) => (
                  <span key={i} className="inline-block mr-3">{v}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 border rounded p-4">
        <h2 className="font-semibold mb-2 flex items-center gap-2"><Settings size={18}/> Notes</h2>
        <ul className="text-sm list-disc pl-5 space-y-1">
          <li><strong>FIXED:</strong> Variance calculation now uses proper per-team SD (~9 points) instead of dividing total by 2</li>
          <li><strong>FIXED:</strong> Variance modifiers now correctly use z-scores from net features</li>
          <li>PPD is residualized on EPA & SR with c1=0.56, c2=0.21 (from prior discussion).</li>
          <li>DVOA is treated as a prior (smaller weight than EPA/SR) and blended at the mean layer.</li>
          <li>Variance is matchup-specific: higher 3&out → fatter tails; higher SR → skinnier tails.</li>
          <li>Shared game drives with a mild possession-share tilt based on EPA/SR nets.</li>
          <li>HFA is applied to the home side only, preserving the total margin shift.</li>
        </ul>
      </div>
    </div>
  );
};

export default MonteCarloSimulator;
