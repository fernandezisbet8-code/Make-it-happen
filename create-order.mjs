import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 20000;
const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  },
  body: JSON.stringify(body)
});
const cleanText = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Allow': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido.' });

  const expectedOrigin = process.env.SITE_ORIGIN;
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '';
  if (!expectedOrigin || origin !== expectedOrigin) {
    return json(403, { error: 'Origen no autorizado. Revisa SITE_ORIGIN en Netlify.' });
  }
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  if (!String(contentType).toLowerCase().includes('application/json')) {
    return json(415, { error: 'Se requiere JSON.' });
  }
  if (!event.body || Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) {
    return json(413, { error: 'Pedido vacío o demasiado grande.' });
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return json(400, { error: 'Formato de pedido inválido.' }); }

  // Campo trampa básico para bots. No sustituye un sistema de limitación de tráfico.
  if (cleanText(payload.website, 200)) return json(200, { ok: true });
  const raw = payload.order;
  if (!raw || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 40) {
    return json(400, { error: 'El pedido no contiene productos válidos.' });
  }

  const customer = cleanText(raw.customer, 100);
  const phone = cleanText(raw.phone, 40);
  const delivery = cleanText(raw.delivery, 40);
  const address = cleanText(raw.address, 300);
  const payment = cleanText(raw.payment, 80);
  const notes = cleanText(raw.notes, 1000);
  if (customer.length < 2 || phone.length < 5 || !['Domicilio', 'Recoger personalmente'].includes(delivery)) {
    return json(400, { error: 'Revisa el nombre, teléfono y tipo de entrega.' });
  }
  if (delivery === 'Domicilio' && address.length < 3) return json(400, { error: 'Falta la dirección de entrega.' });

  const items = [];
  for (const item of raw.items) {
    const name = cleanText(item?.name, 120);
    const qty = Number(item?.qty);
    const price = Number(item?.price);
    if (!name || !Number.isSafeInteger(qty) || qty < 1 || qty > 100 || !Number.isSafeInteger(price) || price < 0 || price > 100000000) {
      return json(400, { error: 'Hay un producto con datos inválidos.' });
    }
    items.push({ name, qty, price });
  }
  const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  if (!Number.isSafeInteger(total) || total < 0 || total > 1000000000) return json(400, { error: 'Total inválido.' });

  try {
    const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const databaseURL = process.env.FIREBASE_DATABASE_URL;
    if (!serviceAccountText || !databaseURL) return json(503, { error: 'Faltan variables de configuración del servidor.' });

    let serviceAccount;
    try { serviceAccount = JSON.parse(serviceAccountText); }
    catch { return json(500, { error: 'La credencial del servidor no tiene formato válido.' }); }

    const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount), databaseURL });
    const orderId = randomUUID();
    const orderToSave = {
      id: orderId,
      receivedAt: new Date().toISOString(),
      customer, phone, delivery, address, payment, notes,
      items, total,
      status: 'Nuevo',
      source: 'store'
    };
    const ref = await getDatabase(app).ref('orders').push(orderToSave);
    return json(201, { ok: true, orderId: ref.key, message: 'Pedido recibido.' });
  } catch (error) {
    console.error('create-order failed:', error?.message || 'unknown error');
    return json(500, { error: 'No se pudo guardar el pedido en este momento.' });
  }
};
