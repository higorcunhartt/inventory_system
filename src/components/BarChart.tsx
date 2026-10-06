export function BarChart({ title, data, format }: { title: string; data: Array<{ label: string; value: number }>; format: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 520;
  const h = 170;
  const pad = { l: 8, r: 8, t: 20, b: 26 };
  const bw = (w - pad.l - pad.r) / Math.max(1, data.length);
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      {data.length === 0 ? (
        <p className="muted">Sem dados no período.</p>
      ) : (
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title}>
          {data.map((d, i) => {
            const bh = ((h - pad.t - pad.b) * d.value) / max;
            const x = pad.l + i * bw + bw * 0.15;
            const y = h - pad.b - bh;
            return (
              <g key={d.label}>
                <rect x={x} y={y} width={bw * 0.7} height={bh} rx={3} className="bar" />
                <text x={x + bw * 0.35} y={y - 5} textAnchor="middle" className="bar-val">
                  {format(d.value)}
                </text>
                <text x={x + bw * 0.35} y={h - 8} textAnchor="middle" className="bar-lbl">
                  {d.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}
