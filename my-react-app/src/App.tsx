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
  const [showAll, setShowAll] = useState(false);

  const scored = useMemo(
    () => players.map((p) => ({ ...p, pts: fantasyPoints(p) })),
    [players]
  );

  const valued = useMemo(() => {
    // Total roster spots being bought at auction league-wide (150 in a pure redraft, minus any keepers).
    const auctionSlots = TEAMS * (ROSTER_SPOTS - keepers);
    const reserveFloor = auctionSlots * 1; // $1 minimum bid reserved for every spot that'll actually be filled
    const pool = TEAMS * BUDGET - reserveFloor;

    const byPos: Record<string, any[]> = {};
    POSITIONS.forEach((pos) => {
      byPos[pos] = scored.filter((p) => p.pos === pos).sort((a, b) => b.pts - a.pts);
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

    // Only the top `auctionSlots` players by VOR are actually going to get bought — everyone
    // past that is realistic $0 waiver-wire filler. Capping here is what makes total assigned
    // dollars equal the total budget, so inflation correctly starts at exactly 100%.
    const ranked = [...withValue].sort((a, b) => b.vor - a.vor);
    const draftableIds = new Set(ranked.slice(0, auctionSlots).map((p) => p.id));

    const sumVor = ranked.slice(0, auctionSlots).reduce((s, p) => s + p.vor, 0) || 1;

    const final = withValue.map((p) => {
      const draftable = draftableIds.has(p.id);
      const baseDollar = draftable ? Math.max(1, Math.round((1 + (p.vor / sumVor) * pool) * 10) / 10) : 0;
      return { ...p, draftable, baseDollar };
    });

    return final;
  }, [scored, replRank, keepers]);

  const { totalSpent, remainingBudget, inflation } = useMemo(() => {
    const spent = valued.reduce((s, p) => s + (p.drafted ? Number(p.price) || 0 : 0), 0);
    const remBudget = TEAMS * BUDGET - spent;
    const undraftedVal =
      valued.reduce((s, p) => s + (p.draftable && !p.drafted ? p.baseDollar : 0), 0) || 1;
    const infl = remBudget / undraftedVal;
    return { totalSpent: spent, remainingBudget: remBudget, inflation: infl };
  }, [valued]);

  const rows = useMemo(() => {
    let r = valued.map((p) => ({ ...p, liveDollar: p.drafted ? Number(p.price) || 0 : Math.round(p.baseDollar * inflation * 10) / 10 }));
    if (!showAll) r = r.filter((p) => p.draftable || p.drafted);
    if (posFilter !== "ALL") r = r.filter((p) => p.pos === posFilter);
    r.sort((a, b) => {
      if (sortKey === "value") return b.liveDollar - a.liveDollar || b.pts - a.pts;
      if (sortKey === "pts") return b.pts - a.pts;
      return a.name.localeCompare(b.name);
    });
    return r;
  }, [valued, posFilter, sortKey, inflation, showAll]);

  function updatePlayer(id: string, patch: Record<string, any>) {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_#0b3b2e_0%,_#04140f_65%)] text-emerald-50 font-sans antialiased">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="border-b-2 border-dashed border-emerald-800 pb-5 mb-6 flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-emerald-400/80 mb-1.5 font-medium">
              Parkway Garden · Auction Board
            </div>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-amber-400 drop-shadow-[0_2px_10px_rgba(251,191,36,0.15)]">
              DRAFT DAY $ CALCULATOR
            </h1>
          </div>
          <div className="flex gap-3">
            {[
              ["League Spent", `$${totalSpent}`],
              ["Remaining", `$${remainingBudget}`],
              ["Inflation", `${(inflation * 100).toFixed(0)}%`],
            ].map(([label, val]) => (
              <div
                key={label}
                className="bg-emerald-900/70 border border-emerald-700/70 rounded-lg px-4 py-2.5 text-center shadow-[0_2px_8px_rgba(0,0,0,0.25)] backdrop-blur-sm min-w-[92px]"
              >
                <div className="text-[10px] uppercase tracking-widest text-emerald-400/80">{label}</div>
                <div className="font-mono text-xl font-bold text-amber-400 tabular-nums leading-tight">{val}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
          <div className="flex gap-1">
            {["ALL", ...POSITIONS].map((p) => (
              <button
                key={p}
                onClick={() => setPosFilter(p)}
                className={`px-3 py-1.5 rounded-md border font-medium transition-colors ${
                  posFilter === p
                    ? "bg-amber-400 text-emerald-950 border-amber-400 font-bold shadow-[0_2px_6px_rgba(251,191,36,0.35)]"
                    : "border-emerald-700 text-emerald-300 hover:border-emerald-500 hover:bg-emerald-900/50"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="flex gap-1 ml-auto">
            {([["value", "$ Value"], ["pts", "Points"], ["name", "Name"]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSortKey(k)}
                className={`px-3 py-1.5 rounded-md border transition-colors ${
                  sortKey === k
                    ? "bg-emerald-700 border-emerald-500 text-emerald-50"
                    : "border-emerald-700 text-emerald-300 hover:bg-emerald-900/50"
                }`}
              >
                Sort: {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-emerald-300 bg-emerald-900/50 border border-emerald-700 rounded-md px-3 py-1.5">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-amber-400 w-3.5 h-3.5 cursor-pointer"
            />
            Show waiver wire
          </label>
          <label className="flex items-center gap-2 text-emerald-300 bg-emerald-900/50 border border-emerald-700 rounded-md px-3 py-1.5">
            Keepers/team
            <input
              type="number"
              min={0}
              max={5}
              value={keepers}
              onChange={(e) => setKeepers(Number(e.target.value) || 0)}
              className="no-spinner w-12 bg-emerald-950 border border-emerald-700 rounded px-2 py-0.5 text-emerald-50 focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
          </label>
        </div>

        {/* Replacement rank tuning */}
        <div className="mb-5 flex flex-wrap gap-2 text-xs text-emerald-300">
          {POSITIONS.map((pos) => (
            <label
              key={pos}
              className="flex items-center gap-1.5 bg-emerald-900/50 border border-emerald-700 rounded-md px-2.5 py-1.5"
            >
              <span className="font-semibold text-emerald-200">{pos}</span> replacement rank
              <input
                type="number"
                value={replRank[pos]}
                onChange={(e) => setReplRank((r) => ({ ...r, [pos]: Number(e.target.value) || 1 }))}
                className="no-spinner w-11 bg-emerald-950 border border-emerald-700 rounded px-1 py-0.5 text-emerald-50 focus:outline-none focus:ring-2 focus:ring-amber-400/60"
              />
            </label>
          ))}
        </div>

        {/* Table */}
        <div className="border border-emerald-700 rounded-lg overflow-hidden shadow-[0_4px_20px_rgba(0,0,0,0.3)]">
          <div className="max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-emerald-900 text-emerald-300 uppercase text-[11px] tracking-wider shadow-[0_1px_0_rgba(16,185,129,0.3)]">
                  <th className="text-left px-3 py-2.5 font-semibold">Player</th>
                  <th className="text-left px-3 py-2.5 font-semibold">Pos</th>
                  <th className="text-left px-3 py-2.5 font-semibold">Team</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Proj Pts</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Live $</th>
                  <th className="text-center px-3 py-2.5 font-semibold">Drafted</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Price Paid</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => (
                  <tr
                    key={p.id}
                    className={`border-t border-dashed border-emerald-800/70 transition-colors hover:bg-emerald-800/30 ${
                      p.drafted ? "opacity-40" : i % 2 ? "bg-emerald-900/20" : ""
                    }`}
                  >
                    <td className="px-3 py-2 font-medium">{p.name}</td>
                    <td className="px-3 py-2 text-emerald-400">{p.pos}</td>
                    <td className="px-3 py-2 text-emerald-400">{p.team}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-200">{p.pts}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-amber-400">
                      ${p.liveDollar}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={p.drafted}
                        onChange={(e) => updatePlayer(p.id, { drafted: e.target.checked })}
                        className="accent-amber-400 w-4 h-4 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        value={p.price}
                        onChange={(e) => updatePlayer(p.id, { price: e.target.value })}
                        className="no-spinner w-16 bg-emerald-950 border border-emerald-700 rounded px-1.5 py-1 text-right font-mono text-emerald-50 focus:outline-none focus:ring-2 focus:ring-amber-400/60 focus:border-amber-400/60"
                        placeholder="$"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-emerald-500 tracking-wide">
          Showing {rows.length} player{rows.length === 1 ? "" : "s"}
          {!showAll ? " · waiver wire hidden" : ""}
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
