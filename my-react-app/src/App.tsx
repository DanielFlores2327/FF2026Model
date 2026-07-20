import { useState, useMemo } from "react";
import csvRaw from "../data/draft_board_tep4.csv?raw";

// ---------- League constants (Parkway Garden, league_id 1312878985599799296) ----------
const TEAMS = 10;
const BUDGET = 200;
const ROSTER_SPOTS = 15; // 9 starters + 6 bench
const DEFAULT_KEEPERS = 0; // pure redraft league — no keepers

type Position = "QB" | "RB" | "WR" | "TE";

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];

const DEFAULT_REPLACEMENT_RANK: Record<Position, number> = {
  QB: 13,
  RB: 30,
  WR: 32,
  TE: 13,
};

// CSV columns (0-indexed): RK,Player,Pos,Team,Bye,ADP,Tier,...,PassYds(28),PassTDs(29),
// RushYds(30),RushTDs(31),RecYds(32),Rec(33),RecTDs(34),...
// The CSV does not include pass_int, pass_cmp, or fum_lost, so we estimate:
//   pass_cmp ≈ pass_yd / 11.4  (avg yards per completion)
//   pass_int ≈ pass_td / 2.7   (TD-to-INT ratio)
//   fum_lost = 0               (not available, small impact)
const COL_PASS_YD = 28;
const COL_PASS_TD = 29;
const COL_RUSH_YD = 30;
const COL_RUSH_TD = 31;
const COL_REC_YD = 32;
const COL_REC = 33;
const COL_REC_TD = 34;

function num(v: string): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function parseCsv(raw: string) {
  const lines = raw.trim().split("\n").filter((l) => l.trim());
  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const name = (cols[1] || "").trim();
    const pos = (cols[2] || "").trim() as Position;
    const team = (cols[3] || "").trim();
    if (!name || !POSITIONS.includes(pos)) continue;
    const pass_yd = num(cols[COL_PASS_YD]);
    const pass_td = num(cols[COL_PASS_TD]);
    const rush_yd = num(cols[COL_RUSH_YD]);
    const rush_td = num(cols[COL_RUSH_TD]);
    const rec_yd = num(cols[COL_REC_YD]);
    const rec = num(cols[COL_REC]);
    const rec_td = num(cols[COL_REC_TD]);
    const pass_cmp = pass_yd > 0 ? Math.round(pass_yd / 11.4) : 0;
    const pass_int = pass_td > 0 ? Math.round(pass_td / 2.7) : 0;
    rows.push({
      name, pos, team,
      pass_yd, pass_td, pass_int, pass_cmp,
      rush_yd, rush_td,
      rec, rec_yd, rec_td,
      fum_lost: 0,
      id: name + team,
      drafted: false,
      price: "",
    });
  }
  return rows;
}

const SAMPLE = parseCsv(csvRaw);

function fantasyPoints(p: any) {
  let pts = 0;
  if (p.pos === "QB") {
    pts += p.pass_yd * 0.05 + p.pass_td * 5 + p.pass_int * -3 + p.pass_cmp * 0.25;
    pts += p.rush_yd * 0.1 + p.rush_td * 6 + p.fum_lost * -2;
  } else if (p.pos === "RB") {
    pts += p.rush_yd * 0.1 + p.rush_td * 6;
    pts += p.rec * 1.25 + p.rec_yd * 0.1 + p.rec_td * 6; // +0.25 RB reception bonus
    pts += p.fum_lost * -2;
  } else if (p.pos === "WR") {
    pts += p.rec * 1.0 + p.rec_yd * 0.1 + p.rec_td * 6;
    pts += p.rush_yd * 0.1 + p.rush_td * 6 + p.fum_lost * -2;
  } else if (p.pos === "TE") {
    pts += p.rec * 2.0 + p.rec_yd * 0.1 + p.rec_td * 6; // TE premium: 1.0 base + 1.0 bonus
    pts += p.rush_yd * 0.1 + p.rush_td * 6 + p.fum_lost * -2;
  }
  return Math.round(pts * 10) / 10;
}

