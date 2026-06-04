"use client";

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatPct } from "@/lib/utils";
import { groupBySector } from "@/lib/sectors";
import type { Holding } from "@/lib/types";

const PALETTE = [
  "hsl(199 80% 52%)",
  "hsl(152 52% 48%)",
  "hsl(38 80% 55%)",
  "hsl(258 70% 66%)",
  "hsl(2 70% 60%)",
  "hsl(222 70% 60%)",
  "hsl(174 52% 46%)",
  "hsl(300 45% 60%)",
];

export function SectorAllocation({ holdings }: { holdings: Holding[] }) {
  const slices = groupBySector(holdings);
  const maxWeight = slices[0]?.weight ?? 1;
  const chart = slices.map((s, i) => ({
    name: s.sector,
    value: Number(s.weight.toFixed(2)),
    color: PALETTE[i % PALETTE.length],
  }));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">Sector Allocation</CardTitle>
        <span className="text-xs text-muted-foreground">{slices.length} sectors</span>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5 sm:flex-row">
        <div className="h-[150px] w-[150px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chart}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={42}
                outerRadius={70}
                paddingAngle={2}
                strokeWidth={0}
                isAnimationActive={false}
              >
                {chart.map((e) => (
                  <Cell key={e.name} fill={e.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>

        <ul className="w-full flex-1 space-y-2.5">
          {slices.map((s, i) => (
            <li key={s.sector} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                  />
                  <span className="font-medium">{s.sector}</span>
                </span>
                <span className="font-mono-nums font-semibold tabular-nums">
                  {formatPct(s.weight)}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full")}
                  style={{
                    width: `${(s.weight / maxWeight) * 100}%`,
                    backgroundColor: PALETTE[i % PALETTE.length],
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
