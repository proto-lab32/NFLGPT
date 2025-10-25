import React, { useState } from "react";
import { Upload, Play, BarChart3, TrendingUp, Settings, Bug } from "lucide-react";

/**
 * NFL Monte Carlo Game Simulator (Gaussian) — v2
 * - FIXED: shared game drives now SUM two off/def averages (~22–26 baseline), clamp [20,30]
 * - Debug panel shows gameDrives, posShare, per-team drives & PPD used in sim
 * - Uses NET features (off − def), PPD residualization (c1=0.56, c2=0.21)
 * - DVOA acts as prior; variance tied to 3&Out (up) and SR (down)
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
    EV_SD_Total: 12.7,
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
  const [showDebug, setShowDebug] = useState(true);

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

  // Compute shared game pace (FIXED drives calc) and possession share tilt
  const computeGamePace = (homeTeam, awayTeam, awayDef, homeDef, netsHome) => {
    const w = params.weights;
    // Per-team averages (~11–12 each)
    const offDefAvgHome = (homeTeam.off_drives + awayDef.def_drives) / 2;
    const offDefAvgAway = (awayTeam.off_drives + homeDef.def_drives) / 2;
    // SUM to get game-level drives (~22–24), then apply pace factors
    let gameDrives = (offDefAvgHome + offDefAvgAway);

    const nh_boost = ((homeTeam.no_huddle || 0) + (awayTeam.no_huddle || 0)) / 2 * w.NoHuddle * 0.5;
    const ed_adj   = (((homeTeam.ed_pass || 0) - 0.5) + ((awayTeam.ed_pass || 0) - 0.5)) / 2 * w.Pace_EDPass;
    gameDrives = gameDrives * (1 + nh_boost + ed_adj);

    // Clamp to realistic combined drives per game
    gameDrives = Math.min(30, Math.max(20, gameDrives)); // typical ~22–26

    // Possession share tilt by SR/EPA nets (home perspective)
    let posShare = 0.5 + 0.15 * (netsHome.sr_net + 0.5 * netsHome.epa_net);
    posShare = Math.max(0.35, Math.min(0.65, posShare));
    return { gameDrives, posShare };
  };

  const projectTeamFromDB = (teamName) => {
    const r = teamDB[teamName] || {};
    return {
      name: teamName,
      // Offense
      off_ppd: parseNum(r.off_ppd, 2.06),
      off_epa: parseNum(r.off_epa, 0.022),
      off_sr: parsePct(r.off_sr, 0.43),
      off_xpl: parsePct(r.off_xpl, 0.113),
      off_rz: parsePct(r.off_rz, 0.56),
      off_3out: parsePct(r.off_3out, 0.24),
      off_penalties: parseNum(r.off_penalties, 0.44),
      off_to_epa: parseNum(r.off_to_epa, 0),
      off_fp: parseNum(r.off_fp, 25),
      // Defense (allowed/forced)
      def_ppd_allowed: parseNum(r.def_ppd_allowed, 2.06),
      def_epa_allowed: parseNum(r.def_epa_allowed, 0.022),
      def_sr: parsePct(r.def_sr, 0.43),
      def_xpl: parsePct(r.def_xpl, 0.113),
      def_rz: parsePct(r.def_rz, 0.56),
      def_3out: parsePct(r.def_3out, 0.24),
      def_penalties: parseNum(r.def_penalties, 0.44),
      // Macro
      off_dvoa: parseNum(r.off_dvoa, 0),
      def_dvoa: parseNum(r.def_dvoa, 0),
      // Pace
      off_drives: parseNum(r.off_drives, 12),
      def_drives: parseNum(r.def_drives, 12),
      off_plays: parseNum(r.off_plays, 62),
      def_plays: parseNum(r.def_plays, 62),
      ed_pass: parsePct(r.ed_pass, 0.5), // early-down pass rate
      no_huddle: parsePct(r.no_huddle, 0.02),
    };
  };

  // Core: map nets & priors to expected points and variance (Gaussian sampling)
  // (Returns debug details: drives & ppd)
  const estimateScore = (team, oppDefense, isHome, hfa, gameDrives, posShare, nets) => {
    const lg = params.lg;
    const w = params.weights;
    const { epa_net, sr_net, ppd_resid, xpl_net, rz_net, out_net, z_pen_o, z_pen_d } = nets;

    // Mean advantage from nets
    const eff_net =
      ppd_resid * w.PPD +
      epa_net   * w.EPA +
      sr_net    * w.SR  +
      xpl_net   * w.Xpl +
      rz_net    * w.RZ  +
      out_net   * w.ThreeOut_eff;

    // DVOA prior & ancillaries
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

    // Variance tied to 3&out (inflater) and SR (deflater)
    const threeOut_net = (oppDefense.def_3out - team.off_3out);
    const sr_net2      = (team.off_sr - oppDefense.def_sr);

    const baseVar = Math.pow(params.EV_SD_Total, 2) / 2;
    const volUp   = 1 + 0.8 * Math.max(0, threeOut_net);
    const volDown = 1 - 0.6 * Math.max(0, sr_net2);
    const std_dev = Math.sqrt(baseVar * volUp * Math.max(0.6, volDown));

    return { points: Math.max(0, pts), std_dev, drives, ppd };
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

    // Calculate projections with their standard deviations (now includes drives & ppd debug)
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
      debug: {
        gameDrives,
        posShare,
        home: { drives: homeProjection.drives, ppd: homeProjection.ppd },
        away: { drives: awayProjection.drives, ppd: awayProjection.ppd },
      }
    };

    setSimulationResults(result);
  };

  const handleCSVUpload = async (file) => {
    try {
      const text = await file.text();
      // Basic CSV parse (no external libs to keep it deployable)
      const lines = text.split(/\r?\n/).filter(Boolean);
      const header = lines[0].split(",").map((h) => h.trim());
      const rows = lines.slice(1).map((line) => {
        const cols = line.split(",");
        const obj = {};
        header.forEach((h, i) => (obj[h] = cols[i]));
        return obj;
      });

      const nextDB = {};
      const names = [];
      rows.forEach((row) => {
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
      setUploadStatus(`✅ Loaded ${names.length} teams`);
      setSimulationResults(null);
    } catch (e) {
      setUploadStatus(`❌ Error: ${e?.message || e}`);
    }
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
      <h1 className="text-2xl font-bold mb-4 flex items-center gap-2"><BarChart3 size={22}/> NFL Monte Carlo Game Simulator (Gaussian v2)</h1>

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

          <div className="mt-3 flex items-center gap-2 text-sm">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={showDebug} onChange={(e)=>setShowDebug(e.target.checked)} />
              <Bug size={16}/> Show debug panel
            </label>
          </div>
        </div>
      </div>

      {simulationResults && (
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><TrendingUp size={18}/> Results</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <h3 className="font-semibold">Means</h3>
              <ul className="text-sm mt-2">
                <li><strong>{simulationResults.home}</strong> mean: {simulationResults.homeMean.toFixed(2)}</li>
                <li><strong>{simulationResults.away}</strong> mean: {simulationResults.awayMean.toFixed(2)}</li>
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

          {showDebug && (
            <div className="mt-4 border-t pt-3 text-sm">
              <h3 className="font-semibold mb-2">Debug</h3>
              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <div><strong>gameDrives</strong>: {simulationResults.debug.gameDrives.toFixed(2)}</div>
                  <div><strong>posShare</strong>: {(simulationResults.debug.posShare*100).toFixed(1)}%</div>
                </div>
                <div>
                  <div><strong>Home drives</strong>: {simulationResults.debug.home.drives.toFixed(2)}</div>
                  <div><strong>Home PPD</strong>: {simulationResults.debug.home.ppd.toFixed(3)}</div>
                </div>
                <div>
                  <div><strong>Away drives</strong>: {simulationResults.debug.away.drives.toFixed(2)}</div>
                  <div><strong>Away PPD</strong>: {simulationResults.debug.away.ppd.toFixed(3)}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 border rounded p-4">
        <h2 className="font-semibold mb-2 flex items-center gap-2"><Settings size={18}/> Notes</h2>
        <ul className="text-sm list-disc pl-5 space-y-1">
          <li><strong>FIXED:</strong> shared game drives use SUM of off/def averages and clamp to [20,30].</li>
          <li>PPD is residualized on EPA & SR with c1=0.56, c2=0.21.</li>
          <li>DVOA is a prior (smaller weight than EPA/SR) blended at the mean layer.</li>
          <li>Variance is matchup-specific: higher 3&out → fatter tails; higher SR → skinnier tails.</li>
          <li>HFA applied to home side only (margin shift preserved).</li>
        </ul>
      </div>
    </div>
  );
};

export default MonteCarloSimulator;
