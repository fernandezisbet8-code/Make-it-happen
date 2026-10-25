import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

export default async (req) => {
  if (req.method === 'OPTIONS') return { statusCode: 204, headers: { 'Allow': 'POST, OPTIONS' } };
  if (req.method !== 'POST') return json(405, { error: 'Método no permitido' });

  const expectedOrigin = process.env.SITE_ORIGIN;
  const origin = req.headers.origin || '';
  if (!expectedOrigin || origin !== expectedOrigin) return json(403, { error: 'Origen no autorizado' });
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return json(415, { error: 'Se requiere JSON' });
  if (String(req.body || '').length > 20000) return json(413, { error: 'Pedido demasiado grande' });

  let payload;
  try { payload = JSON.parse(req.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
  // Campo trampa para bots. No se almacena contenido si viene rellenado.
  if (text(payload.website, 200)) return json(200, { ok: true });
  const raw = payload.order;
  if (!raw || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 40) return json(400, { error: 'Pedido inválido' });
  const customer = text(raw.customer, 100);
  const phone = text(raw.phone, 40);
  const delivery = text(raw.delivery, 40);
  const address = text(raw.address, 300);
  if (customer.length < 2 || phone.length < 5 || !['Domicilio', 'Recoger personalmente'].includes(delivery)) return json(400, { error: 'Faltan datos del pedido' });
  if (delivery === 'Domicilio' && address.length < 3) return json(400, { error: 'Falta la dirección de entrega' });

  const items = [];
  for (const item of raw.items) {
    const name = text(item?.name, 120);
    const qty = Number(item?.qty);
    const price = Number(item?.price);
    if (!name || !Number.isInteger(qty) || qty < 1 || qty > 100 || !Number.isFinite(price) || price < 0 || price > 100000000) return json(400, { error: 'Producto inválido' });
    items.push({ name, qty, price });
  }
  const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  if (!Number.isFinite(total) || total > 1000000000) return json(400, { error: 'Total inválido' });

  try {
    const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const databaseURL = process.env.FIREBASE_DATABASE_URL;
    if (!serviceAccountText || !databaseURL) return json(503, { error: 'Servidor sin configurar' });
    const serviceAccount = JSON.parse(serviceAccountText);
    const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount), databaseURL });
    const orderToSave = {
      id: text(raw.id, 40) || String(Date.now()),
      receivedAt: new Date().toISOString(),
      customer, phone, delivery, address,
      payment: text(raw.payment, 80),
      notes: text(raw.notes, 1000),
      items, total,
      status: 'Nuevo',
      source: 'store'
    };
    const ref = await getDatabase(app).ref('orders').push(orderToSave);
    return json(201, { ok: true, orderId: ref.key });
  } catch (error) {
    console.error('create-order failed:', error?.message || 'unknown error');
    return json(500, { error: 'No se pudo guardar el pedido' });
  }
};
