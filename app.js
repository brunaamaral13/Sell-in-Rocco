"use strict";

const MONTHS = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const MONTHS_SHORT = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
const MONTH_INDEX = {
  janeiro: 0, jan: 0, fevereiro: 1, fev: 1, marco: 2, mar: 2, abril: 3, abr: 3,
  maio: 4, mai: 4, junho: 5, jun: 5, julho: 6, jul: 6, agosto: 7, ago: 7,
  setembro: 8, set: 8, outubro: 9, out: 9, novembro: 10, nov: 10, dezembro: 11, dez: 11
};
const DIMS = [
  { key: "vendedor", label: "Vendedor" },
  { key: "rede", label: "Rede" },
  { key: "tipo", label: "Tipo" },
  { key: "uf", label: "UF" }
];
const COHORTS = {
  up: "Cresceram",
  down: "Caíram",
  low: "Abaixo de R$ 1.500",
  idle: "Sem faturar",
  new: "Novos",
  stuck: "Saldo consignado",
  replenish: "Sem saldo consignado"
};
const LOW_TICKET = 1500;
const IDLE_GAP = 3;
const NEW_YEAR = 2026;
const STOCK_STUCK = 200;
const STOCK_LOW = 100;
const CONSIGN_TYPES = new Set(["LIVRARIA", "DISTRIBUIDOR", "HUDSON"]);
const SLICE_COLORS = ["#b5191a","#e0a106","#0f7a5a","#1b2a4a","#7c4d9e","#d46a2e","#3d7ea6","#5b8c5a","#b08968","#8d3b4c","#4c6e8a","#c47b9b","#3f6f8f","#a33b4a"];
const ALERT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.8 20h18.4L12 3.5z"/><path d="M12 10v4.2"/><path d="M12 16.8v.6"/></svg>`;

const state = {
  clients: [],
  meta: null,
  fileName: "",
  filters: { vendedor: new Set(), rede: new Set(), tipo: new Set(), uf: new Set() },
  cohort: null,
  listTab: "up",
  period: null,
  analysisYear: null,
  hiddenYears: new Set(),
  clientId: null,
  donutDim: "tipo",
  view: "mensal",
  search: "",
  searchPick: null,
  hideZeros: true,
  rankSort: { key: "revenue", dir: "desc" },
  openMenu: null,
  options: null
};

const charts = {
  t0: 0,
  p: 1,
  hot: [],
  hover: null,
  trendFrom: null,
  trendTo: null,
  trendSig: "",
  donutFrom: null,
  donutTo: null,
  donutSig: "",
  colorOf: new Map()
};

const $ = (id) => document.getElementById(id);
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t) => 1 - Math.pow(1 - t, 3);

function norm(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function parseStock(raw) {
  const text = String(raw ?? "").replace(/\u00a0/g, " ").trim().replace(/R\$/gi, "").replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ""));
  return Math.round(parseMoney(raw));
}

function parseMoney(raw) {
  if (raw == null) return 0;
  const text = String(raw).replace(/\u00a0/g, " ").trim();
  if (!/[0-9]/.test(text)) return 0;
  let s = text.replace(/R\$/gi, "").replace(/\s/g, "");
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()]/g, "").replace(/^-/, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function decodeSmart(buffer) {
  const bytes = new Uint8Array(buffer);
  let start = 0;
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) start = 3;
  const utf8 = new TextDecoder("utf-8").decode(bytes.subarray(start));
  const head = utf8.slice(0, 2500);
  const latin = new TextDecoder("windows-1252").decode(bytes);
  const score = (text) => ["janeiro", "fevereiro", "marco", "abril", "cliente", "vendedor"]
    .reduce((n, word) => n + (norm(text.slice(0, 4000)).includes(word) ? 1 : 0), 0);
  if (head.includes("\uFFFD")) return latin;
  return score(latin) > score(utf8) ? latin : utf8;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(norm);
    const hasCliente = cells.some((c) => c === "cliente" || c === "razao social");
    const hasVend = cells.some((c) => c.includes("vendedor") || c === "rca" || c.includes("representante"));
    if (hasCliente && (hasVend || cells.some((c) => c.includes("cod")))) return i;
  }
  return -1;
}

function colIndex(header, pred) {
  return header.findIndex((cell) => pred(norm(cell)));
}

function parseWorkbook(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) throw new Error("O arquivo está vazio.");
  const delim = ((lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length) ? ";" : ",";
  const rows = lines.map((line) => splitCsvLine(line, delim));
  const headerAt = findHeader(rows);
  if (headerAt < 0) throw new Error("Não encontrei o cabeçalho com a coluna CLIENTE.");
  const header = rows[headerAt];

  let monthRow = null;
  let best = 0;
  for (let i = 0; i < headerAt; i++) {
    let score = 0;
    for (const cell of rows[i]) {
      const n = norm(cell);
      if (MONTH_INDEX[n] != null || n.startsWith("total")) score++;
    }
    if (score > best) { best = score; monthRow = rows[i]; }
  }

  const colNome = colIndex(header, (n) => n === "cliente" || n === "razao social" || n === "nome");
  const colCod = colIndex(header, (n) => (n.includes("cod") && n.includes("cliente")) || n === "codigo" || n === "cod" || n === "cod cliente");
  const colTipo = colIndex(header, (n) => n === "tipo");
  const colRede = colIndex(header, (n) => n === "rede");
  const colUf = colIndex(header, (n) => n === "uf");
  const colVend = colIndex(header, (n) => n.includes("vendedor") || n === "rca" || n.includes("representante"));
  const colCnpj = colIndex(header, (n) => n.includes("cnpj"));
  const colSaldo = colIndex(header, (n) => n.includes("saldo") && n.includes("consign"));
  if (colNome < 0) throw new Error("Não encontrei a coluna CLIENTE.");

  const idCols = [colNome, colCod, colTipo, colRede, colUf, colVend, colCnpj].filter((i) => i >= 0);
  let cursor = Math.max(...idCols) + 1;
  const groups = [];
  while (cursor + 2 < header.length) {
    const ya = header[cursor].trim();
    const yb = header[cursor + 1].trim();
    if (/^\d{4}$/.test(ya) && /^\d{4}$/.test(yb)) {
      groups.push({
        ya: Number(ya),
        yb: Number(yb),
        colA: cursor,
        colB: cursor + 1,
        monthLabel: monthRow ? (monthRow[cursor] || "") : ""
      });
      cursor += 3;
    } else cursor++;
  }
  if (!groups.length) throw new Error("Não encontrei os meses com os anos lado a lado.");

  let monthCursor = 0;
  let lastPair = "";
  for (const group of groups) {
    const pair = group.ya + "-" + group.yb;
    if (pair !== lastPair) { monthCursor = 0; lastPair = pair; }
    const label = norm(group.monthLabel);
    if (label.startsWith("total")) { group.skip = true; continue; }
    if (MONTH_INDEX[label] != null) {
      group.month = MONTH_INDEX[label];
      monthCursor = group.month + 1;
    } else if (!label && monthCursor < 12) group.month = monthCursor++;
    else group.skip = true;
  }

  const yearSet = new Set();
  const slots = {};
  for (const group of groups) {
    if (group.skip || group.month == null) continue;
    yearSet.add(group.ya);
    yearSet.add(group.yb);
    if (!slots[group.ya]) slots[group.ya] = Array(12).fill(-1);
    if (!slots[group.yb]) slots[group.yb] = Array(12).fill(-1);
    slots[group.ya][group.month] = group.colA;
    slots[group.yb][group.month] = group.colB;
  }
  const years = [...yearSet].sort((a, b) => a - b);
  if (!years.length) throw new Error("Não encontrei anos numéricos no cabeçalho.");

  const cleanDim = (value, empty) => {
    const s = String(value || "").trim();
    if (!s || s === "-" || s === "–" || s === "—") return empty;
    return s;
  };

  const map = new Map();
  for (let r = headerAt + 1; r < rows.length; r++) {
    const cells = rows[r];
    const nome = (cells[colNome] || "").trim().replace(/\s+/g, " ");
    if (!nome) continue;
    const cod = colCod >= 0 ? (cells[colCod] || "").trim() : "";
    const id = cod || nome;
    let client = map.get(id);
    if (!client) {
      client = {
        id,
        cod,
        nome,
        tipo: colTipo >= 0 ? cleanDim(cells[colTipo], "Sem tipo") : "Sem tipo",
        rede: colRede >= 0 ? cleanDim(cells[colRede], "Sem rede") : "Sem rede",
        uf: colUf >= 0 ? cleanDim(cells[colUf], "Sem UF") : "Sem UF",
        vendedor: colVend >= 0 ? cleanDim(cells[colVend], "Sem vendedor") : "Sem vendedor",
        cnpj: colCnpj >= 0 ? (cells[colCnpj] || "").trim() : "",
        saldo: colSaldo >= 0 ? parseStock(cells[colSaldo]) : 0,
        series: {}
      };
      for (const year of years) client.series[year] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      map.set(id, client);
    } else if (colSaldo >= 0) {
      client.saldo += parseStock(cells[colSaldo]);
    }
    for (const year of years) {
      const cols = slots[year];
      for (let m = 0; m < 12; m++) {
        const col = cols[m];
        if (col >= 0 && col < cells.length) client.series[year][m] += parseMoney(cells[col]);
      }
    }
  }

  const clients = [...map.values()];
  if (!clients.length) throw new Error("Nenhum cliente com nome foi encontrado no arquivo.");

  const lastMonth = {};
  for (const year of years) {
    lastMonth[year] = -1;
    for (let m = 11; m >= 0; m--) {
      let sum = 0;
      for (const client of clients) sum += Math.abs(client.series[year][m]);
      if (sum > 0.5) { lastMonth[year] = m; break; }
    }
  }
  const maxYear = years[years.length - 1];
  const anchor = maxYear * 12 + Math.max(0, lastMonth[maxYear]);
  for (const client of clients) {
    let last = null;
    for (let i = years.length - 1; i >= 0 && last == null; i--) {
      const year = years[i];
      const lim = lastMonth[year];
      for (let m = lim; m >= 0; m--) {
        if (client.series[year][m] > 0.5) { last = year * 12 + m; break; }
      }
    }
    let first = null;
    for (let i = 0; i < years.length && first == null; i++) {
      const year = years[i];
      for (let m = 0; m < 12; m++) {
        if (client.series[year][m] > 0.5) { first = year * 12 + m; break; }
      }
    }
    client.last = last;
    client.first = first;
    client.idleGap = last == null ? null : anchor - last;
    client.idle = client.idleGap != null && client.idleGap > IDLE_GAP;
    client.novo = first != null && Math.floor(first / 12) >= NEW_YEAR;
    client.lastLabel = last == null ? "sem histórico" : MONTHS[last % 12] + "/" + Math.floor(last / 12);
    client.firstLabel = first == null ? "sem histórico" : MONTHS[first % 12] + "/" + Math.floor(first / 12);
  }

  const options = {};
  for (const dim of DIMS) {
    const counts = new Map();
    for (const client of clients) counts.set(client[dim.key], (counts.get(client[dim.key]) || 0) + 1);
    options[dim.key] = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
  }

  return {
    clients,
    meta: { years, lastMonth, maxYear, anchorLabel: MONTHS[Math.max(0, lastMonth[maxYear])] + "/" + maxYear },
    options
  };
}