export default function AuctionBoard() {
  const [players, setPlayers] = useState(() => SAMPLE.map((p) => ({ ...p })));
  const [replRank, setReplRank] = useState(DEFAULT_REPLACEMENT_RANK);
  const [keepers, setKeepers] = useState(DEFAULT_KEEPERS);
  const [posFilter, setPosFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("value");

  const scored = useMemo(
    () => players.map((p) => ({ ...p, pts: fantasyPoints(p) })),
    [players]
  );

  const { valued, spendablePool } = useMemo(() => {
    const auctionSlots = TEAMS * (ROSTER_SPOTS - keepers);
    const reserveFloor = auctionSlots * 1;
    const pool = TEAMS * BUDGET - reserveFloor;

    const byPos: Record<string, any[]> = {};
    POSITIONS.forEach((pos) => {
      byPos[pos] = scored
        .filter((p) => p.pos === pos)
        .sort((a, b) => b.pts - a.pts);
    });

    const replPts: Record<string, number> = {};
    POSITIONS.forEach((pos) => {
      const arr = byPos[pos];
      const idx = Math.min(replRank[pos] - 1, arr.length - 1);
      replPts[pos] = idx >= 0 ? arr[idx].pts : 0;
    });

    const withValue = scored.map((p) => ({
      ...p,
      vor: Math.max(0, p.pts - replPts[p.pos]),
    }));

    const sumVor = withValue.reduce((s, p) => s + p.vor, 0) || 1;

    const final = withValue.map((p) => ({
      ...p,
      baseDollar: p.vor > 0 ? Math.max(1, Math.round((1 + (p.vor / sumVor) * pool) * 10) / 10) : 1,
    }));

    return { valued: final, spendablePool: pool };
  }, [scored, replRank, keepers]);

  const { totalSpent, remainingBudget, undraftedPoolValue, inflation } = useMemo(() => {
    const spent = valued.reduce((s, p) => s + (p.drafted ? Number(p.price) || 0 : 0), 0);
    const remBudget = TEAMS * BUDGET - spent;
    const undraftedVal = valued.reduce((s, p) => s + (!p.drafted ? p.baseDollar : 0), 0) || 1;
    const infl = remBudget / undraftedVal;
    return { totalSpent: spent, remainingBudget: remBudget, undraftedPoolValue: undraftedVal, inflation: infl };
  }, [valued]);

  const rows = useMemo(() => {
    let r = valued.map((p) => ({ ...p, liveDollar: p.drafted ? Number(p.price) || 0 : Math.round(p.baseDollar * inflation * 10) / 10 }));
    if (posFilter !== "ALL") r = r.filter((p) => p.pos === posFilter);
    r.sort((a, b) => {
      if (sortKey === "value") return b.liveDollar - a.liveDollar;
      if (sortKey === "pts") return b.pts - a.pts;
      return a.name.localeCompare(b.name);
    });
    return r;
  }, [valued, posFilter, sortKey, inflation]);

  function updatePlayer(id: string, patch: Record<string, any>) {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  return (
    <div className="min-h-screen bg-emerald-950 text-emerald-50 font-sans">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="border-b-2 border-dashed border-emerald-700 pb-4 mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.3em] text-emerald-400 mb-1">Parkway Garden · Auction Board</div>
            <h1 className="text-3xl font-black tracking-tight text-amber-400">DRAFT DAY $ CALCULATOR</h1>
          </div>
          <div className="flex gap-3">
            <div className="bg-emerald-900 border border-emerald-700 rounded px-4 py-2 text-center">
              <div className="text-[10px] uppercase tracking-widest text-emerald-400">League Spent</div>
              <div className="font-mono text-xl font-bold text-amber-400 tabular-nums">${totalSpent}</div>
            </div>
            <div className="bg-emerald-900 border border-emerald-700 rounded px-4 py-2 text-center">
              <div className="text-[10px] uppercase tracking-widest text-emerald-400">Remaining</div>
              <div className="font-mono text-xl font-bold text-amber-400 tabular-nums">${remainingBudget}</div>
            </div>
            <div className="bg-emerald-900 border border-emerald-700 rounded px-4 py-2 text-center">
              <div className="text-[10px] uppercase tracking-widest text-emerald-400">Inflation</div>
              <div className="font-mono text-xl font-bold text-amber-400 tabular-nums">{(inflation * 100).toFixed(0)}%</div>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
          <div className="flex gap-1">
            {["ALL", ...POSITIONS].map((p) => (
              <button
                key={p}
                onClick={() => setPosFilter(p)}
                className={`px-3 py-1 rounded border ${posFilter === p ? "bg-amber-400 text-emerald-950 border-amber-400 font-bold" : "border-emerald-700 text-emerald-300 hover:border-emerald-500"}`}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="flex gap-1 ml-auto">
            {[["value","$ Value"],["pts","Points"],["name","Name"]].map(([k,label]) => (
              <button
                key={k}
                onClick={() => setSortKey(k)}
                className={`px-3 py-1 rounded border ${sortKey === k ? "bg-emerald-700 border-emerald-500" : "border-emerald-700 text-emerald-300"}`}
              >
                Sort: {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-emerald-300">
            Keepers/team
            <input
              type="number"
              min={0}
              max={5}
              value={keepers}
              onChange={(e) => setKeepers(Number(e.target.value) || 0)}
              className="w-14 bg-emerald-900 border border-emerald-700 rounded px-2 py-1 text-emerald-50"
            />
          </label>
        </div>

        {/* Replacement rank tuning */}
        <div className="mb-4 flex flex-wrap gap-3 text-xs text-emerald-300">
          {POSITIONS.map((pos) => (
            <label key={pos} className="flex items-center gap-1 bg-emerald-900 border border-emerald-700 rounded px-2 py-1">
              {pos} replacement rank
              <input
                type="number"
                value={replRank[pos]}
                onChange={(e) => setReplRank((r) => ({ ...r, [pos]: Number(e.target.value) || 1 }))}
                className="w-12 bg-emerald-950 border border-emerald-700 rounded px-1 text-emerald-50"
              />
            </label>
          ))}
        </div>

        {/* Table */}
        <div className="border border-emerald-700 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-emerald-900 text-emerald-300 uppercase text-[11px] tracking-wider">
                <th className="text-left px-3 py-2">Player</th>
                <th className="text-left px-3 py-2">Pos</th>
                <th className="text-left px-3 py-2">Team</th>
                <th className="text-right px-3 py-2">Proj Pts</th>
                <th className="text-right px-3 py-2">Live $</th>
                <th className="text-center px-3 py-2">Drafted</th>
                <th className="text-right px-3 py-2">Price Paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr
                  key={p.id}
                  className={`border-t border-dashed border-emerald-800 ${p.drafted ? "opacity-40" : i % 2 ? "bg-emerald-900/30" : ""}`}
                >
                  <td className="px-3 py-1.5 font-medium">{p.name}</td>
                  <td className="px-3 py-1.5 text-emerald-400">{p.pos}</td>
                  <td className="px-3 py-1.5 text-emerald-400">{p.team}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{p.pts}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums font-bold text-amber-400">${p.liveDollar}</td>
                  <td className="px-3 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={p.drafted}
                      onChange={(e) => updatePlayer(p.id, { drafted: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      value={p.price}
                      onChange={(e) => updatePlayer(p.id, { price: e.target.value })}
                      className="w-16 bg-emerald-950 border border-emerald-700 rounded px-1 py-0.5 text-right font-mono text-emerald-50"
                      placeholder="$"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 text-xs text-emerald-400 leading-relaxed space-y-1">
          <p>
            Scoring is wired exactly to Parkway Garden's rules: 2.0 pts/TE catch, 1.25 pts/RB catch, 1.0 pts/WR catch,
            5pt pass TDs, -3 INTs, +0.25/completion. Not modeled from season totals (no play-by-play
            available): first-down bonuses, 20-29/30-39 yard reception bonuses, 40+/50+ yard TD bonuses, 300/400-yard
            passing game bonuses, 2pt conversions, fumbles lost. Actual league points for big-play players will run a
            bit higher than shown here — treat $ values as a floor, not a ceiling, for boom/bust players.
          </p>
          <p>
            Pure redraft, no keepers — every one of the 150 roster spots league-wide is bought at auction, so the full
            $2000 pool is in play. Projections loaded from <code className="text-emerald-300">data/draft_board_tep4.csv</code>
            (FantasyPros consensus, TEP4 scoring). Pass completions and interceptions are estimated from pass yards and
            pass TDs since the CSV does not include them directly.
          </p>
        </div>
      </div>
    </div>
  );
}
