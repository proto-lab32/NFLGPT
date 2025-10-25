import React, { useState } from "react";
import { Upload, Play, BarChart3, TrendingUp, Settings, Bug, AlertTriangle } from "lucide-react";

/**
 * NFL Monte Carlo Game Simulator (Gaussian) — v3 (Robust CSV Adapter)
 * - FIXED drives math (SUM off/def averages; clamp [20,30])
 * - Robust CSV header mapping (common aliases -> internal field names)
 * - Data Health panel: shows which fields defaulted for each team
 * - Debug panel: gameDrives, posShare, per-team drives & PPD
 */

const MonteCarloSimulator = () => {

  // --- Helper: find team column robustly ---
  const findTeamKey = (header) => {
    const candidates = ["Team","team","TEAM","Name","name"];
    const lc = new Set(header.map(h => (h||"").toLowerCase().trim()));
    for (const c of candidates) {
      if (lc.has(c.toLowerCase())) return header.find(h => h.toLowerCase().trim() === c.toLowerCase());
    }
    // fuzzy contains 'team' or 'name'
    for (const h of header) {
      const t = (h||"").toLowerCase().trim();
      if (t.includes("team") || t === "name") return h;
    }
    return null;
  };


  // --- Robust CSV parsing (RFC4180-ish) ---
  // - Handles quotes, embedded commas, CRLF, optional BOM
  // - Auto-detects delimiter: comma or tab
  const parseCSV = (text) => {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Normalize line endings
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Detect delimiter by header
    const firstLine = text.split('\n')[0] || "";
    const delim = (firstLine.match(/\t/) && !firstLine.match(/,/)) ? '\t' : ',';

    const rows = [];
    let i = 0, field = '', row = [], inQuotes = false;
    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            field += '"'; i += 2; continue; // escaped quote
          } else {
            inQuotes = false; i++; continue;
          }
        } else {
          field += ch; i++; continue;
        }
      } else {
        if (ch === '"') { inQuotes = true; i++; continue; }
        if (ch === delim) { row.push(field.trim()); field = ''; i++; continue; }
        if (ch === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; i++; continue; }
        field += ch; i++; continue;
      }
    }
    // push last field
    row.push(field.trim()); rows.push(row);

    // Remove any trailing empty rows
    while (rows.length && rows[rows.length-1].every(c => c === "")) rows.pop();

    if (!rows.length) return { header: [], records: [] };

    // Build header map
    const header = rows[0].map(h => (h || "").trim());
    const records = rows.slice(1).map(cols => {
      const o = {};
      for (let j = 0; j < header.length; j++) o[header[j]] = (cols[j] ?? "").trim();
      return o;
    });
    return { header, records };
  };

  const params = {
    lg: {
      PPD: 2.06, PPD_sd: 0.42,
      EPA: 0.022, EPA_sd: 0.127,
      SR: 0.43, SR_sd: 0.05,
      Xpl: 0.113, Xpl_sd: 0.033,
      RZ: 0.56, RZ_sd: 0.12,
      ThreeOut: 0.24, ThreeOut_sd: 0.05,
      Pen: 0.44, Pen_sd: 0.12,
      Drives: 24, Plays: 62,
    },
    weights: {
      PPD: 0.20, EPA: 0.40, SR: 0.20, Xpl: 0.10, RZ: 0.10,
      ThreeOut_eff: 0.25, Pen: 0.05, Pen_def: 0.05,
      DVOA_off: 0.15, DVOA_def: 0.15, TO_EPA: 0.10, FP: 0.10,
      Pace_EDPass: 0.10, NoHuddle: 0.20,
    },
    EV_SD_Total: 12.7,
  };

  const PPD_RESID_C1 = 0.56;
  const PPD_RESID_C2 = 0.21;

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
  const [dataHealth, setDataHealth] = useState({}); // { team: [missingField, ...] }

  // --- CSV alias map ---
  const aliases = {
    // Offense
    off_ppd: ["off_ppd","Off PPD","Off. PPD","PPD Offense","Off Points/Drive","Off Pts/Drive"],
    off_epa: ["off_epa","Off EPA","Off EPA/Play","Off EPA per Play","EPA/play Offense","EPA per Play Off"],
    off_sr:  ["off_sr","Off SR","Off Success Rate","Off Success %","Off Success%","Off SR%","Success Rate Off"],
    off_xpl: ["off_xpl","Off Explosive %","Off Xpl%","Explosive Rate Off","% Explosive Plays Off"],
    off_rz:  ["off_rz","Off Red-Zone TD%","Off RZ TD%","Off RZ%","Red Zone TD% Off"],
    off_3out:["off_3out","Off 3-Out %","Off Three-And-Out %","Off 3&Out %","3 and out % Off","3-Out% Off"],
    off_penalties:["off_penalties","Off Penalties","Off Pen Yds/G","Off Pen Yds/GM","Off Penalty Yds"],
    off_to_epa:["off_to_epa","Off TO EPA","Turnover EPA Off","TO EPA (Off)"],
    off_fp:  ["off_fp","Off FP","Off Field Position","Avg Start Ydline Off","Starting FP Off"],
    // Defense
    def_ppd_allowed:["def_ppd_allowed","Def PPD Allowed","Def PPD","PPD Defense Allowed","Points/Drive Allowed"],
    def_epa_allowed:["def_epa_allowed","Def EPA","Def EPA/Play Allowed","EPA per Play Allowed","EPA/play Def"],
    def_sr:  ["def_sr","Def SR","Def Success Rate Allowed","Def Success %","Success Rate Allowed"],
    def_xpl: ["def_xpl","Def Explosive % Allowed","Def Xpl%","Explosive Allowed %"],
    def_rz:  ["def_rz","Def Red-Zone TD% Allowed","Def RZ TD%","Red Zone TD% Allowed"],
    def_3out:["def_3out","Def 3-Out %","Def Three-And-Out %","Def 3&Out %","3-Out% Def"],
    def_penalties:["def_penalties","Def Penalties","Def Pen Yds/G","Def Pen Yds/GM","Def Penalty Yds"],
    // Macro / Pace
    off_dvoa:["off_dvoa","Off DVOA","Off DVOA %","Offense DVOA"],
    def_dvoa:["def_dvoa","Def DVOA","Def DVOA %","Defense DVOA"],
    off_drives:["off_drives","Off Drives/G","Off Drives per G","Off. Drives/G"],
    def_drives:["def_drives","Def Drives/G","Def Drives per G","Def. Drives/G"],
    off_plays:["off_plays","Off Plays/G","Off Plays per G"],
    def_plays:["def_plays","Def Plays/G","Def Plays per G"],
    ed_pass:["ed_pass","ED Pass Rate","Early Down Pass%","Early-Down Pass %","ED Pass%"],
    no_huddle:["no_huddle","No-Huddle %","No Huddle%","NoHuddle%"],
    Team:["Team","team","TEAM","Name"],
  };

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

  const parseRow = (row) => {
    const missing = [];
    const name = (pick(row, aliases.Team, "", false) ?? "").toString().trim();
    const tryGet = (field, def, asPct=false) => {
      const v = pick(row, aliases[field] || [field], def, asPct);
      if (v === def) missing.push(field);
      return v;
    };

    // Build normalized record with defaults where missing
    const rec = {
      Team: name,
      off_ppd: tryGet("off_ppd", params.lg.PPD, false),
      off_epa: tryGet("off_epa", params.lg.EPA, false),
      off_sr: tryGet("off_sr", params.lg.SR, true),
      off_xpl: tryGet("off_xpl", params.lg.Xpl, true),
      off_rz: tryGet("off_rz", params.lg.RZ, true),
      off_3out: tryGet("off_3out", params.lg.ThreeOut, true),
      off_penalties: tryGet("off_penalties", params.lg.Pen, false),
      off_to_epa: tryGet("off_to_epa", 0, false),
      off_fp: tryGet("off_fp", 25, false),

      def_ppd_allowed: tryGet("def_ppd_allowed", params.lg.PPD, false),
      def_epa_allowed: tryGet("def_epa_allowed", params.lg.EPA, false),
      def_sr: tryGet("def_sr", params.lg.SR, true),
      def_xpl: tryGet("def_xpl", params.lg.Xpl, true),
      def_rz: tryGet("def_rz", params.lg.RZ, true),
      def_3out: tryGet("def_3out", params.lg.ThreeOut, true),
      def_penalties: tryGet("def_penalties", params.lg.Pen, false),

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

  const z = (v, m, s) => (!isFinite(s) || s === 0 || v === undefined || v === null) ? 0 : (v - m) / s;

  const computeNetFeatures = (team, oppDefense) => {
    const L = params.lg;
    const z_ppd_o = z(team.off_ppd, L.PPD, L.PPD_sd);
    const z_epa_o = z(team.off_epa, L.EPA, L.EPA_sd);
    const z_sr_o  = z(team.off_sr,  L.SR,  L.SR_sd);
    const z_xpl_o = z(team.off_xpl, L.Xpl, L.Xpl_sd);
    const z_rz_o  = z(team.off_rz,  L.RZ,  L.RZ_sd);
    const z_out_o = z(team.off_3out,L.ThreeOut,L.ThreeOut_sd);
    const z_pen_o = z(team.off_penalties, L.Pen, L.Pen_sd);

    const z_ppd_d = z(oppDefense.def_ppd_allowed, L.PPD, L.PPD_sd);
    const z_epa_d = z(oppDefense.def_epa_allowed, L.EPA, L.EPA_sd);
    const z_sr_d  = z(oppDefense.def_sr,  L.SR,  L.SR_sd);
    const z_xpl_d = z(oppDefense.def_xpl, L.Xpl, L.Xpl_sd);
    const z_rz_d  = z(oppDefense.def_rz,  L.RZ,  L.RZ_sd);
    const z_out_d = z(oppDefense.def_3out, L.ThreeOut, L.ThreeOut_sd);
    const z_pen_d = z(oppDefense.def_penalties, L.Pen, L.Pen_sd);

    const epa_net = z_epa_o - z_epa_d;
    const sr_net  = z_sr_o  - z_sr_d;
    const ppd_net = z_ppd_o - z_ppd_d;
    const xpl_net = z_xpl_o - z_xpl_d;
    const rz_net  = z_rz_o  - z_rz_d;
    const out_net = (z_out_d - z_out_o);
    const ppd_resid = ppd_net - (PPD_RESID_C1 * epa_net + PPD_RESID_C2 * sr_net);
    return { epa_net, sr_net, ppd_resid, xpl_net, rz_net, out_net, z_pen_o, z_pen_d };
  };

  const computeGamePace = (homeTeam, awayTeam, awayDef, homeDef, netsHome) => {
    const w = params.weights;
    const offDefAvgHome = (homeTeam.off_drives + awayDef.def_drives) / 2;
    const offDefAvgAway = (awayTeam.off_drives + homeDef.def_drives) / 2;
    let gameDrives = (offDefAvgHome + offDefAvgAway);
    const nh_boost = ((homeTeam.no_huddle || 0) + (awayTeam.no_huddle || 0)) / 2 * w.NoHuddle * 0.5;
    const ed_adj   = (((homeTeam.ed_pass || 0) - 0.5) + ((awayTeam.ed_pass || 0) - 0.5)) / 2 * w.Pace_EDPass;
    gameDrives = gameDrives * (1 + nh_boost + ed_adj);
    gameDrives = Math.min(30, Math.max(20, gameDrives));
    let posShare = 0.5 + 0.15 * (netsHome.sr_net + 0.5 * netsHome.epa_net);
    posShare = Math.max(0.35, Math.min(0.65, posShare));
    return { gameDrives, posShare };
  };

  const estimateScore = (team, oppDefense, isHome, hfa, gameDrives, posShare, nets) => {
    const L = params.lg, W = params.weights;
    const { epa_net, sr_net, ppd_resid, xpl_net, rz_net, out_net, z_pen_o, z_pen_d } = nets;
    const eff_net = ppd_resid*W.PPD + epa_net*W.EPA + sr_net*W.SR + xpl_net*W.Xpl + rz_net*W.RZ + out_net*W.ThreeOut_eff;
    const dvoa_adj = (team.off_dvoa / 100) * W.DVOA_off - (oppDefense.def_dvoa / 100) * W.DVOA_def;
    const to_adj = (team.off_to_epa * W.TO_EPA) / L.Drives;
    const fp_adj = ((team.off_fp - 25) / 10) * W.FP;
    const pen_adj = (-z_pen_o * W.Pen + z_pen_d * W.Pen_def);
    const net_adv = eff_net + dvoa_adj + to_adj + fp_adj + pen_adj;
    const drives = isHome ? gameDrives * posShare : gameDrives * (1 - posShare);
    let ppd = L.PPD + net_adv * L.PPD_sd;
    if (isHome && hfa) ppd += (hfa / Math.max(1, drives));
    ppd = Math.max(0.4, Math.min(4.0, ppd));
    const pts = ppd * drives;

    // variance model
    const threeOut_net = (oppDefense.def_3out - team.off_3out);
    const sr_net2 = (team.off_sr - oppDefense.def_sr);
    const baseVar = Math.pow(params.EV_SD_Total, 2) / 2;
    const volUp = 1 + 0.8 * Math.max(0, threeOut_net);
    const volDown = 1 - 0.6 * Math.max(0, sr_net2);
    const std_dev = Math.sqrt(baseVar * volUp * Math.max(0.6, volDown));

    return { points: Math.max(0, pts), std_dev, drives, ppd };
  };

  const runSimulation = () => {
    if (!homeTeam || !awayTeam) { setUploadStatus("❌ Pick both teams"); return; }
    if (!teamDB[homeTeam] || !teamDB[awayTeam]) { setUploadStatus("❌ Missing team data"); return; }

    const homeData = teamDB[homeTeam];
    const awayData = teamDB[awayTeam];
    const netsHome = computeNetFeatures(homeData, awayData);
    const netsAway = computeNetFeatures(awayData, homeData);
    const { gameDrives, posShare } = computeGamePace(homeData, awayData, awayData, homeData, netsHome);

    const homeProjection = estimateScore(homeData, awayData, true, hfaAdjustment, gameDrives, posShare, netsHome);
    const awayProjection = estimateScore(awayData, homeData, false, hfaAdjustment, gameDrives, posShare, netsAway);

    const homeScores = [], awayScores = [], totals = [], spreads = [];
    for (let i = 0; i < numSimulations; i++) {
      const u1 = Math.random(), u2 = Math.random();
      const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const homeScore = Math.max(0, Math.round(homeProjection.points + z1 * homeProjection.std_dev));

      const u3 = Math.random(), u4 = Math.random();
      const z2 = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u4);
      const awayScore = Math.max(0, Math.round(awayProjection.points + z2 * awayProjection.std_dev));

      homeScores.push(homeScore); awayScores.push(awayScore);
      totals.push(homeScore + awayScore); spreads.push(homeScore - awayScore);
    }

    const mean = (arr) => arr.reduce((a,b)=>a+b,0)/arr.length;
    const median = (arr) => { const s=[...arr].sort((a,b)=>a-b), m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
    const pct = (arr,p) => { const s=[...arr].sort((a,b)=>a-b), i=Math.floor((s.length-1)*p); return s[Math.max(0,Math.min(s.length-1,i))]; };

    const mktTot = marketTotal !== "" ? parseFloat(marketTotal) : null;
    const mktSpr = marketSpread !== "" ? parseFloat(marketSpread) : null;

    setSimulationResults({
      home: homeTeam, away: awayTeam,
      homeMean: mean(homeScores), awayMean: mean(awayScores),
      totalMean: mean(totals), totalMedian: median(totals),
      spreadMean: mean(spreads), spreadMedian: median(spreads),
      pOver: mktTot!==null ? totals.filter(x=>x>mktTot).length/numSimulations : null,
      pUnder: mktTot!==null ? totals.filter(x=>x<mktTot).length/numSimulations : null,
      pHomeCover: mktSpr!==null ? spreads.filter(s=>s+(-mktSpr)>0).length/numSimulations : null,
      pAwayCover: mktSpr!==null ? spreads.filter(s=>s+(-mktSpr)<0).length/numSimulations : null,
      totalDist: { p10:pct(totals,.10), p25:pct(totals,.25), p50:pct(totals,.50), p75:pct(totals,.75), p90:pct(totals,.90) },
      spreadDist:{ p10:pct(spreads,.10),p25:pct(spreads,.25),p50:pct(spreads,.50),p75:pct(spreads,.75),p90:pct(spreads,.90) },
      debug: {
        gameDrives, posShare,
        home: { drives: homeProjection.drives, ppd: homeProjection.ppd },
        away: { drives: awayProjection.drives, ppd: awayProjection.ppd },
      }
    });
  };

  const handleCSVUpload = async (file) => {
    try {
      const text = await file.text();
      const { header, records } = parseCSV(text);
      const teamKey = findTeamKey(header);
      if (!teamKey) { setUploadStatus("❌ Error: Could not find a Team column."); return; }
      const rows = records;

      const nextDB = {}; const names = []; const health = {};
      rows.forEach(raw => {
        const teamName = (raw[teamKey] || "").trim();
        if (!teamName) return;
        const { rec, missing } = parseRow({ ...raw, Team: teamName });
        names.push(teamName);
        nextDB[teamName] = rec;
        if (missing.length) health[teamName] = missing;
      });

      if (names.length === 0) { setUploadStatus("❌ Error: No teams found. Ensure a 'Team' column."); return; }
      setTeamDB(nextDB);
      setTeamList(names.sort());
      setDataHealth(health);
      const warnTeams = Object.keys(health);
      setUploadStatus(`✅ Loaded ${names.length} teams${warnTeams.length ? ` · ${warnTeams.length} teams have defaulted fields (see Data Health)` : ""}`);
      setSimulationResults(null);
    } catch (e) {
      setUploadStatus(`❌ Error: ${e?.message || e}`);
    }
  };

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
      <h1 className="text-2xl font-bold mb-4 flex items-center gap-2"><BarChart3 size={22}/> NFL Monte Carlo Game Simulator (Gaussian v3)</h1>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="md:col-span-1 border rounded p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2"><Upload size={18}/> Load Teams</h2>
          <input type="file" accept=".csv" onChange={(e)=>e.target.files && handleCSVUpload(e.target.files[0])} />
          <p className="text-sm text-gray-600 mt-2">CSV needs a <code>Team</code> column. The app auto-detects common header names (e.g., <em>Off PPD</em>, <em>Off 3-Out %</em>, <em>Def Red-Zone TD% Allowed</em>).</p>
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
              <input type="number" className="border rounded px-3 py-2 w-full" value={hfaAdjustment} onChange={(e)=>setHfaAdjustment(parseFloat(e.target.value || 0))} />
            </div>
            <div>
              <label className="text-sm text-gray-600">Simulations</label>
              <input type="number" className="border rounded px-3 py-2 w-full" value={numSimulations} onChange={(e)=>setNumSimulations(parseInt(e.target.value || 10000))} />
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

          <button onClick={()=>{ setIsSimulating(true); setTimeout(()=>{ runSimulation(); setIsSimulating(false); }, 0); }} disabled={!homeTeam || !awayTeam || isSimulating} className="mt-4 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
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

      {/* Results */}
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
                {simulationResults.pOver !== null && (<li>Over {marketTotal}: {(simulationResults.pOver*100).toFixed(1)}%</li>)}
                {simulationResults.pUnder !== null && (<li>Under {marketTotal}: {(simulationResults.pUnder*100).toFixed(1)}%</li>)}
                {simulationResults.pHomeCover !== null && (<li>Home cover vs {marketSpread}: {(simulationResults.pHomeCover*100).toFixed(1)}%</li>)}
                {simulationResults.pAwayCover !== null && (<li>Away cover vs {marketSpread}: {(simulationResults.pAwayCover*100).toFixed(1)}%</li>)}
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

      {/* Data Health */}
      {Object.keys(dataHealth).length > 0 && (
        <div className="mt-6 border rounded p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2 text-amber-700"><AlertTriangle size={18}/> Data Health</h2>
          <p className="text-sm text-gray-700 mb-2">These teams were missing some fields; defaults were used for those items. If many fields are missing for both teams, projections can converge unnaturally.</p>
          <ul className="text-sm list-disc pl-5 space-y-1 max-h-56 overflow-auto">
            {Object.entries(dataHealth).map(([team, fields]) => (
              <li key={team}><strong>{team}:</strong> {fields.join(", ")}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default MonteCarloSimulator;