function formatFull(n) {
  return Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function moneyParts(n) {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  const num = (div) => (v / div).toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  if (v >= 1e9) {
    const qty = v / 1e9;
    return { value: sign + "R$ " + num(1e9), unit: Math.abs(qty - 1) < 0.05 ? "bilhão" : "bilhões" };
  }
  if (v >= 1e6) {
    const qty = v / 1e6;
    return { value: sign + "R$ " + num(1e6), unit: Math.abs(qty - 1) < 0.05 ? "milhão" : "milhões" };
  }
  if (v >= 1e3) return { value: sign + "R$ " + num(1e3), unit: "mil" };
  return { value: sign + formatFull(v), unit: "" };
}
function formatMoneyWords(n) {
  const parts = moneyParts(n);
  return parts.unit ? parts.value + " " + parts.unit : parts.value;
}
function tweenMoney(id, value) {
  if (value == null || !Number.isFinite(value)) {
    $(id).textContent = "—";
    $(id)._v = 0;
    return;
  }
  tween($(id), value, formatMoneyWords);
}
function formatCompact(n) {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  const num = (div, digits) => (v / div).toLocaleString("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  if (v >= 1e9) return sign + "R$ " + num(1e9, 1) + " bi";
  if (v >= 1e6) return sign + "R$ " + num(1e6, 1) + " mi";
  if (v >= 1e3) return sign + "R$ " + num(1e3, 1) + " mil";
  return sign + formatFull(v);
}
function formatAxis(n) {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 1e9) return sign + (v / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " bi";
  if (v >= 1e6) return sign + (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
  if (v >= 1e3) return sign + (v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
  return sign + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}
function formatPct(n) {
  if (n == null || !Number.isFinite(n)) return "novo";
  const sign = n > 0 ? "+" : "";
  return sign + n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}
function rangeLabel(m0, m1) {
  if (m0 === m1) return MONTHS[m0];
  if (m0 === 0 && m1 === 11) return "ano fechado";
  return MONTHS[m0] + " a " + MONTHS[m1];
}
function yearColor(year) {
  const max = state.meta.maxYear;
  if (year === max) return "#b5191a";
  if (year === max - 1) return "#1f4e79";
  if (year === max - 2) return "#7d92ab";
  if (year === max - 3) return "#c4b6a6";
  const idx = state.meta.years.indexOf(year);
  return SLICE_COLORS[(idx + 3) % SLICE_COLORS.length];
}
function colorFor(label) {
  if (!charts.colorOf.has(label)) charts.colorOf.set(label, SLICE_COLORS[charts.colorOf.size % SLICE_COLORS.length]);
  return charts.colorOf.get(label);
}

function windowOf() {
  const year = state.analysisYear;
  const cut = state.meta.lastMonth[year];
  const safeCut = cut < 0 ? 0 : cut;
  if (state.period?.type === "month") {
    const m = state.period.index;
    return { year, m0: m, m1: m, kind: "month" };
  }
  if (state.period?.type === "quarter") {
    const q = state.period.index;
    return { year, m0: q * 3, m1: q * 3 + 2, kind: "quarter", q };
  }
  return { year, m0: 0, m1: safeCut, kind: "ytd" };
}

function metrics(client, year, m0, m1) {
  const curArr = client.series[year];
  const prevArr = client.series[year - 1];
  let cur = 0;
  let prev = 0;
  for (let m = m0; m <= m1; m++) {
    if (curArr) cur += curArr[m] || 0;
    if (prevArr) prev += prevArr[m] || 0;
  }
  const months = m1 - m0 + 1;
  const pct = prev > 0.5 ? ((cur - prev) / prev) * 100 : (cur > 0.5 ? null : 0);
  return { cur, prev, months, avg: months ? cur / months : 0, delta: cur - prev, pct };
}
function isUp(met) { return met.cur > met.prev + 0.5 && met.cur > 0.5; }
function isDown(met) { return met.prev > 0.5 && met.cur < met.prev - 0.5; }
function isLow(met) { return met.cur > 0.5 && met.avg < LOW_TICKET; }
function isStuck(client) { return client.idle && client.saldo >= STOCK_STUCK; }
function isReplenish(client, met) {
  return isDown(met) && client.saldo < STOCK_LOW && (client.saldo > 0.5 || CONSIGN_TYPES.has(client.tipo));
}
function matchCohort(client, win, cohort) {
  if (cohort === "idle") return client.idle;
  if (cohort === "new") return client.novo;
  if (cohort === "stuck") return isStuck(client);
  const met = metrics(client, win.year, win.m0, win.m1);
  if (cohort === "up") return isUp(met);
  if (cohort === "down") return isDown(met);
  if (cohort === "low") return isLow(met);
  if (cohort === "replenish") return isReplenish(client, met);
  return true;
}
function formatBooks(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v).toLocaleString("pt-BR");
  return (v < 0 ? "-" : "") + abs + (Math.abs(v) === 1 ? " livro" : " livros");
}
function formatConsigned(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v).toLocaleString("pt-BR");
  const word = Math.abs(v) === 1 ? "livro consignado" : "livros consignados";
  return (v < 0 ? "-" : "") + abs + " " + word;
}
function inDim(client, except) {
  for (const dim of DIMS) {
    if (dim.key === except) continue;
    const set = state.filters[dim.key];
    if (set.size && !set.has(client[dim.key])) return false;
  }
  return true;
}

function population(opts) {
  const win = opts.win;
  const except = opts.except || null;
  const useCohort = opts.cohort !== false;
  const useFocus = !!opts.focus;
  let list = state.clients.filter((client) => inDim(client, except));
  if (useCohort && state.cohort) list = list.filter((client) => matchCohort(client, win, state.cohort));
  if (useFocus && state.clientId) {
    const one = list.find((client) => client.id === state.clientId);
    if (one) return [one];
  }
  return list;
}

function hasActiveFilters() {
  if (state.period || state.cohort || state.clientId || state.search.trim()) return true;
  return DIMS.some((dim) => state.filters[dim.key].size);
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function tween(el, value, format) {
  if (value == null || !Number.isFinite(value)) {
    el.textContent = "—";
    el._v = 0;
    return;
  }
  if (reduceMotion()) {
    el._v = value;
    el.textContent = format(value);
    return;
  }
  const from = Number.isFinite(el._v) ? el._v : 0;
  const t0 = performance.now();
  el._t0 = t0;
  const step = (now) => {
    if (el._t0 !== t0) return;
    const t = Math.min(1, (now - t0) / 680);
    el.textContent = format(from + (value - from) * ease(t));
    if (t < 1) requestAnimationFrame(step);
    else el._v = value;
  };
  requestAnimationFrame(step);
}

function sumSeries(list, year, length) {
  const out = Array(length).fill(0);
  const series = String(year);
  for (const client of list) {
    const arr = client.series[series];
    if (!arr) continue;
    for (let i = 0; i < length; i++) out[i] += arr[i] || 0;
  }
  return out;
}

function buildTrendModel(list, win) {
  let years = state.meta.years.filter((year) => !state.hiddenYears.has(year));
  if (!years.length) years = [state.analysisYear];
  const anchor = state.meta.lastMonth[state.meta.maxYear];
  if (state.view === "anual") {
    const m1 = win.kind === "ytd" ? state.meta.lastMonth[state.analysisYear] : win.m1;
    const m0 = win.kind === "ytd" ? 0 : win.m0;
    const usable = state.meta.years.filter((year) => !state.hiddenYears.has(year));
    const shown = usable.length ? usable : [state.analysisYear];
    return {
      view: "anual",
      kind: "single",
      categories: shown.map((year) => ({
        label: String(year),
        allow: true,
        year,
        muted: false
      })),
      series: [{
        year: state.analysisYear,
        color: "#b5191a",
        values: shown.map((year) => {
          let total = 0;
          for (const client of list) total += metrics(client, year, 0, Math.max(0, m1 < m0 ? m1 : m1)).cur;
          return total;
        })
      }],
      selected: shown.indexOf(state.analysisYear),
      note: "Cada barra soma " + rangeLabel(0, Math.max(0, m1)) + " do respectivo ano."
    };
  }

  if (state.view === "trimestral") {
    const categories = [0, 1, 2, 3].map((q) => ({
      label: "T" + (q + 1),
      allow: q * 3 <= anchor,
      muted: q * 3 > anchor,
      quarter: q
    }));
    const series = years.map((year) => {
      const values = [0, 1, 2, 3].map((q) => {
        let total = 0;
        const arr = sumSeries(list, year, 12);
        for (let m = q * 3; m < q * 3 + 3; m++) total += arr[m];
        return total;
      });
      return { year, color: yearColor(year), values, emphasis: year === state.analysisYear };
    });
    return {
      view: "trimestral",
      kind: "group",
      categories,
      series,
      selected: state.period?.type === "quarter" ? state.period.index : null,
      note: "Trimestres somados. Meses ainda sem movimento na base não entram no recorte."
    };
  }

  const categories = MONTHS_SHORT.map((label, index) => ({
    label,
    allow: index <= anchor,
    muted: index > anchor,
    month: index
  }));
  const series = years.map((year) => {
    const raw = sumSeries(list, year, 12);
    let values = raw;
    if (state.view === "acumulada") {
      const last = state.meta.lastMonth[year];
      let running = 0;
      values = raw.map((value, month) => {
        if (month > last) return null;
        running += value;
        return running;
      });
    }
    return { year, color: yearColor(year), values, emphasis: year === state.analysisYear };
  });
  return {
    view: state.view,
    kind: state.view === "acumulada" ? "line" : "group",
    categories,
    series,
    selected: state.period?.type === "month" ? state.period.index : null,
    note: state.view === "acumulada"
      ? "Soma corrida mês a mês. A linha do ano corrente para no último mês com movimento."
      : "Barras lado a lado por ano. Clique num mês para usá-lo nos indicadores."
  };
}

function buildDonut(list, win) {
  const dim = state.donutDim;
  const buckets = new Map();
  for (const client of list) {
    const key = client[dim];
    buckets.set(key, (buckets.get(key) || 0) + metrics(client, win.year, win.m0, win.m1).cur);
  }
  let slices = [...buckets.entries()]
    .map(([key, value]) => ({ key, value }))
    .filter((slice) => slice.value > 0.5)
    .sort((a, b) => b.value - a.value);
  const limit = dim === "tipo" || dim === "vendedor" ? 16 : 8;
  if (slices.length > limit) {
    const head = slices.slice(0, limit);
    const rest = slices.slice(limit).reduce((sum, slice) => sum + slice.value, 0);
    slices = head;
    if (rest > 0.5) slices.push({ key: "Outros", value: rest, outros: true });
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return {
    slices: slices.map((slice) => ({ ...slice, color: slice.outros ? "#c5c8d2" : colorFor(dim + ":" + slice.key) })),
    total
  };
}

function paintAll(progress) {
  paintTrend(progress);
  paintDonut(progress);
}

function prep(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 4 || h < 4) return null;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function roundTop(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function lerp(a, b, t) {
  if (b == null) return null;
  const from = a == null ? 0 : a;
  return from + (b - from) * t;
}

function paintTrend(progress) {
  const canvas = $("trend");
  const surface = prep(canvas);
  charts.hot = [];
  if (!surface || !charts.trendTo) return;
  const { ctx, w, h } = surface;
  const model = charts.trendTo;
  const from = charts.trendFrom;
  const pad = { l: 54, r: 12, t: 16, b: 28 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const values = [];
  model.series.forEach((series, sIndex) => {
    series.values.forEach((value, cIndex) => {
      const prev = from && from.series[sIndex] ? from.series[sIndex].values[cIndex] : 0;
      const current = lerp(prev, value, progress);
      if (current != null) values.push(current);
    });
  });
  const max = niceMax(Math.max(0, ...values, 0));
  ctx.font = "12px Outfit, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let tick = 0; tick <= 4; tick++) {
    const value = (max * tick) / 4;
    const y = pad.t + plotH - (value / max) * plotH;
    ctx.strokeStyle = "#e7e9f0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = "#8b909c";
    ctx.fillText(formatAxis(value), pad.l - 8, y);
  }

  const n = model.categories.length || 1;
  const groupW = plotW / n;
  const hover = charts.hover && charts.hover.chart === "trend" ? charts.hover.index : null;

  model.categories.forEach((category, index) => {
    const x = pad.l + index * groupW;
    if (model.selected === index || hover === index) {
      ctx.fillStyle = model.selected === index ? "rgba(210,60,72,0.08)" : "rgba(27,42,74,0.04)";
      ctx.fillRect(x + 2, pad.t, groupW - 4, plotH);
    }
    charts.hot.push({ x, y: pad.t, w: groupW, h: plotH, index, allow: category.allow !== false });
    ctx.fillStyle = category.muted ? "#c5c8d0" : "#5c6370";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(category.label, x + groupW / 2, pad.t + plotH + 8);
  });

  if (model.kind === "line") {
    model.series.forEach((series, sIndex) => {
      const prev = from && from.series[sIndex] ? from.series[sIndex].values : [];
      ctx.beginPath();
      let started = false;
      const points = [];
      series.values.forEach((value, index) => {
        const current = lerp(prev[index], value, progress);
        if (current == null) return;
        const x = pad.l + index * groupW + groupW / 2;
        const y = pad.t + plotH - (current / max) * plotH;
        points.push([x, y]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = series.color;
      ctx.lineWidth = series.emphasis ? 2.6 : 1.7;
      ctx.stroke();
      if (series.emphasis && points.length) {
        ctx.beginPath();
        points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.lineTo(points[points.length - 1][0], pad.t + plotH);
        ctx.lineTo(points[0][0], pad.t + plotH);
        ctx.closePath();
        ctx.fillStyle = series.color + "22";
        ctx.fill();
      }
      points.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, series.emphasis ? 3.4 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = series.color;
        ctx.fill();
      });
    });
    return;
  }

  const seriesCount = model.series.length || 1;
  const gap = model.kind === "single" ? 0 : 3;
  const barW = Math.max(3, Math.min(model.kind === "single" ? 42 : 16, (groupW * 0.72 - gap * (seriesCount - 1)) / seriesCount));
  const totalW = seriesCount * barW + (seriesCount - 1) * gap;

  model.series.forEach((series, sIndex) => {
    const prev = from && from.series[sIndex] ? from.series[sIndex].values : [];
    series.values.forEach((value, index) => {
      const current = lerp(prev[index], value, progress);
      if (current == null || current <= 0) return;
      const gh = pad.l + index * groupW;
      const x = gh + (groupW - totalW) / 2 + sIndex * (barW + gap);
      const bh = Math.max(2, (current / max) * plotH);
      const y = pad.t + plotH - bh;
      const color = model.kind === "single" ? yearColor(model.categories[index].year) : series.color;
      ctx.fillStyle = color;
      roundTop(ctx, x, y, barW, bh, 4);
      ctx.fill();
    });
  });
}

function paintDonut(progress) {
  const canvas = $("donut");
  const surface = prep(canvas);
  if (!surface || !charts.donutTo) return;
  const { ctx, w, h } = surface;
  const slices = charts.donutTo.slices.map((slice) => {
    const prev = (charts.donutFrom || []).find((item) => item.key === slice.key);
    const from = prev ? prev.value : 0;
    return { ...slice, value: from + (slice.value - from) * progress };
  });
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.34;
  ctx.lineWidth = Math.min(w, h) * 0.12;
  if (total <= 0) {
    charts.donutAngles = null;
    ctx.strokeStyle = "#eceff5";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const selected = state.filters[state.donutDim];
  let angle = -Math.PI / 2;
  const gap = slices.length > 1 ? 0.018 : 0;
  const hot = charts.hover && charts.hover.chart === "donut" ? charts.hover.key : null;
  slices.forEach((slice) => {
    const sweep = (Math.max(0, slice.value) / total) * Math.PI * 2;
    const draw = Math.max(0, sweep - gap);
    const faded = selected.size && !selected.has(slice.key) && !slice.outros;
    ctx.strokeStyle = slice.color;
    ctx.globalAlpha = faded ? 0.28 : 1;
    ctx.lineWidth = hot === slice.key ? Math.min(w, h) * 0.135 : Math.min(w, h) * 0.12;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle, angle + draw);
    ctx.stroke();
    slice._a0 = angle;
    slice._a1 = angle + sweep;
    angle += sweep;
  });
  ctx.globalAlpha = 1;
  charts.donutAngles = { cx, cy, radius, slices };
}

function scheduleAnim() {
  charts.t0 = performance.now();
  if (reduceMotion()) {
    charts.p = 1;
    paintAll(1);
    return;
  }
  const step = (now) => {
    charts.p = ease(Math.min(1, (now - charts.t0) / 720));
    paintAll(charts.p);
    if (charts.p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updateCharts(listForTrend, listForDonut, win) {
  const trend = buildTrendModel(listForTrend, win);
  const donut = buildDonut(listForDonut, win);
  const trendSig = JSON.stringify({
    view: trend.view,
    categories: trend.categories.map((category) => category.label),
    series: trend.series.map((series) => [series.year, series.values.map((value) => Math.round(value || 0))])
  });
  const donutSig = state.donutDim + "|" + donut.slices.map((slice) => slice.key + ":" + Math.round(slice.value)).join("|");
  let changed = false;
  if (trendSig !== charts.trendSig) {
    const same = charts.trendTo && charts.trendTo.view === trend.view
      && charts.trendTo.categories.length === trend.categories.length
      && charts.trendTo.series.length === trend.series.length;
    charts.trendFrom = same ? charts.trendTo : {
      series: trend.series.map((series) => ({ values: series.values.map((value) => (value == null ? null : 0)) }))
    };
    charts.trendTo = trend;
    charts.trendSig = trendSig;
    changed = true;
  } else if (charts.trendTo) {
    charts.trendTo.selected = trend.selected;
  }
  if (donutSig !== charts.donutSig) {
    charts.donutFrom = charts.donutTo ? charts.donutTo.slices : [];
    charts.donutTo = donut;
    charts.donutSig = donutSig;
    changed = true;
  }
  $("chartTitle").textContent = {
    mensal: "Evolução mensal",
    trimestral: "Evolução trimestral",
    anual: "Evolução anual",
    acumulada: "Evolução acumulada"
  }[state.view];
  const focus = state.clientId ? state.clients.find((client) => client.id === state.clientId) : null;
  $("chartSub").textContent = (focus ? focus.nome + " · " : "") + trend.note;
  $("chartSummary").textContent = $("chartTitle").textContent + ". " + trend.note;
  if (changed) scheduleAnim();
  else paintAll(charts.p || 1);

  const legend = $("yearLegend");
  legend.innerHTML = state.meta.years.map((year) => {
    const off = state.hiddenYears.has(year) ? " is-off" : "";
    return `<button type="button" class="${off}" data-year="${year}"><i style="background:${yearColor(year)}"></i>${year}</button>`;
  }).join("");

  const selected = state.filters[state.donutDim];
  const total = donut.total;
  $("donutTotal").textContent = total ? formatCompact(total) : "—";
  $("donutCaption").textContent = String(win.year);
  $("donutSub").textContent = "Participação por " + DIMS.find((dim) => dim.key === state.donutDim).label.toLowerCase() + " · " + rangeLabel(win.m0, win.m1);
  $("donutLegend").innerHTML = donut.slices.length
    ? donut.slices.map((slice) => {
      const pct = total ? (slice.value / total) * 100 : 0;
      const dimmed = selected.size && !selected.has(slice.key) && !slice.outros ? " is-dim" : "";
      return `<button type="button" class="slice${dimmed}" data-slice="${esc(slice.key)}" data-outros="${slice.outros ? "1" : ""}">
        <i style="background:${slice.color}"></i>
        <span>${esc(slice.key)}<small>${formatCompact(slice.value)}</small></span>
        <b>${pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</b>
      </button>`;
    }).join("")
    : `<p class="empty-row">Sem faturamento neste recorte.</p>`;
}

function renderKpis(win, list) {
  let cur = 0;
  let prev = 0;
  let active = 0;
  for (const client of list) {
    const met = metrics(client, win.year, win.m0, win.m1);
    cur += met.cur;
    prev += met.prev;
    if (met.cur > 0.5) active++;
  }
  const pct = prev > 0.5 ? ((cur - prev) / prev) * 100 : (cur > 0.5 ? null : 0);
  const months = win.m1 - win.m0 + 1;
  const ticket = active ? cur / active / months : null;
  $("kpiRevenueLabel").textContent = "Faturamento " + win.year;
  tweenMoney("kpiRevenue", cur);
  const range = rangeLabel(win.m0, win.m1);
  const pctLabel = pct == null ? "novo" : formatPct(pct);
  const pctClass = pct == null || pct > 0.05 ? "var-up" : pct < -0.05 ? "var-down" : "";
  if (prev > 0.5) {
    $("kpiRevenueSub").innerHTML = range + "<br>ano anterior " + formatMoneyWords(prev) + ' · <b class="' + pctClass + '">' + pctLabel + "</b>";
  } else if (cur > 0.5) {
    $("kpiRevenueSub").innerHTML = range + '<br><b class="var-up">novo</b>';
  } else {
    $("kpiRevenueSub").textContent = range;
  }
  const card = $("kpiVarCard");
  card.classList.remove("is-up", "is-down", "is-flat", "kpi-green");
  if (pct == null) {
    card.classList.add("is-up");
    $("kpiVar").textContent = "novo";
    $("kpiVar")._v = 0;
    $("kpiVar")._t0 = null;
  } else if (Math.abs(pct) < 0.05 && cur <= 0.5) {
    card.classList.add("is-flat");
    tween($("kpiVar"), 0, (value) => formatPct(value));
  } else if (pct < 0) {
    card.classList.add("is-down");
    tween($("kpiVar"), pct, formatPct);
  } else {
    card.classList.add("is-up");
    tween($("kpiVar"), pct, formatPct);
  }
  $("kpiVarSub").textContent = prev > 0.5 ? (cur - prev >= 0 ? "+" : "") + formatMoneyWords(cur - prev) + " contra " + (win.year - 1) : "sem base em " + (win.year - 1);
  tween($("kpiActive"), active, (value) => Math.round(value).toLocaleString("pt-BR"));
  $("kpiActiveSub").textContent = "de " + list.length.toLocaleString("pt-BR") + " no recorte";
  if (ticket == null) tweenMoney("kpiTicket", null);
  else tweenMoney("kpiTicket", ticket);
  $("kpiTicketSub").textContent = "média de " + months + (months > 1 ? " meses" : " mês");
}

function renderInsights(win) {
  const base = state.clients.filter((client) => inDim(client));
  const counts = { up: 0, down: 0, low: 0, idle: 0, new: 0, stuck: 0, replenish: 0 };
  for (const client of base) {
    const met = metrics(client, win.year, win.m0, win.m1);
    if (isUp(met)) counts.up++;
    if (isDown(met)) counts.down++;
    if (isLow(met)) counts.low++;
    if (client.idle) counts.idle++;
    if (client.novo) counts.new++;
    if (isStuck(client)) counts.stuck++;
    if (isReplenish(client, met)) counts.replenish++;
  }
  for (const key of Object.keys(counts)) {
    tween($("n-" + key), counts[key], (value) => Math.round(value).toLocaleString("pt-BR"));
    const card = document.querySelector(`.insight[data-cohort="${key}"]`);
    card.setAttribute("aria-pressed", state.cohort === key ? "true" : "false");
    const tab = document.querySelector(`#alertTabs [data-tab="${key}"]`);
    tab.setAttribute("aria-pressed", state.listTab === key ? "true" : "false");
  }
  return base;
}

function renderAlerts(win, base) {
  const rows = [];
  for (const client of base) {
    const met = metrics(client, win.year, win.m0, win.m1);
    const flags = {
      up: isUp(met), down: isDown(met), low: isLow(met), idle: client.idle, new: client.novo,
      stuck: isStuck(client), replenish: isReplenish(client, met), met
    };
    if (flags[state.listTab]) rows.push({ client, ...flags });
  }
  rows.sort((a, b) => {
    if (state.listTab === "up") return b.met.delta - a.met.delta;
    if (state.listTab === "down" || state.listTab === "replenish") return a.met.delta - b.met.delta;
    if (state.listTab === "low") return a.met.avg - b.met.avg;
    if (state.listTab === "new") return b.met.cur - a.met.cur || (a.client.first || 0) - (b.client.first || 0);
    if (state.listTab === "stuck") return b.client.saldo - a.client.saldo;
    return (b.client.saldo - a.client.saldo) || ((b.client.idleGap || 0) - (a.client.idleGap || 0));
  });
  const shown = rows.slice(0, 80);
  $("alertList").innerHTML = shown.length ? shown.map((row, index) => {
    const client = row.client;
    let pill = "";
    if (state.listTab === "up" || state.listTab === "down") pill = `<span class="pill ${state.listTab}">${formatPct(row.met.pct)}</span>`;
    else if (state.listTab === "low") pill = `<span class="pill low">${formatCompact(row.met.avg)}/mês</span>`;
    else if (state.listTab === "new") pill = `<span class="pill new">desde ${esc(row.client.firstLabel)}</span>`;
    else if (state.listTab === "stuck") pill = `<span class="pill stuck">${formatBooks(client.saldo)}</span>`;
    else if (state.listTab === "replenish") pill = `<span class="pill replenish">${client.saldo > 0.5 ? formatBooks(client.saldo) : "sem saldo"}</span>`;
    else if (client.saldo > 0.5) pill = `<span class="pill idle-alert" title="Sem faturar e ainda com livros consignados">${ALERT_ICON}${row.client.idleGap} meses · ${formatConsigned(client.saldo)}</span>`;
    else pill = `<span class="pill idle">${row.client.idleGap} meses · ${formatConsigned(0)}</span>`;
    const stockBit = state.listTab === "stuck" || state.listTab === "replenish" || state.listTab === "idle"
      ? ""
      : (client.saldo > 0.5 ? ` · ${formatBooks(client.saldo)}` : "");
    return `<button type="button" class="alert-row${state.clientId === client.id ? " is-focus" : ""}" data-id="${esc(client.id)}" style="animation-delay:${Math.min(index, 12) * 25}ms">
      <span class="who"><strong>${esc(client.nome)}</strong><small>${esc(client.vendedor)} · ${esc(client.uf)} · ${esc(client.tipo)}${stockBit}</small></span>
      ${pill}
    </button>`;
  }).join("") : `<p class="empty-row">Ninguém neste recorte.</p>`;
  if (rows.length > shown.length) {
    $("alertList").insertAdjacentHTML("beforeend", `<p class="empty-row">Mostrando ${shown.length} de ${rows.length}. Refine o recorte para ver o restante no ranking.</p>`);
  }
  const idleAnchor = "último mês da base: " + state.meta.anchorLabel;
  const range = rangeLabel(win.m0, win.m1) + " de " + win.year;
  const how = {
    new: "Primeira venda em " + NEW_YEAR + " ou depois, sem faturamento antes disso. Valores de " + range + ".",
    stuck: "Sem faturar há mais de 3 meses e com " + STOCK_STUCK.toLocaleString("pt-BR") + " livros ou mais consignados. " + idleAnchor + ".",
    replenish: "Faturamento caiu em " + range + " e o saldo consignado está abaixo de " + STOCK_LOW.toLocaleString("pt-BR") + " livros. Pode ser falta de reposição."
  };
  $("howRange").textContent = how[state.listTab] || ("Intervalo: " + range + " contra " + (win.year - 1) + ". " + idleAnchor + ".");
}

function codeHits(query) {
  const digits = String(query || "").replace(/\D/g, "");
  const compact = String(query || "").replace(/\s/g, "");
  if (digits.length < 2 || digits.length !== compact.length || !state.clients) return [];
  const hits = state.clients.filter((client) => String(client.cod || "").replace(/\D/g, "").includes(digits));
  hits.sort((a, b) => {
    const rank = (client) => {
      const cod = String(client.cod || "").replace(/\D/g, "");
      if (cod === digits) return 0;
      if (cod.startsWith(digits)) return 1;
      return 2;
    };
    const diff = rank(a) - rank(b);
    if (diff) return diff;
    return String(a.cod).length - String(b.cod).length || a.nome.localeCompare(b.nome, "pt-BR");
  });
  return hits;
}

function renderSearchHit() {
  const box = $("searchHit");
  const input = $("q");
  if (!box || !input) return;
  if (state.searchPick) {
    box.hidden = true;
    box.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    return;
  }
  const hits = codeHits(state.search);
  if (!hits.length) {
    box.hidden = true;
    box.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    return;
  }
  const shown = hits.slice(0, 6);
  box.hidden = false;
  input.setAttribute("aria-expanded", "true");
  box.innerHTML = shown.map((client) => `
    <button type="button" data-id="${esc(client.id)}">
      <b>${esc(client.nome)}</b>
      <small>Cód. ${esc(client.cod || "—")}${client.vendedor ? " · " + esc(client.vendedor) : ""}</small>
    </button>`).join("")
    + (hits.length > shown.length ? `<p class="search-more">Mais ${hits.length - shown.length} ${hits.length - shown.length === 1 ? "cliente" : "clientes"}. Continue o código.</p>` : "");
}

function renderRanking(win) {
  const list = state.searchPick
    ? state.clients.filter((client) => client.id === state.searchPick)
    : population({ win, focus: false });
  const q = norm(state.search);
  const qDigits = q.replace(/\D/g, "");
  let rows = list.map((client) => {
    const met = metrics(client, win.year, win.m0, win.m1);
    return { client, met, low: isLow(met) };
  });
  if (q) {
    rows = rows.filter((row) => {
      const client = row.client;
      if (norm(client.nome).includes(q) || norm(client.id).includes(q) || norm(client.vendedor).includes(q)) return true;
      return qDigits.length >= 3 && client.cnpj.replace(/\D/g, "").includes(qDigits);
    });
  }
  const books = rows.reduce((sum, row) => sum + row.client.saldo, 0);
  if (!state.searchPick && state.cohort !== "idle" && state.cohort !== "new" && state.cohort !== "stuck" && state.hideZeros) {
    rows = rows.filter((row) => row.met.cur > 0.5 || row.met.prev > 0.5 || (state.cohort === "low" && row.low));
  }
  const dir = state.rankSort.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (state.rankSort.key === "name") return a.client.nome.localeCompare(b.client.nome, "pt-BR") * dir;
    if (state.rankSort.key === "saldo") return (a.client.saldo - b.client.saldo) * dir;
    if (state.rankSort.key === "pct") {
      const av = a.met.pct == null ? 1e9 : a.met.pct;
      const bv = b.met.pct == null ? 1e9 : b.met.pct;
      return (av - bv) * dir;
    }
    return (a.met.cur - b.met.cur) * dir;
  });
  const max = rows.reduce((m, row) => Math.max(m, row.met.cur), 0);
  const focusName = state.clientId ? (state.clients.find((client) => client.id === state.clientId) || {}).nome : "";
  const vend = state.filters.vendedor;
  $("rankTitle").textContent = vend.size === 1 ? "Ranking · " + [...vend][0] : "Ranking de clientes";
  $("rankCount").textContent = rows.length.toLocaleString("pt-BR") + " clientes · " + formatBooks(books)
    + " · " + rangeLabel(win.m0, win.m1) + "/" + win.year;
  document.querySelectorAll("[data-sort]").forEach((button) => {
    const on = button.dataset.sort === state.rankSort.key;
    button.classList.toggle("is-sort", on);
    const labels = { name: "Cliente", revenue: "Faturamento", pct: "Variação", saldo: "Saldo" };
    button.textContent = labels[button.dataset.sort] || button.dataset.sort;
    if (on) button.textContent += state.rankSort.dir === "asc" ? " ↑" : " ↓";
  });
  $("rankBody").innerHTML = rows.length ? rows.map((row, index) => {
    const client = row.client;
    const medal = index < 3 ? ` medal-${index + 1}` : "";
    const pctClass = row.met.pct == null ? "up" : row.met.pct > 0.05 ? "up" : row.met.pct < -0.05 ? "down" : "flat";
    const width = max > 0 ? Math.max(2, (row.met.cur / max) * 100) : 0;
    const stuck = isStuck(client);
    const replenish = isReplenish(client, row.met);
    const saldoClass = stuck ? "is-stuck" : replenish ? "is-replenish" : client.saldo > 0.5 ? "" : "is-zero";
    const tags = (client.novo ? `<i class="tag tag-new" title="Sem faturamento antes de ${NEW_YEAR}. Primeira venda: ${esc(client.firstLabel)}">novo</i>` : "")
      + (stuck ? `<i class="tag tag-stuck" title="Sem faturar há ${client.idleGap} meses com ${formatBooks(client.saldo)} consignados">saldo consignado</i>` : "")
      + (replenish ? `<i class="tag tag-replenish" title="Faturamento caiu e o saldo consignado está abaixo de ${STOCK_LOW} livros">sem saldo consignado</i>` : "")
      + (row.low ? `<i class="tag tag-low" title="Média mensal abaixo de R$ 1.500">≤1,5 mil</i>` : "")
      + (client.idle && !stuck ? `<i class="tag tag-idle" title="Sem faturar há ${client.idleGap} meses">+3m</i>` : "");
    return `<tr data-id="${esc(client.id)}" class="${state.clientId === client.id ? "is-focus" : ""}">
      <td class="col-pos${medal}">${index + 1}</td>
      <td><div class="cname"><span>${esc(client.nome)}</span>${tags}</div><div class="cmeta">${esc(client.tipo)} · ${esc(client.uf)}</div></td>
      <td class="col-vend">${esc(client.vendedor)}</td>
      <td class="num"><div class="rev"><span style="width:${width}%"></span></div><b>${formatFull(row.met.cur)}</b></td>
      <td class="num"><span class="var ${pctClass}">${formatPct(row.met.pct)}</span></td>
      <td class="num saldo ${saldoClass}" title="${formatBooks(client.saldo)} consignados">${Math.round(client.saldo).toLocaleString("pt-BR")}</td>
    </tr>`;
  }).join("") : `<tr><td class="empty-row" colspan="6">Nenhum cliente neste recorte.</td></tr>`;
}

function renderDrawer(win) {
  const drawer = $("drawer");
  const client = state.clients.find((item) => item.id === state.clientId);
  if (!client) {
    drawer.classList.remove("is-in");
    drawer.setAttribute("aria-hidden", "true");
    return;
  }
  const met = metrics(client, win.year, win.m0, win.m1);
  const year = win.year;
  const prev = year - 1;
  const cur = client.series[year] || [];
  const old = client.series[prev] || [];
  const max = Math.max(1, ...cur, ...old);
  const points = (arr, stroke) => {
    const cmds = arr.map((value, index) => {
      const x = (index / 11) * 360;
      const y = 68 - (Math.max(0, value) / max) * 60;
      return (index ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
    return `<path d="${cmds}" stroke="${stroke}"/>`;
  };
  const badges = [];
  const stuck = isStuck(client);
  const replenish = isReplenish(client, met);
  if (client.novo) badges.push(`<span class="pill new">novo · desde ${esc(client.firstLabel)}</span>`);
  if (isUp(met)) badges.push(`<span class="pill up">cresceu</span>`);
  if (isDown(met)) badges.push(`<span class="pill down">caiu</span>`);
  if (isLow(met)) badges.push(`<span class="pill low">média ${formatCompact(met.avg)}/mês</span>`);
  if (client.idle && client.saldo > 0.5) badges.push(`<span class="pill idle-alert">${ALERT_ICON}${client.idleGap} meses · ${formatConsigned(client.saldo)}</span>`);
  else if (client.idle) badges.push(`<span class="pill idle">${client.idleGap} meses · ${formatConsigned(0)}</span>`);
  if (stuck) badges.push(`<span class="pill stuck">saldo consignado</span>`);
  if (replenish) badges.push(`<span class="pill replenish">sem saldo consignado</span>`);
  let stockNote = "Saldo consignado atual, em livros.";
  if (stuck) stockNote = "Sem faturar há " + client.idleGap + " meses com saldo alto. Esse estoque não deveria ficar parado.";
  else if (replenish) stockNote = "O faturamento caiu e o saldo está baixo. Vale checar se deixou de repor o que vendeu.";
  else if (client.saldo < 0.5) stockNote = "Sem saldo consignado neste momento.";
  const stockClass = stuck ? " is-stuck" : replenish ? " is-replenish" : "";
  const revClass = met.pct == null || met.pct > 0.05 ? " is-up" : met.pct < -0.05 ? " is-down" : "";
  const rows = MONTHS_SHORT.map((label, index) => {
    const a = cur[index] || 0;
    const b = old[index] || 0;
    const pct = b > 0.5 ? ((a - b) / b) * 100 : (a > 0.5 ? null : 0);
    const muted = index > state.meta.lastMonth[state.meta.maxYear] ? ` style="color:#b0b4be"` : "";
    return `<tr${muted}><td>${label}</td><td>${formatFull(b)}</td><td>${formatFull(a)}</td><td>${formatPct(pct)}</td></tr>`;
  }).join("");
  $("drawerBody").innerHTML = `
    <div class="drawer-top">
      <h3>${esc(client.nome)}</h3>
      <button type="button" class="x" id="closeDrawer" aria-label="Fechar">×</button>
    </div>
    <div class="meta-grid">
      <span>Cód. ${esc(client.cod || "—")}</span>
      <span>${esc(client.vendedor)}</span>
      <span>${esc(client.rede)}</span>
      <span>${esc(client.tipo)}</span>
      <span>${esc(client.uf)}</span>
      <span>${esc(client.cnpj || "sem CNPJ")}</span>
    </div>
    <div class="rev-callout${revClass}">
      <span>Faturamento · ${rangeLabel(win.m0, win.m1)}/${year}</span>
      <b>${formatFull(met.cur)}</b>
      <p>${prev}: ${formatFull(met.prev)} · ${formatPct(met.pct)}</p>
    </div>
    <div class="stock-callout stock-quiet${stockClass}">
      <span>Saldo consignado · ${formatBooks(client.saldo)}</span>
      <p>${stockNote}</p>
    </div>
    <div class="badges">${badges.join("") || `<span class="pill">estável</span>`}</div>
    <svg class="spark" viewBox="0 0 360 72" aria-hidden="true">${points(old, "#7d92ab")}${points(cur, "#b5191a")}</svg>
    <table class="month-table">
      <thead><tr><th>Mês</th><th>${prev}</th><th>${year}</th><th>Var.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="cmeta" style="margin-top:10px">Última venda: ${esc(client.lastLabel)}.</p>`;
  drawer.classList.add("is-in");
  drawer.setAttribute("aria-hidden", "false");
}

function renderChips() {
  const chips = [];
  for (const dim of DIMS) {
    for (const value of state.filters[dim.key]) {
      chips.push({ kind: "dim", dim: dim.key, value, label: dim.label + ": " + value });
    }
  }
  if (state.period?.type === "month") chips.push({ kind: "period", label: MONTHS[state.period.index] });
  if (state.period?.type === "quarter") chips.push({ kind: "period", label: "T" + (state.period.index + 1) });
  if (state.cohort) chips.push({ kind: "cohort", label: COHORTS[state.cohort] });
  if (state.clientId) {
    const client = state.clients.find((item) => item.id === state.clientId);
    if (client) chips.push({ kind: "client", label: client.nome });
  }
  const box = $("chips");
  box.hidden = chips.length === 0;
  box.innerHTML = chips.map((chip, index) =>
    `<span class="chip">${esc(chip.label)}<button type="button" data-chip="${index}" aria-label="Remover ${esc(chip.label)}">×</button></span>`
  ).join("");
  box._chips = chips;
  $("btnClear").hidden = !hasActiveFilters();
}

function syncFilterUI() {
  document.querySelectorAll(".menu").forEach((menu) => {
    const dim = menu.dataset.dim;
    const set = state.filters[dim];
    const open = state.openMenu === dim;
    menu.classList.toggle("is-open", open);
    menu.classList.toggle("is-on", set.size > 0);
    const panel = menu.querySelector(".menu-panel");
    panel.hidden = !open;
    menu.querySelector(".menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
    const label = menu.querySelector(".menu-v");
    label.textContent = !set.size ? "Todos" : set.size === 1 ? [...set][0] : set.size + " selecionados";
    menu.querySelectorAll("input[type=checkbox]").forEach((input) => {
      input.checked = set.has(input.dataset.filterValue);
    });
  });
}

function renderYears() {
  $("yearSwitch").innerHTML = state.meta.years.map((year) =>
    `<button type="button" data-year="${year}" aria-pressed="${year === state.analysisYear ? "true" : "false"}">${year}</button>`
  ).join("");
  document.querySelectorAll("#viewSeg button").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.view === state.view ? "true" : "false");
  });
  document.querySelectorAll("#dimSeg button").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.dim === state.donutDim ? "true" : "false");
  });
}

function renderAll() {
  if (!state.meta) return;
  const win = windowOf();
  const kpiList = population({ win, focus: true });
  const trendList = population({ win, focus: true });
  const donutList = population({ win, focus: false, except: state.donutDim });
  const base = renderInsights(win);
  renderKpis(win, kpiList);
  renderAlerts(win, base);
  renderRanking(win);
  renderSearchHit();
  renderDrawer(win);
  renderChips();
  syncFilterUI();
  renderYears();
  updateCharts(trendList, donutList, win);
  const client = state.clientId ? state.clients.find((item) => item.id === state.clientId) : null;
  const inView = population({ win, focus: false }).length;
  const total = state.clients.length;
  $("subtitle").textContent = (inView === total ? total.toLocaleString("pt-BR") + " clientes" : inView.toLocaleString("pt-BR") + " de " + total.toLocaleString("pt-BR") + " clientes")
    + " · " + state.analysisYear + " · " + rangeLabel(win.m0, win.m1)
    + (client ? " · foco em " + client.nome : "");
}

function buildFilters() {
  const bar = $("filterBar");
  bar.innerHTML = DIMS.map((dim) => {
    const options = state.options[dim.key].map(([value, count]) =>
      `<label class="opt" data-label="${esc(value)}"><input type="checkbox" data-filter-dim="${dim.key}" data-filter-value="${esc(value)}"><span>${esc(value)}</span><em>${count}</em></label>`
    ).join("");
    return `<div class="menu" data-dim="${dim.key}">
      <button type="button" class="menu-btn" aria-expanded="false">
        <span class="menu-k">${dim.label}</span>
        <span class="menu-v">Todos</span>
        <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="menu-panel" hidden>
        <input type="search" placeholder="Filtrar lista" aria-label="Filtrar ${dim.label}">
        <div class="menu-actions"><button type="button" data-act="clear">Mostrar todos</button></div>
        <div class="menu-list">${options}</div>
      </div>
    </div>`;
  }).join("");

  bar.querySelectorAll(".menu-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const dim = button.closest(".menu").dataset.dim;
      state.openMenu = state.openMenu === dim ? null : dim;
      syncFilterUI();
      if (state.openMenu) {
        const search = button.closest(".menu").querySelector("input[type=search]");
        search.value = "";
        search.dispatchEvent(new Event("input"));
        search.focus();
      }
    });
  });
  bar.querySelectorAll(".menu-panel").forEach((panel) => panel.addEventListener("click", (event) => event.stopPropagation()));
  bar.querySelectorAll("input[type=search]").forEach((input) => {
    input.addEventListener("input", () => {
      const q = norm(input.value);
      input.closest(".menu").querySelectorAll(".opt").forEach((opt) => {
        opt.hidden = q.length > 0 && !norm(opt.dataset.label).includes(q);
      });
    });
  });
}

function resetViewState() {
  state.filters = { vendedor: new Set(), rede: new Set(), tipo: new Set(), uf: new Set() };
  state.cohort = null;
  state.listTab = "up";
  state.period = null;
  state.hiddenYears = new Set();
  state.clientId = null;
  state.search = "";
  state.searchPick = null;
  state.analysisYear = state.meta.maxYear;
  state.rankSort = { key: "revenue", dir: "desc" };
  state.openMenu = null;
  $("q").value = "";
  charts.colorOf = new Map();
  charts.trendSig = "";
  charts.donutSig = "";
  charts.trendTo = null;
  charts.donutTo = null;
}

function showLoading(text) {
  $("loadingText").textContent = text;
  $("loading").hidden = false;
}
function hideLoading() { $("loading").hidden = true; }

function showDash() {
  $("empty").hidden = true;
  const dash = $("dash");
  dash.hidden = false;
  dash.classList.remove("play");
  void dash.offsetWidth;
  dash.classList.add("play");
  setTimeout(() => dash.classList.remove("play"), 1200);
  $("q").disabled = false;
  $("fileLabel").textContent = "Trocar CSV";
  $("fileMeta").textContent = state.fileName;
  $("sideFoot").textContent = state.clients.length.toLocaleString("pt-BR")
    + " clientes · movimento até " + state.meta.anchorLabel;
}

function showEmpty(message) {
  $("dash").hidden = true;
  $("empty").hidden = false;
  $("q").disabled = true;
  if (message) {
    $("error").hidden = false;
    $("error").textContent = message;
  }
}

function ingest(buffer, name) {
  const parsed = parseWorkbook(decodeSmart(buffer));
  state.clients = parsed.clients;
  state.meta = parsed.meta;
  state.options = parsed.options;
  state.fileName = name;
  resetViewState();
  buildFilters();
  hideLoading();
  showDash();
  requestAnimationFrame(() => renderAll());
}

function handleFile(file) {
  if (!file) return;
  showLoading("Lendo " + file.name + "…");
  $("error").hidden = true;
  const reader = new FileReader();
  reader.onload = () => {
    try { ingest(reader.result, file.name); }
    catch (error) {
      hideLoading();
      showEmpty(error.message || "Não foi possível ler esse CSV.");
    }
  };
  reader.onerror = () => {
    hideLoading();
    showEmpty("Falha ao ler o arquivo.");
  };
  reader.readAsArrayBuffer(file);
}

function toggleClient(id) {
  state.clientId = state.clientId === id ? null : id;
  renderAll();
}

function pickPeriod(type, index) {
  const anchor = state.meta.lastMonth[state.meta.maxYear];
  if (type === "month" && index > anchor) return;
  if (type === "quarter" && index * 3 > anchor) return;
  if (state.period && state.period.type === type && state.period.index === index) state.period = null;
  else state.period = { type, index };
  renderAll();
}

function trendTooltip(index) {
  const model = charts.trendTo;
  if (!model) return "";
  const category = model.categories[index];
  const rows = model.series.map((series, sIndex) => {
    const value = series.values[index];
    const label = model.kind === "single" ? category.label : String(series.year);
    const color = model.kind === "single" ? yearColor(category.year) : series.color;
    const shown = value == null ? "—" : formatFull(value);
    const prev = model.kind === "single"
      ? (index > 0 ? series.values[index - 1] : null)
      : (sIndex > 0 ? model.series[sIndex - 1].values[index] : null);
    let pct = "";
    if (value != null && prev != null) {
      const change = prev > 0.5 ? ((value - prev) / prev) * 100 : (value > 0.5 ? null : 0);
      const tone = change == null || change > 0.05 ? "up" : change < -0.05 ? "down" : "";
      pct = `<em class="${tone}">${formatPct(change)}</em>`;
    }
    return `<div class="row"><span><i class="dot" style="background:${color}"></i>${label}</span><b>${shown}${pct}</b></div>`;
  }).join("");
  const extra = category.allow === false ? `<div>Mês ainda sem movimento na base.</div>` : "";
  return `<b>${category.label}</b>${extra}${rows}`;
}

function bind() {
  $("pick").addEventListener("click", () => $("file").click());
  $("btnFile").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", () => {
    const file = $("file").files && $("file").files[0];
    $("file").value = "";
    if (file) handleFile(file);
  });

  let dragDepth = 0;
  document.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth++;
    document.body.classList.add("is-drag");
  });
  document.addEventListener("dragleave", () => {
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove("is-drag");
    }
  });
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("is-drag");
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  document.addEventListener("click", (event) => {
    if (state.openMenu && !event.target.closest(".menu")) {
      state.openMenu = null;
      syncFilterUI();
    }
  });

  $("filterBar").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-filter-dim]");
    if (!input) return;
    const set = state.filters[input.dataset.filterDim];
    if (input.checked) set.add(input.dataset.filterValue);
    else set.delete(input.dataset.filterValue);
    renderAll();
  });
  $("filterBar").addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]");
    if (!act) return;
    const dim = act.closest(".menu").dataset.dim;
    state.filters[dim].clear();
    renderAll();
  });

  $("btnClear").addEventListener("click", () => {
    for (const dim of DIMS) state.filters[dim.key].clear();
    state.period = null;
    state.cohort = null;
    state.clientId = null;
    state.search = "";
    state.searchPick = null;
    $("q").value = "";
    state.hiddenYears.clear();
    renderAll();
  });

  $("chips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-chip]");
    if (!button) return;
    const chip = $("chips")._chips[Number(button.dataset.chip)];
    if (!chip) return;
    if (chip.kind === "dim") state.filters[chip.dim].delete(chip.value);
    if (chip.kind === "period") state.period = null;
    if (chip.kind === "cohort") state.cohort = null;
    if (chip.kind === "client") state.clientId = null;
    renderAll();
  });

  $("insights").addEventListener("click", (event) => {
    const button = event.target.closest("[data-cohort]");
    if (!button) return;
    const key = button.dataset.cohort;
    state.cohort = state.cohort === key ? null : key;
    state.listTab = key;
    renderAll();
    $("sec-alertas").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "nearest" });
  });

  $("alertTabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.listTab = button.dataset.tab;
    if (state.cohort) state.cohort = state.listTab;
    renderAll();
  });

  $("alertList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    toggleClient(row.dataset.id);
  });
  bindClientCodeTip($("alertList"));
  bindClientCodeTip($("rankBody"));

  $("viewSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    const view = button.dataset.view;
    if (view === "trimestral" && state.period?.type !== "quarter") state.period = null;
    if (view === "anual") state.period = null;
    if ((view === "mensal" || view === "acumulada") && state.period?.type === "quarter") state.period = null;
    state.view = view;
    renderAll();
  });

  $("dimSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-dim]");
    if (!button) return;
    state.donutDim = button.dataset.dim;
    renderAll();
  });

  $("yearSwitch").addEventListener("click", (event) => {
    const button = event.target.closest("[data-year]");
    if (!button) return;
    state.analysisYear = Number(button.dataset.year);
    renderAll();
  });

  $("yearLegend").addEventListener("click", (event) => {
    const button = event.target.closest("[data-year]");
    if (!button) return;
    const year = Number(button.dataset.year);
    if (state.hiddenYears.has(year)) state.hiddenYears.delete(year);
    else {
      const visible = state.meta.years.filter((item) => !state.hiddenYears.has(item));
      if (visible.length <= 1) return;
      state.hiddenYears.add(year);
    }
    renderAll();
  });

  $("q").addEventListener("input", () => {
    state.search = $("q").value;
    state.searchPick = null;
    if (state.meta) {
      renderRanking(windowOf());
      renderSearchHit();
    }
    $("btnClear").hidden = !hasActiveFilters();
  });

  $("searchHit").addEventListener("click", (event) => {
    const button = event.target.closest("[data-id]");
    if (!button || !state.clients) return;
    const client = state.clients.find((item) => item.id === button.dataset.id);
    if (!client) return;
    state.clientId = client.id;
    state.searchPick = client.id;
    state.search = client.cod || client.nome;
    $("q").value = state.search;
    renderAll();
    const row = document.querySelector("#rankBody tr.is-focus");
    if (row) row.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    $("btnClear").hidden = !hasActiveFilters();
  });

  $("hideZeros").addEventListener("change", () => {
    state.hideZeros = $("hideZeros").checked;
    renderAll();
  });

  document.querySelector(".rank-table thead").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    const key = button.dataset.sort;
    if (state.rankSort.key === key) state.rankSort.dir = state.rankSort.dir === "asc" ? "desc" : "asc";
    else state.rankSort = { key, dir: key === "name" ? "asc" : "desc" };
    renderAll();
  });

  $("rankBody").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    toggleClient(row.dataset.id);
  });

  $("donutLegend").addEventListener("click", (event) => {
    const button = event.target.closest("[data-slice]");
    if (!button || button.dataset.outros === "1") return;
    const set = state.filters[state.donutDim];
    const value = button.dataset.slice;
    if (set.has(value)) set.delete(value);
    else set.add(value);
    renderAll();
  });
  $("donutLegend").addEventListener("mousemove", (event) => {
    const button = event.target.closest("[data-slice]");
    charts.hover = button ? { chart: "donut", key: button.dataset.slice } : null;
    paintDonut(charts.p || 1);
  });
  $("donutLegend").addEventListener("mouseleave", () => {
    charts.hover = null;
    paintDonut(charts.p || 1);
  });

  const trend = $("trend");
  trend.addEventListener("pointermove", (event) => {
    const hit = charts.hot.find((spot) => event.offsetX >= spot.x && event.offsetX <= spot.x + spot.w && event.offsetY >= spot.y && event.offsetY <= spot.y + spot.h);
    charts.hover = hit ? { chart: "trend", index: hit.index } : null;
    trend.style.cursor = hit ? (hit.allow ? "pointer" : "not-allowed") : "default";
    paintTrend(charts.p || 1);
    if (!hit) { hideTip("chart"); return; }
    showTip(event.clientX, event.clientY, trendTooltip(hit.index), "chart");
  });
  trend.addEventListener("pointerleave", () => {
    charts.hover = null;
    hideTip("chart");
    paintTrend(charts.p || 1);
  });
  trend.addEventListener("click", (event) => {
    const hit = charts.hot.find((spot) => event.offsetX >= spot.x && event.offsetX <= spot.x + spot.w && event.offsetY >= spot.y && event.offsetY <= spot.y + spot.h);
    if (!hit) return;
    const category = charts.trendTo.categories[hit.index];
    if (state.view === "anual") {
      state.analysisYear = category.year;
      renderAll();
      return;
    }
    if (state.view === "trimestral") pickPeriod("quarter", category.quarter);
    else pickPeriod("month", category.month);
  });

  const donut = $("donut");
  donut.addEventListener("pointermove", (event) => {
    const found = donutHit(event.offsetX, event.offsetY);
    charts.hover = found ? { chart: "donut", key: found.key } : null;
    donut.style.cursor = found && !found.outros ? "pointer" : "default";
    paintDonut(charts.p || 1);
    if (!found) { hideTip("chart"); return; }
    showTip(event.clientX, event.clientY, `<b>${esc(found.key)}</b><div>${formatFull(found.value)}</div>`, "chart");
  });
  donut.addEventListener("pointerleave", () => {
    charts.hover = null;
    hideTip("chart");
    paintDonut(charts.p || 1);
  });
  donut.addEventListener("click", (event) => {
    const found = donutHit(event.offsetX, event.offsetY);
    if (!found || found.outros) return;
    const set = state.filters[state.donutDim];
    if (set.has(found.key)) set.delete(found.key);
    else set.add(found.key);
    renderAll();
  });

  $("drawer").addEventListener("click", (event) => {
    if (event.target.closest("#closeDrawer")) {
      state.clientId = null;
      renderAll();
    }
  });

  document.querySelectorAll(".nav button").forEach((button) => {
    button.addEventListener("click", () => {
      const section = $(button.dataset.goto);
      if (section) section.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
      document.querySelectorAll(".nav button").forEach((item) => item.classList.toggle("is-active", item === button));
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.openMenu) { state.openMenu = null; syncFilterUI(); return; }
    if (state.clientId) { state.clientId = null; renderAll(); }
  });

  const resize = () => { if (state.meta) paintAll(charts.p || 1); };
  window.addEventListener("resize", resize);
  if (window.ResizeObserver) {
    new ResizeObserver(resize).observe($("trend").parentElement);
    new ResizeObserver(resize).observe($("donut").parentElement);
  }
}

