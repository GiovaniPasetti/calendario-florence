import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appdovTw57IDaQBrs';
const RESERVATION_TABLE = process.env.AIRTABLE_TABLE || 'Reservas_B1';
const RESIDENT_TABLE = 'Identificacao';
const COOKIE_NAME = 'florence_session';
const DEFAULT_PASSWORD = Buffer.from('SmQjMzA3KnJlcyZKb2FjYUJB', 'base64').toString('utf8');

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', ...headers,
  }});
}
function getSecret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SECRET ausente ou muito curta');
  return value;
}
function sign(value) {
  return createHmac('sha256', getSecret()).update(value).digest('base64url');
}
function credentialTag(apartment, password) {
  return sign('florence-credential-v1:' + apartment + ':' + password);
}
function readSession(request) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 2) return null;
  const expected = sign(parts[0]);
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!data.apartment || !data.credentialTag ||
        data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}
function clearCookie() {
  return { 'set-cookie': COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' };
}
function headers() {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN não configurado');
  return { Authorization: 'Bearer ' + token, 'content-type': 'application/json' };
}
function url(table, suffix = '') {
  return 'https://api.airtable.com/v0/' + encodeURIComponent(BASE_ID) + '/' +
    encodeURIComponent(table) + suffix;
}
async function listAll(table, fields, formula) {
  const records = [];
  let offset = null;
  do {
    const params = new URLSearchParams();
    fields.forEach(field => params.append('fields[]', field));
    if (formula) params.set('filterByFormula', formula);
    params.set('pageSize', '100');
    if (offset) params.set('offset', offset);
    const response = await fetch(url(table) + '?' + params, { headers: headers() });
    if (!response.ok) {
      console.error('Airtable list failed:', table, response.status, await response.text());
      throw new Error('Falha ao consultar dados no Airtable');
    }
    const payload = await response.json();
    records.push(...(payload.records || []));
    offset = payload.offset || null;
  } while (offset);
  return records;
}
async function findResident(apartment) {
  const formula = "OR({apartamento}='" + apartment + "',{apartamento}=" + apartment + ")";
  const records = await listAll(RESIDENT_TABLE, ['apartamento', 'senha'], formula);
  return records.length === 1 ? records[0] : null;
}
async function authorize(request) {
  const session = readSession(request);
  if (!session) return json({ error: 'Faça login para continuar.' }, 401, clearCookie());
  if (String(session.apartment) !== '1000') return json({ error: 'Acesso exclusivo do síndico.' }, 403);
  const resident = await findResident('1000');
  const password = String(resident && resident.fields ? resident.fields.senha || '' : '');
  if (!resident || !password || credentialTag('1000', password) !== session.credentialTag) {
    return json({ error: 'Sua sessão administrativa expirou. Entre novamente.' }, 401, clearCookie());
  }
  return null;
}
function todayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value;
  return get('year') + '/' + get('month') + '/' + get('day');
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const p = value.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  if (d.getUTCFullYear() !== p[0] || d.getUTCMonth() !== p[1] - 1 || d.getUTCDate() !== p[2]) return null;
  return p[0] + '/' + String(p[1]).padStart(2, '0') + '/' + String(p[2]).padStart(2, '0');
}
function validApartment(value) { return /^\d{3,4}$/.test(String(value || '')); }

