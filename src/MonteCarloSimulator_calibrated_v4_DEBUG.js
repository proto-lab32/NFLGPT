import React, { useState } from "react";
import { Upload, Play, BarChart3, Bug, ShieldAlert } from "lucide-react";

const MonteCarloSimulator = () => {
  const L = {
    PPD: 2.06, PPD_sd: 0.42,
    EPA: 0.022, EPA_sd: 0.127,
    SR: 0.43, SR_sd: 0.05,
    Xpl: 0.113, Xpl_sd: 0.033,
    RZ: 0.56, RZ_sd: 0.12,
    ThreeOut: 0.24, ThreeOut_sd: 0.05,
    Pen: 0.44, Pen_sd: 0.12,
    DVOA_sd: 0.10, TOEPA_sd: 0.05, FP_mu: 25, FP_sd: 3,
  };
  const C = { c1: 0.56, c2: 0.21 };
  const BASE = {
    EPA: 0.40, SR: 0.20, PPD_resid: 0.20, Xpl: 0.10, RZ: 0.10,
    ThreeOut_eff: -0.20, DVOA: 0.12, TO_EPA: 0.08, FP: 0.08, Penalty: 0.06,
  };
  const normalize = (obj) => {
    const s = Object.values(obj).reduce((a,b)=>a+Math.abs(b),0)||1;
    const out = {}; for (const [k,v] of Object.entries(obj)) out[k]=v/s; return out;
  }
  const W = normalize(BASE);

  const [teamDB, setTeamDB] = useState({});
  const [teamList, setTeamList] = useState([]);
  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  const [hfaAdjustment, setHfaAdjustment] = useState(0);
  const [uploadStatus, setUploadStatus] = useState("");
  const [out, setOut] = useState(null);

  const pct = (v, def=null) => {
    if (v===null||v===undefined||v==="") return def;
    const s=String(v); const hasPct=s.includes("%");
    const n=parseFloat(s.replace(/[% ,]/g,""));
    if (isNaN(n)) return def;
    return hasPct ? n/100 : n;
  };
  const num = (v, def=null) => {
    if (v===null||v===undefined||v==="") return def;
    const n=parseFloat(String(v).replace(/[, ]/g,""));
    return isNaN(n)?def:n;
  };
  const aliases = {
    Team:["Team","team","Name"],
    off_ppd:["Off PPD"],
    off_epa:["Off EPA/play"],
    off_sr:["Off Success Rate"],
    off_xpl:["Off Explosive Rate"],
    off_rz:["Off Red-Zone TD%"],
    off_3out:["Off 3-Out %"],
    off_pen:["Off Penalties per Drive"],
    off_to_epa:["Off TO EPA per Drive"],
    off_fp:["Off Avg Starting FP"],
    def_ppd_allowed:["Def PPD Allowed"],
    def_epa_allowed:["Def EPA/play allowed"],
    def_sr:["Def Success Rate"],
    def_xpl:["Def Explosive Rate"],
    def_rz:["Def Red Zone TD %"],
    def_3out:["Def 3-Out %"],
    def_pen:["DEF Penalties per Drive"],
    off_dvoa:["Off DVOA"],
    def_dvoa:["Def DVOA"],
    off_drives:["Off Drives/G"],
    def_drives:["Def Drives/G"],
    ed_pass:["Neutral Early-Down Pass %"],
    no_huddle:["No-Huddle %"],
  };
  const pick = (row, keys, def=null, asPct=false) => {
    for (const k of keys) if (k in row && row[k] !== "") return asPct ? pct(row[k],def) : num(row[k],def);
    return def;
  };
  const z = (v,m,s) => (!isFinite(s)||s===0||!isFinite(v))?0:Math.max(-3.5,Math.min(3.5,(v-m)/s));

  const parseCSV = async (file) => {
    let text = await file.text();
    if (text.charCodeAt(0)===0xFEFF) text=text.slice(1);
    text = text.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
    const first=(text.split("\n")[0]||""); const delim=(first.includes("\t")&&!first.includes(","))?"\t":",";
    const rows=[]; let i=0,f="",r=[],q=false;
    while(i<text.length){
      const ch=text[i];
      if(q){ if(ch=='"'){ if(i+1<text.length&&text[i+1]=='"'){f+='"';i+=2;} else {q=false;i++;} } else { f+=ch;i++; } }
      else {
        if(ch=='"'){ q=true;i++; }
        else if(ch===delim){ r.push(f.trim()); f=""; i++; }
        else if(ch==='\n'){ r.push(f.trim()); rows.push(r); r=[]; f=""; i++; }
        else { f+=ch; i++; }
      }
    }
    r.push(f.trim()); rows.push(r);
    const header=rows[0]; const data=rows.slice(1).map(row=>{ const o={}; for(let j=0;j<header.length;j++) o[header[j]]=(row[j]??"").trim(); return o; });
    return { header, data };
  };

  const onUpload = async (file) => {
    try {
      const { header, data } = await parseCSV(file);
      const tKey = header.find(h=>["team","Team","Name","name","TEAM"].includes(h)) || header.find(h=>h.toLowerCase().includes("team"));
      if(!tKey) throw new Error("No Team column");
      const db={}; const names=[];
      data.forEach(row=>{
        const name=(row[tKey]||"").trim(); if(!name) return;
        db[name]={
          Team:name,
          off_ppd: pick(row, aliases.off_ppd, L.PPD),
          off_epa: pick(row, aliases.off_epa, L.EPA),
          off_sr:  pick(row, aliases.off_sr,  L.SR, true),
          off_xpl: pick(row, aliases.off_xpl, L.Xpl, true),
          off_rz:  pick(row, aliases.off_rz,  L.RZ, true),
          off_3out:pick(row, aliases.off_3out, L.ThreeOut, true),
          off_pen: pick(row, aliases.off_pen,  L.Pen),
          off_to_epa: pick(row, aliases.off_to_epa, 0),
          off_fp:  pick(row, aliases.off_fp,  L.FP_mu),
          def_ppd_allowed: pick(row, aliases.def_ppd_allowed, L.PPD),
          def_epa_allowed: pick(row, aliases.def_epa_allowed, L.EPA),
          def_sr:  pick(row, aliases.def_sr,  L.SR, true),
          def_xpl: pick(row, aliases.def_xpl, L.Xpl, true),
          def_rz:  pick(row, aliases.def_rz,  L.RZ, true),
          def_3out:pick(row, aliases.def_3out, L.ThreeOut, true),
          def_pen: pick(row, aliases.def_pen,  L.Pen),
          off_dvoa: pick(row, aliases.off_dvoa, 0, true),   // **parse as percent**
          def_dvoa: pick(row, aliases.def_dvoa, 0, true),   // **parse as percent**
          off_drives: pick(row, aliases.off_drives, 12),
          def_drives: pick(row, aliases.def_drives, 12),
          ed_pass: pick(row, aliases.ed_pass, 0.5, true),
          no_huddle: pick(row, aliases.no_huddle, 0.02, true),
        };
        names.push(name);
      });
      setTeamDB(db); setTeamList(names.sort()); setUploadStatus(`✅ Loaded ${names.length} teams`);
    } catch(e) { setUploadStatus(`❌ ${e?.message||e}`); }
  };

  const computeNets = (team, opp) => {
    const z_off = {
      PPD: z(team.off_ppd, L.PPD, L.PPD_sd),
      EPA: z(team.off_epa, L.EPA, L.EPA_sd),
      SR:  z(team.off_sr,  L.SR,  L.SR_sd),
      Xpl: z(team.off_xpl, L.Xpl, L.Xpl_sd),
      RZ:  z(team.off_rz,  L.RZ,  L.RZ_sd),
      OUT: z(team.off_3out,L.ThreeOut, L.ThreeOut_sd),
      PEN: z(team.off_pen, L.Pen, L.Pen_sd),
    };
    const z_def = {
      PPD: z(opp.def_ppd_allowed, L.PPD, L.PPD_sd),
      EPA: z(opp.def_epa_allowed, L.EPA, L.EPA_sd),
      SR:  z(opp.def_sr,  L.SR,  L.SR_sd),
      Xpl: z(opp.def_xpl, L.Xpl, L.Xpl_sd),
      RZ:  z(opp.def_rz,  L.RZ,  L.RZ_sd),
      OUT: z(opp.def_3out, L.ThreeOut, L.ThreeOut_sd),
      PEN: z(opp.def_pen, L.Pen, L.Pen_sd),
    };

    const epa_net = z_off.EPA + z_def.EPA;
    const sr_net  = z_off.SR  + z_def.SR;
    const ppd_net = z_off.PPD + z_def.PPD;
    const xpl_net = z_off.Xpl + z_def.Xpl;
    const rz_net  = z_off.RZ  + z_def.RZ;
    const out_eff = (z_off.OUT - z_def.OUT);  // Lower offense 3-out + lower defense 3-out = better offense

    const ppd_resid = ppd_net - (C.c1*epa_net + C.c2*sr_net);

    // DVOA parsed as fraction already; convert to z by dividing by sd
    // Off DVOA: positive = good. Def DVOA: negative = good defense, so subtract it (good defense hurts offense)
    const dvoa_net = (team.off_dvoa)/L.DVOA_sd - (opp.def_dvoa)/L.DVOA_sd;
    const z_to = (team.off_to_epa)/L.TOEPA_sd;
    const z_fp = (team.off_fp - L.FP_mu)/L.FP_sd;
    const pen_mix = (-z_off.PEN + z_def.PEN);

    const contrib = {
      EPA: W.EPA*epa_net, SR: W.SR*sr_net, PPD_resid: W.PPD_resid*ppd_resid,
      Xpl: W.Xpl*xpl_net, RZ: W.RZ*rz_net, ThreeOut_eff: W.ThreeOut_eff*out_eff,
      DVOA: W.DVOA*dvoa_net, TO_EPA: W.TO_EPA*z_to, FP: W.FP*z_fp, Penalty: W.Penalty*pen_mix
    };
    const ensemble_z = Object.values(contrib).reduce((a,b)=>a+b,0);
    return { epa_net, sr_net, ppd_resid, xpl_net, rz_net, out_eff, dvoa_net, z_to, z_fp, pen_mix, contrib, ensemble_z };
  };

  const mapZtoPPD = (zval) => Math.max(0.4, Math.min(4.0, L.PPD + zval*L.PPD_sd));

  const computePace = (home, away, netsHome) => {
    const offDefAvgHome = (home.off_drives + away.def_drives)/2;
    const offDefAvgAway = (away.off_drives + home.def_drives)/2;
    let gameDrives = offDefAvgHome + offDefAvgAway;
    const nh = ((home.no_huddle||0)+(away.no_huddle||0))/2;
    const ed = (((home.ed_pass||0)-0.5)+((away.ed_pass||0)-0.5))/2;
    gameDrives = gameDrives * (1 + 0.2*nh + 0.1*ed);
    gameDrives = Math.min(30, Math.max(20, gameDrives));
    let posShare = 0.5 + 0.08*(netsHome.sr_net + 0.5*netsHome.epa_net);
    posShare = Math.max(0.42, Math.min(0.58, posShare));
    return { gameDrives, posShare };
  };

  const run = () => {
    if(!homeTeam||!awayTeam) { setUploadStatus("❌ Pick both teams"); return; }
    const H = teamDB[homeTeam]; const A = teamDB[awayTeam];
    const nH = computeNets(H, A);
    const nA = computeNets(A, H);
    const { gameDrives, posShare } = computePace(H, A, nH);
    const homeDrives = gameDrives * posShare;
    const ppdH = mapZtoPPD(nH.ensemble_z) + (hfaAdjustment / homeDrives);
    const ppdA = mapZtoPPD(nA.ensemble_z);
    const homeMean = ppdH * gameDrives * posShare;
    const awayMean = ppdA * gameDrives * (1-posShare);
    const { contrib: home_contrib, ensemble_z: z_home, ...home_nets } = nH;
    const { contrib: away_contrib, ensemble_z: z_away, ...away_nets } = nA;

    setOut({
      home: homeTeam, away: awayTeam,
      homeMean, awayMean, spread: homeMean - awayMean,
      gameDrives, posShare,
      weights: W,
      home_contrib, away_contrib,
      home_nets, away_nets,
      z_home, z_away
    });
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-4 flex items-center gap-2"><BarChart3 size=22/> NFL Gaussian — Calibrated (debug)</h1>
      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="md:col-span-1 border rounded p-4">
          <h2 className="font-semibold mb-2">Upload CSV</h2>
          <input type="file" accept=".csv" onChange={(e)=>e.target.files && onUpload(e.target.files[0])} />
          <div className="text-sm mt-2">{uploadStatus}</div>
        </div>
        <div className="md:col-span-2 border rounded p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-gray-600">Home</label>
              <select value={homeTeam} onChange={(e)=>setHomeTeam(e.target.value)} className="border rounded px-3 py-2 w-full">
                <option value="">Select</option>
                {teamList.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600">Away</label>
              <select value={awayTeam} onChange={(e)=>setAwayTeam(e.target.value)} className="border rounded px-3 py-2 w-full">
                <option value="">Select</option>
                {teamList.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div>
              <label className="text-sm text-gray-600">HFA (pts)</label>
              <input type="number" value={hfaAdjustment} onChange={(e)=>setHfaAdjustment(parseFloat(e.target.value||0))} className="border rounded px-3 py-2 w-full" />
            </div>
            <div className="flex items-end">
              <button onClick={run} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded inline-flex items-center gap-2">
                <Play size={16}/> Compute Means
              </button>
            </div>
          </div>
        </div>
      </div>

      {out && (
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-2">Means</h2>
          <div className="text-sm">Home mean: {out.homeMean.toFixed(2)} | Away mean: {out.awayMean.toFixed(2)} | Spread: {out.spread.toFixed(2)} | Drives: {out.gameDrives.toFixed(1)} | posShare: {(out.posShare*100).toFixed(1)}%</div>

          <div className="mt-3 border-t pt-3">
            <h3 className="font-semibold flex items-center gap-2"><ShieldAlert size={16}/> Contributions (z-weighted)</h3>
            <div className="grid md:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="font-semibold">Home contributions</div>
                <pre className="bg-gray-50 p-3 rounded overflow-auto">{JSON.stringify(out.home_contrib, null, 2)}</pre>
              </div>
              <div>
                <div className="font-semibold">Away contributions</div>
                <pre className="bg-gray-50 p-3 rounded overflow-auto">{JSON.stringify(out.away_contrib, null, 2)}</pre>
              </div>
            </div>
            <div className="mt-3 grid md:grid-cols-2 gap-4 text-xs">
              <div>
                <div className="font-semibold">Home nets</div>
                <pre className="bg-gray-50 p-3 rounded overflow-auto">{JSON.stringify(out.home_nets, null, 2)}</pre>
              </div>
              <div>
                <div className="font-semibold">Away nets</div>
                <pre className="bg-gray-50 p-3 rounded overflow-auto">{JSON.stringify(out.away_nets, null, 2)}</pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonteCarloSimulator;