function donutHit(x, y) {
  const info = charts.donutAngles;
  if (!info) return null;
  const dx = x - info.cx;
  const dy = y - info.cy;
  const dist = Math.hypot(dx, dy);
  if (Math.abs(dist - info.radius) > info.radius * 0.42) return null;
  let angle = Math.atan2(dy, dx);
  if (angle < -Math.PI / 2) angle += Math.PI * 2;
  return info.slices.find((slice) => angle >= slice._a0 && angle < slice._a1) || null;
}

function hideTip(kind) {
  const tip = $("tooltip");
  if (kind && tip.dataset.kind !== kind) return;
  tip.hidden = true;
  tip.dataset.kind = "";
}

function showTip(x, y, html, kind) {
  $("tooltip").dataset.kind = kind || "";
  placeTip(x, y, html);
}

function bindClientCodeTip(root) {
  root.addEventListener("pointermove", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) { hideTip("client"); return; }
    const client = state.clients.find((item) => item.id === row.dataset.id);
    if (!client) { hideTip("client"); return; }
    const cod = client.cod ? esc(client.cod) : "sem código";
    showTip(event.clientX, event.clientY, `<span class="tip-k">Código</span><b>${cod}</b>`, "client");
  });
  root.addEventListener("pointerleave", () => hideTip("client"));
}

function placeTip(x, y, html) {
  const tip = $("tooltip");
  tip.innerHTML = html;
  tip.hidden = false;
  tip.style.left = "0px";
  tip.style.top = "0px";
  const rect = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 12;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 12;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, top) + "px";
}

async function boot() {
  bind();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (state.meta) paintAll(charts.p || 1); });
  }
  showLoading("Procurando a base na pasta…");
  try {
    const response = await fetch(encodeURI("Faturamento sell-in acumulado.csv"), { cache: "no-store" });
    if (!response.ok) throw new Error("sem arquivo");
    ingest(await response.arrayBuffer(), "Faturamento sell-in acumulado.csv");
  } catch (error) {
    hideLoading();
    if (!state.clients.length) showEmpty(error && error.message && !/sem arquivo|Failed|NetworkError|fetch/i.test(error.message) ? error.message : "");
  }
}

boot();
