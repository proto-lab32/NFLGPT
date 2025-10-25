import React, { useState } from "react";
import { Upload, Play, BarChart3, TrendingUp, Settings } from "lucide-react";

/**
 * DDSmontecarlo — Discrete Drive Simulator (independent of Gaussian)
 * 
 * What it does:
 * - Builds NET features (off − def) for EPA, SR, PPD_resid, RZ, 3&Out
 * - Uses shared game drives with possession-share tilt
 * - Per drive: sample 3&Out vs Sustain, then TD vs FG vs Empty
 * - Scores accumulate in {0,3,7} to preserve NFL key-number mass naturally
 * - Calibrated with sensible league-wide defaults; adjust a0/b0/phi as desired
 */

const DDSmontecarlo = () => {
  // League baselines (tweak if you have better priors)
  const params = {
    lg: {
      PPD: 2.02,
      PPD_sd: 0.40,
      EPA: 0.022,
      EPA_sd: 0.127,
      SR: 0.43,
      SR_sd: 0.05,
      RZ: 0.56,
      RZ_sd: 0.12,
      ThreeOut: 0.24,
      ThreeOut_sd: 0.05,
      Drives: 24,
    },
    // Coefficients for logits (a0/b0/tuning). Defaults target p3O≈0.23, pTD≈0.23, pFG≈0.18 league-wide.
    logits: {
      // 3&Out Bernoulli: p3O = σ(a0 − a1·EPA_net − a2·SR_net + a3·Opp3O + a4·RZ_bad)
      a0: -1.31, a1: 1.10, a2: 0.85, a3: 0.60, a4: 0.25,
      // TD given sustain: pTD|S = σ(b0 + b1·EPA_net + b2·SR_net + b3·RZ_net + b4·PPD_resid)
      b0: -0.76, b1: 0.95, b2: 0.55, b3: 0.35, b4: 0.40,
      // FG bias factor (on remaining mass after TD) — 0.45 → about 45% of non‑TD sustains become FGs
      phi: 0.32,
    },
    // Weights for building the mean "strength" (only used for pace/tilt; NOT for Gaussian)
    weights: {
      EPA: 0.40,
      SR: 0.25,
      PPD_resid: 0.20,
      RZ: 0.10,
      ThreeOut_eff: 0.05,
      DVOA_off: 0.12,
      DVOA_def: 0.12,
      Pace_EDPass: 0.10,
      NoHuddle: 0.20,
    },
    // Residualization coefficients for PPD ~ EPA + SR (from prior discussion)
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

  // --- Helpers ---
  const parseNum = (val, def) => {
    if (val === null || val === undefined || val === "") return def;
    const str = String(val);
    const hasPercent = str.includes("%");
    const n = typeof val === "number" ? val : parseFloat(str.replace(/%/g, ""));
    if (isNaN(n)) return def;
    return hasPercent ? n / 100 : n;
  };
  const parsePct = (val, def) => parseNum(val, def);
  const z = (v, m, s) => (!isFinite(s) || s === 0 || v === undefined || v === null) ? 0 : (v - m) / s;
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const clamp01 = (p) => Math.max(0, Math.min(1, p));

  const projectTeamFromDB = (name) => {
    const r = teamDB[name] || {};
    return {
      name,
      // Offense
      off_ppd: parseNum(r.off_ppd, params.lg.PPD),
      off_epa: parseNum(r.off_epa, params.lg.EPA),
      off_sr:  parsePct(r.off_sr,  params.lg.SR),
      off_rz:  parsePct(r.off_rz,  params.lg.RZ),
      off_3out: parsePct(r.off_3out, params.lg.ThreeOut),
      off_to_epa: parseNum(r.off_to_epa, 0),
      off_fp: parseNum(r.off_fp, 25),
      // Defense (allowed/forced)
      def_ppd_allowed: parseNum(r.def_ppd_allowed, params.lg.PPD),
      def_epa_allowed: parseNum(r.def_epa_allowed, params.lg.EPA),
      def_sr: parsePct(r.def_sr, params.lg.SR),
      def_rz: parsePct(r.def_rz, params.lg.RZ),
      def_3out: parsePct(r.def_3out, params.lg.ThreeOut),
      // Macro
      off_dvoa: parseNum(r.off_dvoa, 0),
      def_dvoa: parseNum(r.def_dvoa, 0),
      // Pace
      off_drives: parseNum(r.off_drives, 12),
      def_drives: parseNum(r.def_drives, 12),
      ed_pass: parsePct(r.ed_pass, 0.5),
      no_huddle: parsePct(r.no_huddle, 0.02),
    };
  };

  const handleCSVUpload = async (file) => {
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      const header = lines[0].split(",").map(h => h.trim());
      const rows = lines.slice(1).map(line => {
        const cols = line.split(",");
        const obj = {};
        header.forEach((h,i) => obj[h] = cols[i]);
        return obj;
      });
      const next = {}; const names = [];
      rows.forEach(row => {
        const n = String(row["Team"] || row["team"] || "").trim();
        if (!n) return;
        names.push(n);
        next[n] = {...row};
      });
      if (names.length === 0) {
        setUploadStatus("❌ Error: CSV needs a 'Team' column.");
        return;
      }
      setTeamDB(next);
      setTeamList(names.sort());
      setUploadStatus(`✅ Loaded ${names.length} teams`);
      setResults(null);
    } catch (e) {
      setUploadStatus(`❌ Error: ${e?.message || e}`);
    }
  };

  // Build matchup nets (z-space) + residualized PPD
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
    const ThreeOut_eff = (z_3o_d - z_3o_o); // higher = worse for offense
    const PPD_net = z_ppd_o - z_ppd_d;
    const PPD_resid = PPD_net - (R.c1 * EPA_net + R.c2 * SR_net);

    return { EPA_net, SR_net, RZ_net, ThreeOut_eff, PPD_resid };
  };

  // Shared pace & possession tilt
  const computePace = (home, away, netsHome) => {
    const w = params.weights;
    const baseDrives =
      (((home.off_drives + away.def_drives) / 2) + ((away.off_drives + home.def_drives) / 2)) / 2;
    const nh_boost = ((home.no_huddle || 0) + (away.no_huddle || 0)) / 2 * w.NoHuddle * 0.5;
    const ed_adj   = (((home.ed_pass || 0) - 0.5) + ((away.ed_pass || 0) - 0.5)) / 2 * w.Pace_EDPass;
    let gameDrives = baseDrives * (1 + nh_boost + ed_adj);
    gameDrives = Math.max(18, Math.min(28, gameDrives));

    let posShare = 0.5 + 0.15 * (netsHome.SR_net + 0.5 * netsHome.EPA_net);
    posShare = Math.max(0.35, Math.min(0.65, posShare));
    return { gameDrives, posShare };
  };

  // Per-team probabilities (p3O, pTD|S, pFG|S) from nets + priors
  const driveProbs = (off, def, nets) => {
    const { a0,a1,a2,a3,a4, b0,b1,b2,b3,b4, phi } = params.logits;
    // Opp3O as raw decimal (not z) for intuitive effect
    const opp3o_raw = def.def_3out ?? params.lg.ThreeOut;
    const rz_bad = -(nets.RZ_net); // worse RZ (neg net) increases 3&out slightly

    let p3O = sigmoid(a0 - a1*nets.EPA_net - a2*nets.SR_net + a3*(opp3o_raw - params.lg.ThreeOut) + a4*rz_bad);
    p3O = clamp01(p3O);

    const pTD_givenSustain = clamp01(sigmoid(b0 + b1*nets.EPA_net + b2*nets.SR_net + b3*nets.RZ_net + b4*nets.PPD_resid));
    const pSustain = 1 - p3O;
    const pTD = pSustain * pTD_givenSustain;
    const pFG = pSustain * (1 - pTD_givenSustain) * Math.max(0, Math.min(1, phi));
    const pEmpty = Math.max(0, 1 - (p3O + pTD + pFG)); // residual

    return { p3O, pTD, pFG, pEmpty };
  };

  // Sim a single game (discrete)
  const simulateOne = (home, away, netsHome, netsAway, gameDrives, posShare, hfa) => {
    // Allocate drives; HFA → add a small finishing bump to home via TD|S
    const homeDrives = Math.round(gameDrives * posShare);
    const awayDrives = Math.round(gameDrives - homeDrives);

    const baseHome = driveProbs(home, away, netsHome);
    const baseAway = driveProbs(away, home, netsAway);

    // Apply HFA as a small TD tilt (and tiny 3&out reduction) for home
    const hfaTDk = 0.02 * Math.max(0, hfa); // 2% per point of HFA (tunable)
    const hfa3Ok = 0.01 * Math.max(0, hfa);

    const adjHome = {
      p3O: clamp01(baseHome.p3O * (1 - hfa3Ok)),
      pTD: clamp01(baseHome.pTD * (1 + hfaTDk)),
      pFG: baseHome.pFG,
    };
    // Renormalize home probabilities (keep Empty as residual)
    const sumH = adjHome.p3O + adjHome.pTD + adjHome.pFG;
    const scaleH = sumH > 1 ? 1/sumH : 1;
    adjHome.p3O *= scaleH; adjHome.pTD *= scaleH; adjHome.pFG *= scaleH;

    const adjAway = { ...baseAway }; // no away HFA bonus
    const sumA = adjAway.p3O + adjAway.pTD + adjAway.pFG;
    const scaleA = sumA > 1 ? 1/sumA : 1;
    adjAway.p3O *= scaleA; adjAway.pTD *= scaleA; adjAway.pFG *= scaleA;

    const sampleDrive = (p) => {
      const r = Math.random();
      if (r < p.p3O) return 0;
      if (r < p.p3O + p.pTD) return 7;
      if (r < p.p3O + p.pTD + p.pFG) return 3;
      return 0; // empty after sustain
    };

    let hs = 0, as = 0;
    for (let i = 0; i < homeDrives; i++) hs += sampleDrive(adjHome);
    for (let i = 0; i < awayDrives; i++) as += sampleDrive(adjAway);
    return { hs, as };
  };

  // --- Simulation orchestration ---
  const run = () => {
    if (!homeTeam || !awayTeam) { setUploadStatus("❌ Pick both teams"); return; }
    if (!teamDB[homeTeam] || !teamDB[awayTeam]) { setUploadStatus("❌ Missing team data"); return; }

    const H = projectTeamFromDB(homeTeam);
    const A = projectTeamFromDB(awayTeam);

    const netsHome = buildNets(H, A);
    const netsAway = buildNets(A, H);
    const { gameDrives, posShare } = computePace(H, A, netsHome);

    const N = Math.max(1, parseInt(numSim || 10000));
    const totals = new Array(N);
    const spreads = new Array(N);
    let sumH = 0, sumA = 0;

    for (let i = 0; i < N; i++) {
      const { hs, as } = simulateOne(H, A, netsHome, netsAway, gameDrives, posShare, Math.max(0, hfaPoints || 0));
      totals[i] = hs + as;
      spreads[i] = hs - as;
      sumH += hs; sumA += as;
    }

    const mean = (arr) => arr.reduce((a,b)=>a+b,0)/arr.length;
    const median = (arr) => {
      const s = [...arr].sort((a,b)=>a-b);
      const m = Math.floor(s.length/2);
      return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
    };
    const pct = (arr,p) => {
      const s = [...arr].sort((a,b)=>a-b);
      const i = Math.floor((s.length-1)*p);
      return s[Math.max(0, Math.min(s.length-1, i))];
    };

    const mktTot = marketTotal !== "" ? parseFloat(marketTotal) : null;
    const mktSpr = marketSpread !== "" ? parseFloat(marketSpread) : null;

    const res = {
      home: H.name, away: A.name,
      homeMean: sumH / N, awayMean: sumA / N,
      totalMean: mean(totals), totalMedian: median(totals),
      spreadMean: mean(spreads), spreadMedian: median(spreads),
      pOver: mktTot !== null ? totals.filter(x=>x>mktTot).length / N : null,
      pUnder: mktTot !== null ? totals.filter(x=>x<mktTot).length / N : null,
      pHomeCover: mktSpr !== null ? spreads.filter(s=>s + (-mktSpr) > 0).length / N : null, // home - spread > 0
      pAwayCover: mktSpr !== null ? spreads.filter(s=>s + (-mktSpr) < 0).length / N : null,
      totalDist: { p10: pct(totals,.10), p25: pct(totals,.25), p50: pct(totals,.50), p75: pct(totals,.75), p90: pct(totals,.90) },
      spreadDist:{ p10: pct(spreads,.10),p25: pct(spreads,.25),p50: pct(spreads,.50),p75: pct(spreads,.75),p90: pct(spreads,.90) },
    };
    setResults(res);
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
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-4 flex items-center gap-2"><BarChart3 size={22}/> Discrete Drive Simulator (DDSmontecarlo)</h1>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="md:col-span-1 border rounded p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2"><Upload size={18}/> Load Teams</h2>
          <input type="file" accept=".csv" onChange={(e)=>e.target.files && handleCSVUpload(e.target.files[0])} />
          <p className="text-sm text-gray-600 mt-2">CSV must include a <code>Team</code> column and standard fields (off_epa, off_sr, def_sr, off_rz, def_rz, off_3out, def_3out, off_ppd, def_ppd_allowed, off_drives, def_drives, ed_pass, no_huddle, off_dvoa, def_dvoa).</p>
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
        </div>
      </div>

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

          <div className="grid md:grid-cols-2 gap-4 mt-4">
            <div>
              <h4 className="font-semibold">Total Distribution (p10/p25/p50/p75/p90)</h4>
              <div className="text-sm mt-2">
                {Object.values(results.totalDist).map((v,i)=>(<span key={i} className="inline-block mr-3">{v}</span>))}
              </div>
            </div>
            <div>
              <h4 className="font-semibold">Spread Distribution (p10/p25/p50/p75/p90)</h4>
              <div className="text-sm mt-2">
                {Object.values(results.spreadDist).map((v,i)=>(<span key={i} className="inline-block mr-3">{v}</span>))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 border rounded p-4">
        <h2 className="font-semibold mb-2 flex items-center gap-2"><Settings size={18}/> Notes</h2>
        <ul className="text-sm list-disc pl-5 space-y-1">
          <li>Pure discrete engine — no Gaussian path included.</li>
          <li>Per-drive outcomes sampled as 3&Out, TD, FG, or Empty (after sustain).</li>
          <li>Shared game drives with possession-share tilt (EPA/SR).</li>
          <li>HFA applied as TD and 3&Out micro-tilts on the home side.</li>
          <li>Defaults target league p3O≈22–24%, pTD≈22–24%, pFG≈17–19% — tune params.logits.</li>
        </ul>
      </div>
    </div>
  );
};

export default DDSmontecarlo;
