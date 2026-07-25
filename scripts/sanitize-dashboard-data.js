const fs = require('fs');

const inputPath = process.argv[2] || 'payload.json';
const outputPath = process.argv[3] || 'dados.json';

function readJson(path) {
  const text = fs.readFileSync(path, 'utf8');
  const parsed = JSON.parse(text);
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = String(value).trim().replace(/R\$/gi, '').replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
  if (!text) return 0;
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    text = text.replace(',', '.');
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getDeals(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.rd)) return raw.rd;
  if (Array.isArray(raw?.rd?.deals)) return raw.rd.deals;
  if (Array.isArray(raw?.deals)) return raw.deals;
  return [];
}

function keepTipoField(fields) {
  if (!Array.isArray(fields)) return [];
  const tipo = fields.find((field) =>
    normalizeName(field?.custom_field?.label || field?.label).includes('tipo')
  );
  if (!tipo?.value) return [];
  return [{
    value: tipo.value,
    custom_field: { label: tipo?.custom_field?.label || tipo?.label || 'Tipo de Projeto' },
  }];
}

function sumProducts(products) {
  if (!Array.isArray(products)) return 0;
  return products.reduce((sum, product) => sum + toNumber(product?.total), 0);
}

function sanitizeDeal(deal) {
  const productTotal = sumProducts(deal?.deal_products);
  const amountTotal = productTotal || toNumber(
    deal?.amount_unique ?? deal?.amount_total ?? deal?.amount_montly ?? deal?.value ?? deal?.valor
  );

  return {
    id: deal?.id || deal?._id || deal?.uuid || deal?.deal_id || deal?.name || '',
    name: deal?.name || deal?.deal_name || '',
    win: deal?.win === true || deal?.win === 'true' || deal?.win === 1,
    lost: deal?.lost === true || deal?.lost === 'true' || Boolean(deal?.deal_lost_reason),
    closed_at: deal?.closed_at || '',
    created_at: deal?.created_at || deal?.opened_at || deal?.createdAt || '',
    updated_at: deal?.updated_at || '',
    amount_unique: amountTotal,
    amount_total: amountTotal,
    organization: { name: deal?.organization?.name || deal?.company?.name || deal?.cliente || deal?.client || '' },
    user: { name: deal?.user?.name || deal?.responsible?.name || deal?.vendedor || deal?.owner?.name || '' },
    deal_custom_fields: keepTipoField(deal?.deal_custom_fields),
  };
}

function sanitizeMeta(meta) {
  const allowed = new Set([
    'Ano', 'ANO', 'Ano:', 'Ano_x003a_',
    'Mes', 'MES', 'Mes:', 'Mes_x003a_',
    'Mês', 'Mês:', 'Mês_x003a_',
    'Faturado', 'Faturado:', 'Faturado_x003a_', 'FATURADO',
    'Meta Minima', 'Meta Mínima', 'Meta Minima:', 'Meta Mínima:',
    'Meta Minima_x003a_', 'Meta Mínima_x003a_', 'MetaMin',
    'Meta Desejável', 'Meta Desejavel', 'Meta Desejável:', 'Meta Desejavel:',
    'Meta Desejável_x003a_', 'Meta Desejavel_x003a_', 'MetaDes',
  ]);
  return Object.fromEntries(
    Object.entries(meta || {}).filter(([key]) => allowed.has(key))
  );
}

const raw = readJson(inputPath);
const safe = {
  rd: {
    deals: getDeals(raw).map(sanitizeDeal),
  },
  metas: Array.isArray(raw?.metas)
    ? raw.metas.map(sanitizeMeta)
    : Array.isArray(raw?.rd?.metas)
      ? raw.rd.metas.map(sanitizeMeta)
      : [],
  updated_at: raw?.updated_at || raw?.atualizadoEm || new Date().toISOString(),
};

fs.writeFileSync(outputPath, `${JSON.stringify(safe)}\n`, 'utf8');
