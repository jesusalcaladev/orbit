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
const PAD = 44; // espacio para las etiquetas de % de la cuadrícula
const HEADER_H = 105;
const FOOTER_H = 46;
const BAR_MAX_H = 210; // altura máxima de una barra (la fila más alta de cada grupo)
const GRID_TOP = HEADER_H + 10;
const GRID_BOTTOM = GRID_TOP + BAR_MAX_H;
const PLOT_LEFT = PAD;
const PLOT_RIGHT = W - 24;

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

/** El número principal de una etiqueta (lo que hay antes del primer ` (`). */
function shortValue(label: string): string {
  return label.split(' (')[0] ?? label;
}

/** Recorta una etiqueta a un ancho aproximado en caracteres. */
function fit(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

export function renderChart(title: string, rows: ChartRow[]): string {
  const n = rows.length;
  const groupW = (PLOT_RIGHT - PLOT_LEFT) / n;
  const BAR_W = Math.min(30, groupW / 2 - 8);
  const H = GRID_BOTTOM + 88 + FOOTER_H;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`,
  );
  out.push(`<defs>
  <linearGradient id="orbitGrad" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0%" stop-color="${ORBIT_GRAD_END}"/>
    <stop offset="100%" stop-color="${ORBIT_GRAD_START}"/>
  </linearGradient>
  <linearGradient id="compGrad" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0%" stop-color="${COMP_GRAD_END}"/>
    <stop offset="100%" stop-color="${COMP_GRAD_START}"/>
  </linearGradient>
  <filter id="orbitShadow" x="-20%" y="-10%" width="140%" height="130%">
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

  // Cuadrícula horizontal: % del máximo de CADA grupo (cada fila escala su
  // propio máximo, igual que antes — unidades distintas por escenario).
  for (let i = 0; i <= 4; i += 1) {
    const y = GRID_BOTTOM - (BAR_MAX_H * i) / 4;
    out.push(
      `<line x1="${PLOT_LEFT}" y1="${y.toFixed(1)}" x2="${PLOT_RIGHT}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1" stroke-dasharray="3 6"/>`,
    );
    out.push(
      `<text x="${PLOT_LEFT - 6}" y="${y.toFixed(1)}" font-size="9" fill="${TEXT_FAINT}" text-anchor="end" dominant-baseline="middle">${i * 25}%</text>`,
    );
  }

  // Grupos: dos barras verticales por escenario (competition + orbit).
  rows.forEach((row, i) => {
    const groupX = PLOT_LEFT + groupW * i;
    const center = groupX + groupW / 2;
    const max = Math.max(row.orbitValue, row.competitionValue) || 1;
    const h = (v: number) => Math.max(2, (v / max) * BAR_MAX_H);

    const compH = h(row.competitionValue);
    const compX = center - BAR_W - 5;
    const compY = GRID_BOTTOM - compH;
    out.push(
      `<rect x="${compX.toFixed(1)}" y="${compY.toFixed(1)}" width="${BAR_W.toFixed(1)}" height="${compH.toFixed(1)}" rx="6" fill="url(#compGrad)">`,
    );
    out.push(`  <title>${esc(row.id)} · competition: ${esc(row.competitionLabel)}</title>`);
    out.push(`</rect>`);
    out.push(
      `<text x="${(compX + BAR_W / 2).toFixed(1)}" y="${(compY - 6).toFixed(1)}" font-size="10" fill="${TEXT_DIM}" text-anchor="middle" dominant-baseline="middle">${esc(fit(shortValue(row.competitionLabel), 14))}</text>`,
    );

    const orbitH = h(row.orbitValue);
    const orbitX = center + 5;
    const orbitY = GRID_BOTTOM - orbitH;
    out.push(
      `<rect x="${orbitX.toFixed(1)}" y="${orbitY.toFixed(1)}" width="${BAR_W.toFixed(1)}" height="${orbitH.toFixed(1)}" rx="6" fill="url(#orbitGrad)" filter="url(#orbitShadow)">`,
    );
    out.push(`  <title>${esc(row.id)} · orbit: ${esc(row.orbitLabel)}</title>`);
    out.push(`</rect>`);
    out.push(
      `<text x="${(orbitX + BAR_W / 2).toFixed(1)}" y="${(orbitY - 6).toFixed(1)}" font-size="10" font-weight="700" fill="${ORBIT_GRAD_START}" text-anchor="middle" dominant-baseline="middle">${esc(fit(shortValue(row.orbitLabel), 14))}</text>`,
    );

    // Etiqueta del grupo: id en negrita + descripción corta debajo.
    const id = row.id;
    const rest = row.label.startsWith(`${id} · `) ? row.label.slice(id.length + 3) : row.label;
    out.push(
      `<text x="${center.toFixed(1)}" y="${GRID_BOTTOM + 20}" font-size="11" font-weight="700" fill="${TEXT}" text-anchor="middle">${esc(id)}</text>`,
    );
    out.push(
      `<text x="${center.toFixed(1)}" y="${GRID_BOTTOM + 36}" font-size="9" fill="${TEXT_DIM}" text-anchor="middle">${esc(fit(rest, Math.floor(groupW / 5.6)))}</text>`,
    );
  });

  // Footer
  out.push(
    `<text x="${PAD}" y="${H - 16}" font-size="10" fill="${TEXT_FAINT}">Columns are scaled per group (each benchmark has its own unit — height is relative to that row's max). Orbit bars rendered in white. Generated by bench/run.ts.</text>`,
  );
  out.push('</svg>');
  return out.join('\n');
}
