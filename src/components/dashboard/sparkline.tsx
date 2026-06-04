"use client";

import * as React from "react";

/**
 * Lightweight SVG sparkline (no chart lib) — cheap to render many at once on
 * the Stocks tab. Colour follows direction (green up / red down) unless given.
 */
export function Sparkline({
  data,
  width = 320,
  height = 56,
  className,
}: {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const id = React.useId();
  if (!data || data.length < 2) {
    return (
      <div
        className={className}
        style={{ height }}
        aria-hidden
      />
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pad = 4;
  const usable = height - pad * 2;

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = pad + (1 - (v - min) / range) * usable;
    return [x, y] as const;
  });

  const up = data[data.length - 1] >= data[0];
  const stroke = up ? "hsl(var(--positive))" : "hsl(var(--negative))";

  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area =
    `0,${height} ` +
    points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ") +
    ` ${width},${height}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: "100%", height }}
    >
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#spark-${id})`} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
