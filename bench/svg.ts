export interface ChartRow {
  id: string;
  label: string;
  orbitValue: number;
  orbitLabel: string;
  competitionValue: number;
  competitionLabel: string;
  unit: string;
  lowerIsBetter: boolean;
  goalMet: boolean;
}

const W = 1040;
const PAD = 60;
const HEADER_H = 105;
const FOOTER_H = 42;
const ROW_H = 74;
const ROW_GAP = 18;
const PLOT_LEFT = 240;
const RIGHT_MARGIN = 120; // ← margen derecho amplio: barras + labels nunca tocan el borde
const PLOT_RIGHT = W - RIGHT_MARGIN;
const BAR_H = 22;
const BAR_GAP = 10;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;

const CARD = '#1a1a20';
const GRID = '#2a2a3a';
const TEXT = '#f0f0f0';
const TEXT_DIM = '#888';
const TEXT_FAINT = '#555';
const COMP_GRAD_START = '#4a4a5e';
const COMP_GRAD_END = '#2e2e3e';
const ORBIT_GRAD_START = '#fff';
const ORBIT_GRAD_END = '#f0f0f0';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderChart(title: string, rows: ChartRow[]): string {
  const H = HEADER_H + rows.length * (ROW_H + ROW_GAP) + FOOTER_H;
  const plotW = PLOT_WIDTH;
  const gridTop = HEADER_H + 8;
  const gridBottom = H - FOOTER_H - 22;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`,
  );
  out.push(`<defs>
  <linearGradient id="orbitGrad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="${ORBIT_GRAD_START}"/>
    <stop offset="100%" stop-color="${ORBIT_GRAD_END}"/>
  </linearGradient>
  <linearGradient id="compGrad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="${COMP_GRAD_START}"/>
    <stop offset="100%" stop-color="${COMP_GRAD_END}"/>
  </linearGradient>
  <filter id="orbitShadow" x="-20%" y="-40%" width="140%" height="180%">
    <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#fff" flood-opacity="0.22"/>
  </filter>
</defs>`);

  // Card background (con margen simétrico)
  out.push(`<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="16" fill="${CARD}"/>`);
  out.push(
    `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="16" fill="none" stroke="#2f2f3a" stroke-width="1"/>`,
  );

  // Header
  out.push(
    `<text x="${PAD}" y="46" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="22" font-weight="700" fill="${TEXT}">${esc(title)}</text>`,
  );
  out.push(
    `<text x="${PAD}" y="70" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11" fill="${TEXT_DIM}">Orbit vs. competition — measured on this machine (Node ${esc(process.version)}), see docs/benchmarks.md for methodology.</text>`,
  );

  // Legend
  out.push(
    `<g font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="12" fill="${TEXT}">`,
  );
  out.push(`  <rect x="${PAD}" y="82" width="12" height="12" rx="3" fill="url(#orbitGrad)"/>`);
  out.push(
    `  <text x="${PAD + 20}" y="91" font-size="11" fill="${TEXT}" dominant-baseline="middle">Orbit</text>`,
  );
  out.push(`  <rect x="${PAD + 68}" y="82" width="12" height="12" rx="3" fill="url(#compGrad)"/>`);
  out.push(
    `  <text x="${PAD + 88}" y="91" font-size="11" fill="${TEXT}" dominant-baseline="middle">Competition</text>`,
  );
  out.push(`</g>`);

  // Vertical grid (termina en PLOT_RIGHT, no en el borde del card)
  for (let i = 0; i <= 4; i += 1) {
    const x = PLOT_LEFT + (plotW * i) / 4;
    out.push(
      `<line x1="${x}" y1="${gridTop}" x2="${x}" y2="${gridBottom}" stroke="${GRID}" stroke-width="1" stroke-dasharray="3 6"/>`,
    );
    out.push(
      `<text x="${x}" y="${gridBottom + 18}" font-size="9" fill="${TEXT_FAINT}" text-anchor="middle" dominant-baseline="middle">${i * 20}%</text>`,
    );
  }

  // Rows
  rows.forEach((row, i) => {
    const top = HEADER_H + i * (ROW_H + ROW_GAP);
    const center = top + ROW_H / 2;
    const max = Math.max(row.orbitValue, row.competitionValue) || 1;

    // Label + bullet — alineados perfectamente
    const goalColor = row.goalMet ? '#3ae' : '#e56';
    out.push(`<circle cx="${PAD + 6}" cy="${center}" r="3.5" fill="${goalColor}"/>`);
    out.push(
      `<text x="${PAD + 18}" y="${center}" font-size="13" font-weight="600" fill="${TEXT}" dominant-baseline="middle" text-anchor="start">${esc(row.label)}</text>`,
    );

    // Competition bar (top) — nunca toca el borde derecho del card
    const compY = center - BAR_GAP / 2 - BAR_H;
    const compW = Math.max(2, (row.competitionValue / max) * plotW);
    out.push(
      `<rect x="${PLOT_LEFT}" y="${compY}" width="${compW.toFixed(1)}" height="${BAR_H}" rx="6" fill="url(#compGrad)"/>`,
    );

    // Competition label — con espacio garantizado a la derecha
    out.push(
      `<text x="${PLOT_LEFT + compW + 10}" y="${compY + BAR_H / 2}" font-size="11" fill="${TEXT_DIM}" dominant-baseline="middle">${esc(row.competitionLabel)}</text>`,
    );

    // Orbit bar (bottom)
    const orbitY = center + BAR_GAP / 2;
    const orbitW = Math.max(2, (row.orbitValue / max) * plotW);
    out.push(
      `<rect x="${PLOT_LEFT}" y="${orbitY}" width="${orbitW.toFixed(1)}" height="${BAR_H}" rx="6" fill="url(#orbitGrad)" filter="url(#orbitShadow)"/>`,
    );

    // Orbit label
    out.push(
      `<text x="${PLOT_LEFT + orbitW + 10}" y="${orbitY + BAR_H / 2}" font-size="11" font-weight="700" fill="${ORBIT_GRAD_START}" dominant-baseline="middle">${esc(row.orbitLabel)}</text>`,
    );
  });

  // Footer
  out.push(
    `<text x="${PAD}" y="${H - 16}" font-size="10" fill="${TEXT_FAINT}">Bars are scaled per row (each row has its own unit). Orbit bars rendered in white. Generated by bench/run.ts.</text>`,
  );
  out.push('</svg>');
  return out.join('\n');
}