export default async request => {
  try {
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      return json({ error: 'Método não permitido.' }, 405, { Allow: 'GET, POST, DELETE' });
    }
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origem não autorizada.' }, 403);
    }
    const denied = await authorize(request);
    if (denied) return denied;

    if (request.method === 'GET') {
      const results = await Promise.all([
        listAll(RESERVATION_TABLE, ['apartamento', 'data']),
        listAll(RESIDENT_TABLE, ['apartamento', 'senha']),
      ]);
      const reservations = results[0].map(record => ({
        id: record.id,
        apartment: String(record.fields && record.fields.apartamento != null ? record.fields.apartamento : ''),
        date: String(record.fields && record.fields.data || '').replaceAll('/', '-'),
      })).filter(item => item.id && validApartment(item.apartment) && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
        .sort((a, b) => a.date.localeCompare(b.date) || Number(a.apartment) - Number(b.apartment));
      const residents = results[1].map(record => ({
        apartment: String(record.fields && record.fields.apartamento != null ? record.fields.apartamento : ''),
        passwordReset: String(record.fields && record.fields.senha || '') === DEFAULT_PASSWORD,
      })).filter(item => validApartment(item.apartment))
        .sort((a, b) => Number(a.apartment) - Number(b.apartment));
      return json({ apartment: '1000', reservations, residents });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'Requisição inválida.' }, 400);

      if (body.action === 'create') {
        const apartment = String(body.apartment || '');
        const date = validDate(body.date);
        if (!validApartment(apartment)) return json({ error: 'Selecione um apartamento válido.' }, 400);
        if (!date) return json({ error: 'Informe uma data válida.' }, 400);
        if (date < todayKey()) return json({ error: 'Não é possível criar reserva para uma data passada.' }, 400);
        const existing = await listAll(RESERVATION_TABLE, ['data'], "{data}='" + date + "'");
        if (existing.length) return json({ error: 'Essa data já está reservada. Escolha outra.' }, 409);
        const response = await fetch(url(RESERVATION_TABLE), {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ records: [{ fields: { apartamento: Number(apartment), data: date } }] }),
        });
        if (!response.ok) {
          console.error('Airtable admin create failed:', response.status, await response.text());
          return json({ error: 'Não foi possível salvar a reserva.' }, 502);
        }
        return json({ success: true }, 201);
      }

      if (body.action === 'resetPassword') {
        const apartment = String(body.apartment || '');
        if (!validApartment(apartment) || apartment === '1000') {
          return json({ error: 'Selecione um apartamento válido para redefinir.' }, 400);
        }
        const resident = await findResident(apartment);
        if (!resident) return json({ error: 'Apartamento não encontrado no cadastro.' }, 404);
        if (String(resident.fields && resident.fields.senha || '') === DEFAULT_PASSWORD) {
          return json({ success: true, alreadyReset: true });
        }
        const response = await fetch(url(RESIDENT_TABLE, '/' + encodeURIComponent(resident.id)), {
          method: 'PATCH', headers: headers(),
          body: JSON.stringify({ fields: { senha: DEFAULT_PASSWORD } }),
        });
        if (!response.ok) {
          console.error('Airtable password reset failed:', response.status, await response.text());
          return json({ error: 'Não foi possível redefinir a senha.' }, 502);
        }
        return json({ success: true, apartment });
      }
      return json({ error: 'Ação inválida.' }, 400);
    }

    const body = await request.json().catch(() => null);
    const recordId = String(body && body.recordId || '');
    if (!/^rec[a-zA-Z0-9]{10,}$/.test(recordId)) return json({ error: 'Reserva inválida.' }, 400);
    const recordUrl = url(RESERVATION_TABLE, '/' + encodeURIComponent(recordId));
    const lookup = await fetch(recordUrl, { headers: headers() });
    if (lookup.status === 404) return json({ error: 'Reserva não encontrada.' }, 404);
    if (!lookup.ok) {
      console.error('Airtable reservation lookup failed:', lookup.status, await lookup.text());
      return json({ error: 'Não foi possível verificar a reserva.' }, 502);
    }
    const deletion = await fetch(recordUrl, { method: 'DELETE', headers: headers() });
    if (!deletion.ok) {
      console.error('Airtable reservation delete failed:', deletion.status, await deletion.text());
      return json({ error: 'Não foi possível excluir a reserva.' }, 502);
    }
    return json({ success: true });
  } catch (error) {
    console.error('Admin area error:', error);
    return json({ error: 'Ocorreu um erro ao processar a solicitação administrativa.' }, 500);
  }
};
