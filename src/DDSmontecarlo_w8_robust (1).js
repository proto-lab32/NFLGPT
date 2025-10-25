import React, { useState } from "react";
import { Upload, Play, BarChart3, TrendingUp, Settings, Bug, AlertTriangle } from "lucide-react";

/**
 * DDSmontecarlo (Week-8 Calibrated) — Robust CSV + Data Health + Debug
 * - Discrete per-drive simulator (3&Out / TD / FG / Empty)
 * - Header-alias tolerant CSV loader with percent parsing
 * - Data Health panel lists defaulted fields per team
 * - Debug panel shows pace, derived probabilities and per-team drives
 * - Calibrated intercepts from your Week-8 dataset: a0=-1.31, b0=-0.76, phi=0.32
 */

const DDSmontecarlo = () => {
  // League baselines
  const params = {
    lg: {
      PPD: 2.02, PPD_sd: 0.40,
      EPA: 0.022, EPA_sd: 0.127,
      SR: 0.43, SR_sd: 0.05,
      RZ: 0.56, RZ_sd: 0.12,
      ThreeOut: 0.24, ThreeOut_sd: 0.05,
      Drives: 24,
    },
    // Week-8 calibrated logits
    logits: {
      // p3O = σ(a0 − a1·EPA_net − a2·SR_net + a3·Opp3O_raw + a4·RZ_bad)
      a0: -1.31, a1: 1.10, a2: 0.85, a3: 0.60, a4: 0.25,
      // pTD|Sustain = σ(b0 + b1·EPA_net + b2·SR_net + b3·RZ_net + b4·PPD_resid)
      b0: -0.76, b1: 0.95, b2: 0.55, b3: 0.35, b4: 0.40,
      phi: 0.32, // FG bias on non-TD sustains
    },
    // Weights (for pace/tilt only)
    weights: {
      EPA: 0.40, SR: 0.25, PPD_resid: 0.20, RZ: 0.10, ThreeOut_eff: 0.05,
      DVOA_off: 0.12, DVOA_def: 0.12, Pace_EDPass: 0.10, NoHuddle: 0.20,
    },
    // Residualization coefficients for PPD ~ EPA + SR
    resid: { c1: 0.56, c2: 0.21 },
  };

  const [teamDB, setTeamDB] = useState({});
  const [teamList, setTeamList] = useState([]);
  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  const [hfaPoints, setHfaPoints] = useState(0.0);
  const [numSim, setNumSim] = useState(10000);
  const [marketTotal, setMarketTotal] = useState("");
  const [marketSpread, setMarketSpread] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [results, setResults] = useState(null);
  const [isSim, setIsSim] = useState(false);
  const [showDebug, setShowDebug] = useState(true);
  const [dataHealth, setDataHealth] = useState({}); // { team: [missingField,...] }

  // --- CSV header aliases (same pattern as Gaussian v3) ---
  const aliases = {
    // Offense
    off_ppd: ["off_ppd","Off PPD","Off. PPD","PPD Offense","Off Points/Drive","Off Pts/Drive"],
    off_epa: ["off_epa","Off EPA","Off EPA/Play","Off EPA per Play","EPA/play Offense","EPA per Play Off","Off EPA/play"],
    off_sr:  ["off_sr","Off SR","Off Success Rate","Off Success %","Off Success%","Off SR%","Success Rate Off"],
    off_rz:  ["off_rz","Off Red-Zone TD%","Off RZ TD%","Off RZ%","Red Zone TD% Off"],
    off_3out:["off_3out","Off 3-Out %","Off Three-And-Out %","Off 3&Out %","3 and out % Off","3-Out% Off"],
    off_xpl: ["off_xpl","Off Explosive %","Off Xpl%","Explosive Rate Off","% Explosive Plays Off","Off Explosive Rate"],
    off_penalties:["off_penalties","Off Penalties","Off Pen Yds/G","Off Pen Yds/GM","Off Penalty Yds","Off Penalties per Drive"],
    off_to_epa:["off_to_epa","Off TO EPA","Turnover EPA Off","TO EPA (Off)","Off TO EPA per Drive"],
    off_fp:  ["off_fp","Off FP","Off Field Position","Avg Start Ydline Off","Starting FP Off","Off Avg Starting FP"],
    // Defense
    def_ppd_allowed:["def_ppd_allowed","Def PPD Allowed","Def PPD","PPD Defense Allowed","Points/Drive Allowed"],
    def_epa_allowed:["def_epa_allowed","Def EPA","Def EPA/Play Allowed","EPA per Play Allowed","EPA/play Def","Def EPA/play allowed"],
    def_sr:  ["def_sr","Def SR","Def Success Rate Allowed","Def Success %","Success Rate Allowed","Def Success Rate"],
    def_rz:  ["def_rz","Def Red-Zone TD% Allowed","Def RZ TD%","Red Zone TD% Allowed","Def Red Zone TD %"],
    def_3out:["def_3out","Def 3-Out %","Def Three-And-Out %","Def 3&Out %","3-Out% Def"],
    def_xpl: ["def_xpl","Def Explosive % Allowed","Def Xpl%","Explosive Allowed %","Def Explosive Rate"],
    def_penalties:["def_penalties","Def Penalties","Def Pen Yds/G","Def Pen Yds/GM","Def Penalty Yds","DEF Penalties per Drive"],
    // Macro / Pace
    off_dvoa:["off_dvoa","Off DVOA","Off DVOA %","Offense DVOA"],
    def_dvoa:["def_dvoa","Def DVOA","Def DVOA %","Defense DVOA"],
    off_drives:["off_drives","Off Drives/G","Off Drives per G","Off. Drives/G"],
    def_drives:["def_drives","Def Drives/G","Def Drives per G","Def. Drives/G"],
    off_plays:["off_plays","Off Plays/G","Off Plays per G","Off Plays/Drive"],
    def_plays:["def_plays","Def Plays/G","Def Plays per G","Def Plays/Drive Allowed"],
    ed_pass:["ed_pass","ED Pass Rate","Early Down Pass%","Early-Down Pass %","ED Pass%","Neutral Early-Down Pass %"],
    no_huddle:["no_huddle","No-Huddle %","No Huddle%","NoHuddle%"],
    Team:["Team","team","TEAM","Name"],
  };

  // --- helpers ---
  const pctToFloat = (val, def) => {
    if (val === null || val === undefined || val === "") return def;
    const s = String(val).trim();
    const hasPct = s.includes("%");
    const num = parseFloat(s.replace(/[% ,]/g,""));
    if (isNaN(num)) return def;
    return hasPct ? num/100 : num;
  };
  const numToFloat = (val, def) => {
    if (val === null || val === undefined || val === "") return def;
    const num = parseFloat(String(val).replace(/[, ]/g,""));
    return isNaN(num) ? def : num;
  };
  const pick = (row, keys, def, asPct=false) => {
    for (const k of keys) {
      if (row.hasOwnProperty(k) && row[k] !== "" && row[k] !== undefined && row[k] !== null) {
        return asPct ? pctToFloat(row[k], def) : numToFloat(row[k], def);
      }
    }
    return def;
  };
  const z = (v, m, s) => (!isFinite(s) || s === 0 || v === undefined || v === null) ? 0 : (v - m) / s;
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const clamp01 = (p) => Math.max(0, Math.min(1, p));

  const parseRow = (row) => {
    const missing = [];
    const name = (pick(row, aliases.Team, "", false) ?? "").toString().trim();
    const tryGet = (field, def, asPct=false) => {
      const v = pick(row, aliases[field] || [field], def, asPct);
      if (v === def) missing.push(field);
      return v;
    };
    const rec = {
      Team: name,
      // Offense
      off_ppd: tryGet("off_ppd", params.lg.PPD, false),
      off_epa: tryGet("off_epa", params.lg.EPA, false),
      off_sr:  tryGet("off_sr",  params.lg.SR,  true),
      off_rz:  tryGet("off_rz",  params.lg.RZ,  true),
      off_3out:tryGet("off_3out",params.lg.ThreeOut, true),
      off_xpl: tryGet("off_xpl", 0.113, true),
      off_penalties: tryGet("off_penalties", 0.44, false),
      off_to_epa: tryGet("off_to_epa", 0, false),
      off_fp: tryGet("off_fp", 25, false),
      // Defense
      def_ppd_allowed: tryGet("def_ppd_allowed", params.lg.PPD, false),
      def_epa_allowed: tryGet("def_epa_allowed", params.lg.EPA, false),
      def_sr:  tryGet("def_sr", params.lg.SR, true),
      def_rz:  tryGet("def_rz", params.lg.RZ, true),
      def_3out:tryGet("def_3out",params.lg.ThreeOut, true),
      def_xpl: tryGet("def_xpl", 0.113, true),
      def_penalties: tryGet("def_penalties", 0.44, false),
      // Macro/Pace
      off_dvoa: tryGet("off_dvoa", 0, false),
      def_dvoa: tryGet("def_dvoa", 0, false),
      off_drives: tryGet("off_drives", 12, false),
      def_drives: tryGet("def_drives", 12, false),
      off_plays: tryGet("off_plays", 62, false),
      def_plays: tryGet("def_plays", 62, false),
      ed_pass: tryGet("ed_pass", 0.5, true),
      no_huddle: tryGet("no_huddle", 0.02, true),
    };
    return { rec, missing };
  };

  // --- nets & pace ---
  const buildNets = (off, def) => {
    const L = params.lg, R = params.resid;
    const z_epa_o = z(off.off_epa, L.EPA, L.EPA_sd);
    const z_sr_o  = z(off.off_sr,  L.SR,  L.SR_sd);
    const z_rz_o  = z(off.off_rz,  L.RZ,  L.RZ_sd);
    const z_3o_o  = z(off.off_3out, L.ThreeOut, L.ThreeOut_sd);
    const z_ppd_o = z(off.off_ppd, L.PPD, L.PPD_sd);

    const z_epa_d = z(def.def_epa_allowed, L.EPA, L.EPA_sd);
    const z_sr_d  = z(def.def_sr,  L.SR,  L.SR_sd);
    const z_rz_d  = z(def.def_rz,  L.RZ,  L.RZ_sd);
    const z_3o_d  = z(def.def_3out, L.ThreeOut, L.ThreeOut_sd);
    const z_ppd_d = z(def.def_ppd_allowed, L.PPD, L.PPD_sd);

    const EPA_net = z_epa_o - z_epa_d;
    const SR_net  = z_sr_o  - z_sr_d;
    const RZ_net  = z_rz_o  - z_rz_d;
    const ThreeOut_eff = (z_3o_d - z_3o_o);
    const PPD_net = z_ppd_o - z_ppd_d;
    const PPD_resid = PPD_net - (R.c1 * EPA_net + R.c2 * SR_net);
    return { EPA_net, SR_net, RZ_net, ThreeOut_eff, PPD_resid };
  };

  const computePace = (home, away, netsHome) => {
    const w = params.weights;
    const offDefAvgHome = (home.off_drives + away.def_drives) / 2;
    const offDefAvgAway = (away.off_drives + home.def_drives) / 2;
    let gameDrives = (offDefAvgHome + offDefAvgAway);
    const nh_boost = ((home.no_huddle || 0) + (away.no_huddle || 0)) / 2 * w.NoHuddle * 0.5;
    const ed_adj   = (((home.ed_pass || 0) - 0.5) + ((away.ed_pass || 0) - 0.5)) / 2 * w.Pace_EDPass;
    gameDrives = gameDrives * (1 + nh_boost + ed_adj);
    gameDrives = Math.max(20, Math.min(30, gameDrives));

    let posShare = 0.5 + 0.15 * (netsHome.SR_net + 0.5 * netsHome.EPA_net);
    posShare = Math.max(0.35, Math.min(0.65, posShare));
    return { gameDrives, posShare };
  };

  const driveProbs = (off, def, nets) => {
    const { a0,a1,a2,a3,a4, b0,b1,b2,b3,b4, phi } = params.logits;
    const opp3o_raw = def.def_3out ?? params.lg.ThreeOut;
    const rz_bad = -(nets.RZ_net);
    let p3O = sigmoid(a0 - a1*nets.EPA_net - a2*nets.SR_net + a3*(opp3o_raw - params.lg.ThreeOut) + a4*rz_bad);
    p3O = clamp01(p3O);

    const pTD_S = clamp01(sigmoid(b0 + b1*nets.EPA_net + b2*nets.SR_net + b3*nets.RZ_net + b4*nets.PPD_resid));
    const pS = 1 - p3O;
    const pTD = pS * pTD_S;
    const pFG = pS * (1 - pTD_S) * Math.max(0, Math.min(1, phi));
    const pEmpty = Math.max(0, 1 - (p3O + pTD + pFG));
    return { p3O, pTD, pFG, pEmpty, pS, pTD_S };
  };

  const simulateOne = (home, away, netsHome, netsAway, gameDrives, posShare, hfa) => {
    const homeDrives = Math.round(gameDrives * posShare);
    const awayDrives = Math.round(gameDrives - homeDrives);

    const baseHome = driveProbs(home, away, netsHome);
    const baseAway = driveProbs(away, home, netsAway);

    // HFA: small TD bump & 3&Out reduction for home
    const hfaTDk = 0.02 * Math.max(0, hfa);
    const hfa3Ok = 0.01 * Math.max(0, hfa);

    const adjHome = {
      p3O: clamp01(baseHome.p3O * (1 - hfa3Ok)),
      pTD: clamp01(baseHome.pTD * (1 + hfaTDk)),
      pFG: baseHome.pFG,
    };
    const sumH = adjHome.p3O + adjHome.pTD + adjHome.pFG;
    const scaleH = sumH > 1 ? 1/sumH : 1;
    adjHome.p3O *= scaleH; adjHome.pTD *= scaleH; adjHome.pFG *= scaleH;

    const adjAway = { ...baseAway };
    const sumA = adjAway.p3O + adjAway.pTD + adjAway.pFG;
    const scaleA = sumA > 1 ? 1/sumA : 1;
    adjAway.p3O *= scaleA; adjAway.pTD *= scaleA; adjAway.pFG *= scaleA;

    const sampleDrive = (p) => {
      const r = Math.random();
      if (r < p.p3O) return 0;
      if (r < p.p3O + p.pTD) return 7;
      if (r < p.p3O + p.pTD + p.pFG) return 3;
      return 0;
    };

    let hs = 0, as = 0;
    for (let i = 0; i < homeDrives; i++) hs += sampleDrive(adjHome);
    for (let i = 0; i < awayDrives; i++) as += sampleDrive(adjAway);

    // Provide debug info
    return {
      hs, as,
      debug: {
        home: { drives: homeDrives, prob: adjHome },
        away: { drives: awayDrives, prob: adjAway },
        base: { home: baseHome, away: baseAway }
      }
    };
  };

  // --- Orchestration ---
  const run = () => {
    if (!homeTeam || !awayTeam) { setUploadStatus("❌ Pick both teams"); return; }
    if (!teamDB[homeTeam] || !teamDB[awayTeam]) { setUploadStatus("❌ Missing team data"); return; }

    const H = teamDB[homeTeam];
    const A = teamDB[awayTeam];

    const netsHome = buildNets(H, A);
    const netsAway = buildNets(A, H);
    const { gameDrives, posShare } = computePace(H, A, netsHome);

    const N = Math.max(1, parseInt(numSim || 10000));
    const totals = new Array(N), spreads = new Array(N);
    let sumH = 0, sumA = 0;
    let lastDebug = null;

    for (let i = 0; i < N; i++) {
      const out = simulateOne(H, A, netsHome, netsAway, gameDrives, posShare, Math.max(0, hfaPoints || 0));
      totals[i] = out.hs + out.as;
      spreads[i] = out.hs - out.as;
      sumH += out.hs; sumA += out.as;
      // capture a sample debug
      if (i === 0) lastDebug = out.debug;
    }

    const mean = (arr) => arr.reduce((a,b)=>a+b,0)/arr.length;
    const median = (arr) => { const s=[...arr].sort((a,b)=>a-b), m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
    const pct = (arr,p) => { const s=[...arr].sort((a,b)=>a-b), i=Math.floor((s.length-1)*p); return s[Math.max(0,Math.min(s.length-1,i))]; };

    const mktTot = marketTotal !== "" ? parseFloat(marketTotal) : null;
    const mktSpr = marketSpread !== "" ? parseFloat(marketSpread) : null;

    const res = {
      home: H.Team, away: A.Team,
      homeMean: sumH / N, awayMean: sumA / N,
      totalMean: mean(totals), totalMedian: median(totals),
      spreadMean: mean(spreads), spreadMedian: median(spreads),
      pOver: mktTot !== null ? totals.filter(x=>x>mktTot).length / N : null,
      pUnder: mktTot !== null ? totals.filter(x=>x<mktTot).length / N : null,
      pHomeCover: mktSpr !== null ? spreads.filter(s=>s + (-mktSpr) > 0).length / N : null,
      pAwayCover: mktSpr !== null ? spreads.filter(s=>s + (-mktSpr) < 0).length / N : null,
      totalDist: { p10: pct(totals,.10), p25: pct(totals,.25), p50: pct(totals,.50), p75: pct(totals,.75), p90: pct(totals,.90) },
      spreadDist:{ p10: pct(spreads,.10), p25: pct(spreads,.25), p50: pct(spreads,.50), p75: pct(spreads,.75), p90: pct(spreads,.90) },
      debug: { gameDrives, posShare, sample: lastDebug },
    };
    setResults(res);
  };

  // --- CSV upload (alias-aware) ---
  const handleCSVUpload = async (file) => {
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      const header = lines[0].split(",").map(h=>h.trim());
      const rows = lines.slice(1).map(line => {
        const cols = line.split(",");
        const o = {}; header.forEach((h,i)=>o[h]=cols[i]); return o;
      });

      const nextDB = {}; const names = []; const health = {};
      rows.forEach(raw => {
        const { rec, missing } = parseRow(raw);
        if (!rec.Team) return;
        names.push(rec.Team);
        nextDB[rec.Team] = rec;
        if (missing.length) health[rec.Team] = missing;
      });

      if (names.length === 0) { setUploadStatus("❌ Error: No teams found. Ensure a 'Team' column."); return; }
      setTeamDB(nextDB);
      setTeamList(names.sort());
      setDataHealth(health);
      const warnTeams = Object.keys(health);
      setUploadStatus(`✅ Loaded ${names.length} teams${warnTeams.length ? ` · ${warnTeams.length} teams have defaulted fields (see Data Health)` : ""}`);
      setResults(null);
    } catch (e) {
      setUploadStatus(`❌ Error: ${e?.message || e}`);
    }
  };

  // --- UI ---
  const TeamSelector = ({ label, value, onChange }) => (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-gray-600">{label}</label>
      <select value={value} onChange={(e)=>onChange(e.target.value)} className="border rounded px-3 py-2">
        <option value="">Select team</option>
        {teamList.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-4 flex items-center gap-2"><BarChart3 size={22}/> Discrete Drive Simulator — Robust (DDSmontecarlo)</h1>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="md:col-span-1 border rounded p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2"><Upload size={18}/> Load Teams</h2>
          <input type="file" accept=".csv" onChange={(e)=>e.target.files && handleCSVUpload(e.target.files[0])} />
          <p className="text-sm text-gray-600 mt-2">CSV must include a <code>Team</code> column. Loader recognizes common header aliases (e.g., <em>Off PPD</em>, <em>Off 3-Out %</em>, <em>Def RZ TD% Allowed</em>).</p>
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
              <input type="number" className="border rounded px-3 py-2 w-full" value={hfaPoints} onChange={(e)=>setHfaPoints(parseFloat(e.target.value || 0))} />
            </div>
            <div>
              <label className="text-sm text-gray-600">Simulations</label>
              <input type="number" className="border rounded px-3 py-2 w-full" value={numSim} onChange={(e)=>setNumSim(parseInt(e.target.value || 10000))} />
            </div>
            <div>
              <label className="text-sm text-gray-600">Market Total</label>
              <input type="text" className="border rounded px-3 py-2 w-full" value={marketTotal} onChange={(e)=>setMarketTotal(e.target.value)} placeholder="e.g., 44.5" />
            </div>
            <div>
              <label className="text-sm text-gray-600">Market Spread (home -)</label>
              <input type="text" className="border rounded px-3 py-2 w-full" value={marketSpread} onChange={(e)=>setMarketSpread(e.target.value)} placeholder="e.g., -3" />
            </div>
          </div>

          <button onClick={()=>{ setIsSim(true); setTimeout(()=>{ run(); setIsSim(false); }, 0); }} disabled={!homeTeam || !awayTeam || isSim} className="mt-4 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
            <Play size={16}/> {isSim ? "Simulating..." : "Run DDS"}
          </button>

          <div className="mt-3 flex items-center gap-2 text-sm">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={showDebug} onChange={(e)=>setShowDebug(e.target.checked)} />
              <Bug size={16}/> Show debug panel
            </label>
          </div>
        </div>
      </div>

      {/* Results */}
      {results && (
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><TrendingUp size={18}/> Results</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <h3 className="font-semibold">Means</h3>
              <ul className="text-sm mt-2">
                <li><strong>{results.home}</strong> mean: {results.homeMean.toFixed(2)}</li>
                <li><strong>{results.away}</strong> mean: {results.awayMean.toFixed(2)}</li>
                <li>Total mean: {results.totalMean.toFixed(2)} (median {results.totalMedian.toFixed(2)})</li>
                <li>Home spread mean: {results.spreadMean.toFixed(2)} (median {results.spreadMedian.toFixed(2)})</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold">Market Probabilities</h3>
              <ul className="text-sm mt-2">
                {results.pOver !== null && (<li>Over {marketTotal}: {(results.pOver*100).toFixed(1)}%</li>)}
                {results.pUnder !== null && (<li>Under {marketTotal}: {(results.pUnder*100).toFixed(1)}%</li>)}
                {results.pHomeCover !== null && (<li>Home cover vs {marketSpread}: {(results.pHomeCover*100).toFixed(1)}%</li>)}
                {results.pAwayCover !== null && (<li>Away cover vs {marketSpread}: {(results.pAwayCover*100).toFixed(1)}%</li>)}
              </ul>
            </div>
          </div>

          {showDebug && (
            <div className="mt-4 border-t pt-3 text-sm">
              <h3 className="font-semibold mb-2">Debug</h3>
              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <div><strong>gameDrives</strong>: {results.debug.gameDrives.toFixed(2)}</div>
                  <div><strong>posShare</strong>: {(results.debug.posShare*100).toFixed(1)}%</div>
                </div>
                <div>
                  <h4 className="font-semibold mt-2">Home (sample)</h4>
                  <div>drives: {results.debug.sample.home.drives}</div>
                  <div>p3O: {(results.debug.sample.home.prob.p3O*100).toFixed(1)}%</div>
                  <div>pTD: {(results.debug.sample.home.prob.pTD*100).toFixed(1)}%</div>
                  <div>pFG: {(results.debug.sample.home.prob.pFG*100).toFixed(1)}%</div>
                </div>
                <div>
                  <h4 className="font-semibold mt-2">Away (sample)</h4>
                  <div>drives: {results.debug.sample.away.drives}</div>
                  <div>p3O: {(results.debug.sample.away.prob.p3O*100).toFixed(1)}%</div>
                  <div>pTD: {(results.debug.sample.away.prob.pTD*100).toFixed(1)}%</div>
                  <div>pFG: {(results.debug.sample.away.prob.pFG*100).toFixed(1)}%</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Data Health */}
      {Object.keys(dataHealth).length > 0 && (
        <div className="mt-6 border rounded p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2 text-amber-700"><AlertTriangle size={18}/> Data Health</h2>
          <p className="text-sm text-gray-700 mb-2">These teams were missing some fields; defaults were used. Heavily defaulted matchups tend to converge.</p>
          <ul className="text-sm list-disc pl-5 space-y-1 max-h-56 overflow-auto">
            {Object.entries(dataHealth).map(([team, fields]) => (
              <li key={team}><strong>{team}:</strong> {fields.join(", ")}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 border rounded p-4">
        <h2 className="font-semibold mb-2 flex items-center gap-2"><Settings size={18}/> Notes</h2>
        <ul className="text-sm list-disc pl-5 space-y-1">
          <li>Pure discrete engine — no Gaussian path.</li>
          <li>Per-drive outcomes sampled as 3&Out, TD, FG, or Empty (after sustain).</li>
          <li>Shared game drives with possession-share tilt from EPA/SR nets.</li>
          <li>HFA applied as micro-tilts (TD↑, 3&Out↓) for the home side.</li>
          <li>Week-8 calibrated defaults: a0=-1.31, b0=-0.76, φ=0.32.</li>
        </ul>
      </div>
    </div>
  );
};

export default DDSmontecarlo;
