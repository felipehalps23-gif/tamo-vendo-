const byId = id => document.getElementById(id);
const form = byId('service-form');
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);
const labels = { PENDING: 'Aguardando confirmação simulada', PAID: 'Pagamento simulado confirmado', FAILED: 'Pagamento simulado recusado', REFUNDED: 'Pagamento simulado reembolsado' };
let token;
let currentId;
let pending;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir. Tente novamente.');
  return data;
}

function error(message) { byId('error').hidden = false; byId('error').textContent = message; }
function clearError() { byId('error').hidden = true; }

function render(data) {
  currentId = data.id;
  sessionStorage.setItem('sandbox-request', currentId);
  form.hidden = true;
  byId('request').hidden = false;
  byId('request-id').textContent = data.id;
  byId('request-type').textContent = data.serviceType === 'CONSULTA' ? 'Consulta' : 'Abertura';
  byId('request-amount').textContent = money(data.amount);
  byId('request-status').textContent = labels[data.status] || 'Situação indisponível';
  byId('payment-id').textContent = data.paymentId;
  byId('pending-note').hidden = data.status !== 'PENDING';
  byId('result').hidden = !data.result;
  byId('result-data').replaceChildren();
  if (data.result) {
    byId('result-message').textContent = data.result.message;
    const entries = data.result.processes || [{ protocol: data.result.protocol, status: 'Abertura fictícia registrada' }];
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = `${entry.protocol}: ${entry.status}`;
      byId('result-data').append(item);
    }
  }
}

form.addEventListener('change', () => {
  const opening = form.elements.serviceType.value === 'ABERTURA';
  byId('description-group').hidden = !opening;
  byId('description').required = opening;
  byId('submit').textContent = opening ? 'Criar abertura simulada' : 'Criar consulta simulada';
});

form.addEventListener('submit', async event => {
  event.preventDefault(); clearError();
  byId('submit').disabled = true;
  const body = {
    serviceType: form.elements.serviceType.value,
    name: byId('name').value, cpf: byId('cpf').value,
    description: form.elements.serviceType.value === 'ABERTURA' ? byId('description').value : ''
  };
  const serialized = JSON.stringify(body);
  try {
    // Preserva a operação após resposta perdida/reload, sem guardar CPF ou nome.
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (!pending || pending.digest !== digest) pending = { digest, key: crypto.randomUUID() };
    sessionStorage.setItem('sandbox-pending', JSON.stringify(pending));
    const data = await api('/api/services', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: serialized });
    render(data); pending = null; sessionStorage.removeItem('sandbox-pending'); byId('request').focus();
  } catch (err) { error(err.message); }
  finally { byId('submit').disabled = false; }
});

byId('refresh').addEventListener('click', async () => {
  clearError(); byId('refresh').disabled = true;
  try { render(await api(`/api/services/${currentId}`)); }
  catch (err) { error(err.message); }
  finally { byId('refresh').disabled = false; }
});

byId('new-request').addEventListener('click', () => {
  sessionStorage.removeItem('sandbox-request'); currentId = null; pending = null;
  sessionStorage.removeItem('sandbox-pending');
  byId('request').hidden = true; form.hidden = false; clearError();
  byId('name').focus();
});

async function init() {
  try {
    token = sessionStorage.getItem('sandbox-session');
    if (!/^[a-f\d]{64}$/.test(token || '')) {
      token = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('sandbox-session', token);
    }
    const catalog = await api('/api/catalog');
    try {
      const savedPending = JSON.parse(sessionStorage.getItem('sandbox-pending'));
      if (/^[a-f\d]{64}$/.test(savedPending?.digest || '') && /^[a-f\d-]{36}$/.test(savedPending?.key || '')) pending = savedPending;
    } catch { sessionStorage.removeItem('sandbox-pending'); }
    byId('consulta-price').textContent = money(catalog.prices.CONSULTA);
    byId('abertura-price').textContent = money(catalog.prices.ABERTURA);
    form.hidden = false;
    const saved = sessionStorage.getItem('sandbox-request');
    if (saved && /^[a-f\d-]{36}$/.test(saved)) render(await api(`/api/services/${saved}`));
  } catch (err) { error(`${err.message} Verifique a conexão e recarregue a página.`); }
  finally { byId('loading').hidden = true; }
}
init();
