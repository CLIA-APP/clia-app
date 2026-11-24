// =============================================================================
// Aplicativo CLIA — app.js
// Uma página só (PWA). Supabase para banco e login; IndexedDB para funcionar
// sem internet; fila de sincronização que esvazia sozinha quando o sinal volta.
// =============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CONFIG = {
  url: 'https://qojifretsdskzdpnuazy.supabase.co',
  chave: 'sb_publishable_u5pmUEjeIA1rnyQbYkW7KQ_3bLtWgKn',   // chave pública: segura no app
  versao: '0.2.1',
};
const sb = createClient(CONFIG.url, CONFIG.chave);

// ----------------------------------------------------------------- utilidades
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid = () => crypto.randomUUID();
const hoje = () => new Date().toISOString().slice(0, 10);
const fmtData = (d) => d ? d.split('-').reverse().join('/') : '—';
const idade = (nasc) => {
  if (!nasc) return '';
  const n = new Date(nasc), h = new Date();
  let m = (h.getFullYear() - n.getFullYear()) * 12 + h.getMonth() - n.getMonth();
  if (h.getDate() < n.getDate()) m--;
  return `${Math.floor(m / 12)}a ${m % 12}m`;
};
// campo de data em três partes (dia / mês / ano) — muito mais rápido que o calendário do navegador
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
function campoData(nome, valor) {
  const [a, m, d] = (valor || '').split('-').map(Number);
  const op = (n, sel, txt) => `<option value="${n}" ${n === sel ? 'selected' : ''}>${txt}</option>`;
  return `<div class="data3" data-nome="${nome}">
    <select data-p="d" aria-label="dia"><option value="">dia</option>${Array.from({length:31},(_,i)=>op(i+1,d,i+1)).join('')}</select>
    <select data-p="m" aria-label="mês"><option value="">mês</option>${MESES.map((n,i)=>op(i+1,m,n)).join('')}</select>
    <input data-p="a" type="number" inputmode="numeric" placeholder="ano" min="1900" max="2100" value="${a || ''}" aria-label="ano">
  </div>`;
}
// lê os campos data3 de um form e devolve {nome: 'AAAA-MM-DD' | null}
function lerDatas(form) {
  const r = {};
  form.querySelectorAll('.data3').forEach(el => {
    const d = el.querySelector('[data-p=d]').value, m = el.querySelector('[data-p=m]').value, a = el.querySelector('[data-p=a]').value;
    r[el.dataset.nome] = (d && m && a) ? `${a}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null;
  });
  return r;
}

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms);
}
const dispositivo = localStorage.getItem('clia.dispositivo') || (() => {
  const d = uuid(); localStorage.setItem('clia.dispositivo', d); return d; })();

// ----------------------------------------------------------------- IndexedDB
const DB = (() => {
  let db;
  const abrir = () => db ? Promise.resolve(db) : new Promise((ok, erro) => {
    const r = indexedDB.open('clia', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('cache');                     // chave -> dados (leitura offline)
      d.createObjectStore('fila', { keyPath: 'id' });   // gravações pendentes
    };
    r.onsuccess = () => { db = r.result; ok(db); };
    r.onerror = () => erro(r.error);
  });
  const tx = async (loja, modo, fn) => {
    const d = await abrir();
    return new Promise((ok, erro) => {
      const t = d.transaction(loja, modo), s = t.objectStore(loja), req = fn(s);
      t.oncomplete = () => ok(req && req.result);
      t.onerror = () => erro(t.error);
    });
  };
  return {
    get: (k) => tx('cache', 'readonly', s => s.get(k)),
    set: (k, v) => tx('cache', 'readwrite', s => s.put(v, k)),
    filaAdd: (item) => tx('fila', 'readwrite', s => s.put(item)),
    filaDel: (id) => tx('fila', 'readwrite', s => s.delete(id)),
    filaTodos: () => tx('fila', 'readonly', s => s.getAll()),
  };
})();

// ----------------------------------------------------------------- rede e fila
const online = () => navigator.onLine;
async function gravar(tabela, registro, op = 'upsert') {
  // grava no servidor; sem sinal, guarda na fila e devolve como se tivesse gravado
  if (online()) {
    const q = op === 'upsert' ? sb.from(tabela).upsert(registro) : sb.from(tabela).update(registro).eq('id', registro.id);
    const { error } = await q;
    if (!error) return { ok: true };
    if (!/fetch|network|Failed/i.test(error.message)) return { ok: false, erro: error.message };
  }
  await DB.filaAdd({ id: uuid(), tabela, registro, op, em: Date.now() });
  atualizarBarraRede();
  return { ok: true, pendente: true };
}
async function sincronizar() {
  if (!online()) return;
  const itens = await DB.filaTodos();
  if (!itens.length) { atualizarBarraRede(); return; }
  mostrarRede('sync', `Sincronizando ${itens.length} registro(s)…`);
  let falhas = 0;
  for (const it of itens.sort((a, b) => a.em - b.em)) {
    const q = it.op === 'upsert' ? sb.from(it.tabela).upsert(it.registro) : sb.from(it.tabela).update(it.registro).eq('id', it.registro.id);
    const { error } = await q;
    if (error && !/fetch|network|Failed/i.test(error.message)) {
      // erro de regra (ex.: sem permissão): registra no servidor para a direção ver e tira da fila
      await sb.from('sync_pendencia').insert({ dispositivo_id: dispositivo, profissional_id: estado.eu?.id,
        entidade: it.tabela, entidade_id: it.registro.id, operacao: it.op === 'upsert' ? 'INSERIR' : 'ATUALIZAR',
        conteudo: it.registro, erro: error.message }).then(() => {});
      await DB.filaDel(it.id); falhas++;
    } else if (!error) await DB.filaDel(it.id);
    else break; // ainda sem rede
  }
  atualizarBarraRede();
  if (falhas) toast(`${falhas} registro(s) não puderam ser gravados — a direção foi avisada.`, 5000);
}
function mostrarRede(tipo, texto) { const r = $('#rede'); r.className = 'rede ' + tipo; r.textContent = texto; r.hidden = !texto; }
async function atualizarBarraRede() {
  const n = (await DB.filaTodos()).length;
  if (!online()) mostrarRede('off', `Sem internet — você pode continuar; ${n} registro(s) aguardando sincronização.`);
  else if (n) mostrarRede('sync', `${n} registro(s) aguardando sincronização…`);
  else mostrarRede('', '');
}
window.addEventListener('online', sincronizar);
window.addEventListener('offline', atualizarBarraRede);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizar(); });
setInterval(sincronizar, 60_000);

// leitura com cache: tenta o servidor, guarda; sem rede, devolve o que tem
async function ler(chave, consulta) {
  if (online()) {
    let motivo = '';
    try {
      const { data, error } = await consulta();
      if (!error) { await DB.set(chave, data); return data; }
      motivo = error.message;
    } catch (e) { motivo = e.message; }
    // tinha internet mas o servidor não respondeu: avisa em vez de mostrar a cópia local em silêncio
    toast('Não consegui atualizar com o servidor (' + motivo.slice(0, 60) + '). Mostrando o que está salvo neste aparelho.', 6000);
    console.warn('ler(' + chave + '):', motivo);
  }
  return (await DB.get(chave)) ?? null;
}

// ----------------------------------------------------------------- estado
const estado = { eu: null, especialidades: [], unidades: [], tipos: [], perfis: [], regras: {}, niveisPadrao: [] };
const souDirecao = () => estado.eu?.perfil === 'direcao';
const possoCadastrar = () => ['direcao', 'supervisor', 'recepcao'].includes(estado.eu?.perfil);
const possoConfigurar = () => ['direcao', 'supervisor', 'terapeuta'].includes(estado.eu?.perfil);

async function carregarBase() {
  const base = await ler('base', async () => {
    const [e, u, t, p, r, n] = await Promise.all([
      sb.from('especialidade').select('*').order('ordem'),
      sb.from('unidade').select('*').eq('ativo', true).order('nome'),
      sb.from('tipo_registro').select('*').order('ordem'),
      sb.from('perfil').select('*'),
      sb.from('regra_clinica').select('chave,valor'),
      sb.from('nivel_ajuda').select('tipo_registro_id,ordem,sigla,grau').is('programa_id', null).order('ordem'),
    ]);
    const error = e.error || u.error || t.error || p.error || r.error;
    return { data: { especialidades: e.data, unidades: u.data, tipos: t.data, perfis: p.data, regras: r.data, niveis: n.data || [] }, error };
  });
  if (base) {
    Object.assign(estado, { especialidades: base.especialidades, unidades: base.unidades, tipos: base.tipos, perfis: base.perfis, niveisPadrao: base.niveis || [] });
    estado.regras = Object.fromEntries((base.regras || []).map(x => [x.chave, x.valor]));
  }
}

// ----------------------------------------------------------------- navegação
const rotas = {};
function ir(hash) { location.hash = hash; }
window.addEventListener('hashchange', render);

async function render() {
  const app = $('#app');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { telaLogin(app); return; }
  if (!estado.eu) {
    const { data, error } = await sb.rpc('meu_cadastro');
    if (error && !online()) { estado.eu = await DB.get('eu'); }
    else { estado.eu = data?.[0] || null; if (estado.eu) await DB.set('eu', estado.eu); }
    if (!estado.eu) { telaPendente(app, session.user.email, 'Seu cadastro ainda não foi criado. Feche e abra o app de novo; se continuar, fale com a direção.'); return; }
    if (!estado.eu.ativo) { telaPendente(app, session.user.email, 'Sua conta foi criada e está aguardando liberação da direção.'); return; }
    await carregarBase();
    sincronizar();
  }
  const [rota, ...args] = (location.hash.replace('#/', '') || 'pacientes').split('/');
  (rotas[rota] || rotas.pacientes)(app, ...args);
}

function shell(conteudo, ativo) {
  const eu = estado.eu;
  const item = (h, txt, on) => `<button class="${on ? 'on' : ''}" onclick="location.hash='#/${h}'">${txt}</button>`;
  return `
  <div class="topbar"><div class="brand"><div class="mark">C</div><b>CLIA</b></div><button class="btn ghost sm" onclick="document.querySelector('.side').classList.toggle('aberto')">Menu</button></div>
  <div class="shell">
    <aside class="side">
      <div class="brand"><div class="mark">C</div><div><b>CLIA</b><small>prontuário comportamental</small></div></div>
      <nav class="nav">
        ${item('pacientes', 'Pacientes', ativo === 'pacientes')}
        ${item('catalogo', 'Catálogo de programas', ativo === 'catalogo')}
        ${souDirecao() ? '<div class="sep">Direção</div>' + item('equipe', 'Profissionais e convites', ativo === 'equipe') : ''}
        <div class="sep">Conta</div>
        ${item('conta', eu.nome.split(' ')[0] + ' · ' + eu.perfil_nome, ativo === 'conta')}
      </nav>
      <div class="sidefoot">${esc(eu.unidade || 'Todas as unidades')}<br>v${CONFIG.versao} · ${online() ? 'online' : 'offline'}</div>
    </aside>
    <main class="main">${conteudo}</main>
  </div>`;
}

// ----------------------------------------------------------------- login
function telaLogin(app, modo = 'entrar', msg = '') {
  app.innerHTML = `<div class="centro"><div class="login">
    <div class="brand"><div class="mark">C</div><div><b>CLIA</b><small>prontuário comportamental</small></div></div>
    <h1>${modo === 'entrar' ? 'Entrar' : modo === 'criar' ? 'Criar conta' : 'Recuperar senha'}</h1>
    <p class="sub">${modo === 'criar' ? 'Use o e-mail cadastrado pela direção.' : 'Use seu e-mail da CLIA.'}</p>
    ${msg ? `<div class="${msg.startsWith('!') ? 'erro' : 'ok'}" style="margin-bottom:12px">${esc(msg.replace(/^!/, ''))}</div>` : ''}
    <form class="form" id="f">
      ${modo === 'criar' ? '<div><label>Nome</label><input name="nome" required autocomplete="name"></div>' : ''}
      <div><label>E-mail</label><input name="email" type="email" required autocomplete="username"></div>
      ${modo !== 'senha' ? '<div><label>Senha</label><input name="senha" type="password" required minlength="8" autocomplete="current-password"></div>' : ''}
      <button class="btn block" type="submit">${modo === 'entrar' ? 'Entrar' : modo === 'criar' ? 'Criar conta' : 'Enviar link'}</button>
    </form>
    <p style="margin-top:14px;font-size:13px;display:flex;gap:14px;justify-content:center">
      ${modo !== 'entrar' ? '<button class="link" data-m="entrar">Já tenho conta</button>' : ''}
      ${modo !== 'criar' ? '<button class="link" data-m="criar">Criar conta</button>' : ''}
      ${modo !== 'senha' ? '<button class="link" data-m="senha">Esqueci a senha</button>' : ''}
    </p></div></div>`;
  app.querySelectorAll('[data-m]').forEach(b => b.onclick = () => telaLogin(app, b.dataset.m));
  $('#f', app).onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const btn = ev.target.querySelector('button'); btn.disabled = true;
    let r;
    if (modo === 'entrar') r = await sb.auth.signInWithPassword({ email: f.email, password: f.senha });
    else if (modo === 'criar') r = await sb.auth.signUp({ email: f.email, password: f.senha, options: { data: { nome: f.nome } } });
    else r = await sb.auth.resetPasswordForEmail(f.email, { redirectTo: location.href.split('#')[0] });
    btn.disabled = false;
    if (r.error) return telaLogin(app, modo, '!' + traduzirErro(r.error.message));
    if (modo === 'criar' && !r.data.session) return telaLogin(app, 'entrar', 'Conta criada. Se a confirmação por e-mail estiver ligada, confira sua caixa de entrada antes de entrar.');
    if (modo === 'senha') return telaLogin(app, 'entrar', 'Enviamos um link para redefinir a senha.');
    estado.eu = null; render();
  };
}
function traduzirErro(m) {
  if (/Invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/Email not confirmed/i.test(m)) return 'E-mail ainda não confirmado. Veja sua caixa de entrada.';
  if (/already registered/i.test(m)) return 'Este e-mail já tem conta. Use "Entrar".';
  if (/Password should/i.test(m)) return 'A senha precisa ter pelo menos 8 caracteres.';
  return m;
}
function telaPendente(app, email, texto) {
  app.innerHTML = `<div class="centro"><div class="login"><div class="brand"><div class="mark">C</div><b>CLIA</b></div>
    <h1>Quase lá</h1><p class="sub">${esc(email)}</p><div class="ok">${esc(texto)}</div>
    <p style="margin-top:16px"><button class="btn ghost block" id="sair">Sair</button></p></div></div>`;
  $('#sair', app).onclick = async () => { await sb.auth.signOut(); estado.eu = null; render(); };
}

// ----------------------------------------------------------------- pacientes
rotas.pacientes = async (app) => {
  app.innerHTML = shell('<div class="spinner"></div>', 'pacientes');
  const pacs = await ler('pacientes', () => sb.from('paciente').select('id,nome,data_nascimento,unidade_id,hipotese,ativo').eq('ativo', true).order('nome')) || [];
  const unid = Object.fromEntries(estado.unidades.map(u => [u.id, u.nome]));
  const lista = (filtro = '') => pacs.filter(p => p.nome.toLowerCase().includes(filtro.toLowerCase())).map(p => `
    <div class="it" onclick="location.hash='#/paciente/${p.id}'"><div><b>${esc(p.nome)}</b>
      <small>${idade(p.data_nascimento)} · ${esc(unid[p.unidade_id] || '')}${p.hipotese ? ' · ' + esc(p.hipotese) : ''}</small></div><span class="tag">abrir</span></div>`).join('') || '<p class="muted">Nenhum paciente.</p>';
  $('.main', app).innerHTML = `
    <div class="phead"><div><h1>Pacientes</h1><p>${pacs.length} ativo(s) que você pode ver.</p></div>
      ${possoCadastrar() ? '<button class="btn" id="novo">+ Novo paciente</button>' : ''}</div>
    <div class="busca"><input id="busca" placeholder="Buscar pelo nome…" autocomplete="off"></div>
    <div class="lista" id="lista">${lista()}</div>`;
  $('#busca', app).oninput = (e) => $('#lista', app).innerHTML = lista(e.target.value);
  const novo = $('#novo', app); if (novo) novo.onclick = () => formPaciente();
};

function formPaciente(p = null) {
  const eu = estado.eu;
  const unidades = souDirecao() ? estado.unidades : estado.unidades.filter(u => u.id === eu.unidade_id);
  modal(`<h3>${p ? 'Editar ficha' : 'Novo paciente'}</h3>
    <form class="form" id="fp">
      <div><label>Nome completo</label><input name="nome" required value="${esc(p?.nome)}"></div>
      <div class="row">
        <div><label>Data de nascimento</label>${campoData('data_nascimento', p?.data_nascimento)}</div>
        <div><label>Unidade</label><select name="unidade_id" required>${unidades.map(u => `<option value="${u.id}" ${p?.unidade_id === u.id ? 'selected' : ''}>${esc(u.nome)}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div><label>Hipótese diagnóstica</label><input name="hipotese" value="${esc(p?.hipotese)}"></div>
        <div><label>Nível de suporte</label><select name="nivel_suporte"><option value="">—</option>${[1,2,3].map(n => `<option ${p?.nivel_suporte == n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div><label>Convênio</label><input name="convenio" value="${esc(p?.convenio)}"></div>
        <div><label>Nº carteirinha</label><input name="identificador_convenio" value="${esc(p?.identificador_convenio)}"></div>
      </div>
      <div><label>Data de entrada</label>${campoData('data_entrada', p?.data_entrada || hoje())}</div>
      <div><label>Observações</label><textarea name="observacoes">${esc(p?.observacoes)}</textarea></div>
      <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn" type="submit">Salvar</button></div>
    </form>`);
  $('#fp').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    for (const k in f) if (f[k] === '') f[k] = null;
    Object.assign(f, lerDatas(ev.target));
    if (!f.data_nascimento) return toast('Preencha dia, mês e ano de nascimento.');
    const reg = { id: p?.id || uuid(), ...f, ativo: true };
    const r = await gravar('paciente', reg);
    if (!r.ok) return toast('Não foi possível salvar: ' + r.erro, 5000);
    // atualiza cache local para aparecer mesmo offline
    const pacs = (await DB.get('pacientes')) || [];
    const i = pacs.findIndex(x => x.id === reg.id); i >= 0 ? pacs[i] = { ...pacs[i], ...reg } : pacs.push(reg);
    await DB.set('pacientes', pacs.sort((a, b) => a.nome.localeCompare(b.nome)));
    if (!p && eu.perfil !== 'recepcao') {
      // quem cadastra (direção/supervisor) entra na equipe para já poder abrir a pasta
      await gravar('equipe_paciente', { paciente_id: reg.id, profissional_id: eu.id, ativo: true });
    }
    fecharModal(); toast(r.pendente ? 'Salvo no aparelho; sincroniza quando a internet voltar.' : 'Salvo.');
    ir('#/paciente/' + reg.id);
    if (p) render();
  };
}

// ----------------------------------------------------------------- pasta do paciente
rotas.paciente = async (app, id, aba = 'ficha') => {
  app.innerHTML = shell('<div class="spinner"></div>', 'pacientes');
  const pasta = await ler('pasta:' + id, async () => {
    const [p, eq, sub, resp, ses] = await Promise.all([
      sb.from('paciente').select('*').eq('id', id).single(),
      sb.from('equipe_paciente').select('profissional_id,especialidade_id,ativo,profissional(nome,perfil_id,especialidade_id)').eq('paciente_id', id).eq('ativo', true),
      sb.from('subpasta').select('id,especialidade_id,objetivo(id,nome,fase,tipo_registro_id,objetivo,instrucao_sd,procedimento_ensino,passo_dica,procedimento_correcao,criterio_aprendizado,materiais,alvos_por_sessao,tentativas_alvo,ativo,alvo(id,nome,fase,ordem,ativo),objetivo_nivel_ajuda(ordem,sigla,grau))').eq('paciente_id', id).eq('ativo', true),
      sb.from('responsavel').select('*').eq('paciente_id', id),
      sb.from('sessao').select('id,subpasta_id,profissional_id,data_sessao,situacao,falta,observacoes,profissional(nome)').eq('paciente_id', id).order('data_sessao', { ascending: false }).limit(60),
    ]);
    return { data: { paciente: p.data, equipe: eq.data || [], subpastas: sub.data || [], responsaveis: resp.data || [], sessoes: ses.data || [] }, error: p.error };
  });
  if (!pasta?.paciente) { $('.main', app).innerHTML = '<p class="erro">Paciente não encontrado ou sem permissão.</p>'; return; }
  const { paciente: p, equipe, subpastas, responsaveis } = pasta;
  const esp = (eid) => estado.especialidades.find(e => e.id === eid);
  const abas = [['ficha', 'Ficha'], ['equipe', 'Equipe'], ...estado.especialidades.filter(e => e.subpasta).map(e => ['sub-' + e.id, e.nome])];
  const unid = estado.unidades.find(u => u.id === p.unidade_id);

  let corpo = '';
  if (aba === 'ficha') {
    corpo = `<div class="card"><div class="phead" style="margin-bottom:12px"><h3>Identificação</h3>${possoCadastrar() ? '<button class="btn ghost sm" id="editar">Editar</button>' : ''}</div>
      <dl class="dl">
        <dt>Nascimento</dt><dd>${fmtData(p.data_nascimento)} (${idade(p.data_nascimento) || '—'})</dd>
        <dt>Unidade</dt><dd>${esc(unid?.nome || '—')}</dd>
        <dt>Hipótese</dt><dd>${esc(p.hipotese || '—')}</dd>
        <dt>Nível de suporte</dt><dd>${esc(p.nivel_suporte || '—')}</dd>
        <dt>Convênio</dt><dd>${esc(p.convenio || '—')} ${p.identificador_convenio ? '· ' + esc(p.identificador_convenio) : ''}</dd>
        <dt>Entrada</dt><dd>${fmtData(p.data_entrada)}</dd>
        <dt>Observações</dt><dd>${esc(p.observacoes || '—')}</dd>
      </dl></div>
      <div class="card" style="margin-top:14px"><div class="phead" style="margin-bottom:12px"><h3>Responsáveis</h3>${possoCadastrar() ? '<button class="btn ghost sm" id="novoresp">+ Responsável</button>' : ''}</div>
      ${responsaveis.length ? '<dl class="dl">' + responsaveis.map(r => `<dt>${esc(r.parentesco || 'Responsável')}</dt><dd>${esc(r.nome)}${r.telefone ? ' · ' + esc(r.telefone) : ''}${r.email ? ' · ' + esc(r.email) : ''}</dd>`).join('') + '</dl>' : '<p class="muted">Nenhum responsável cadastrado.</p>'}</div>`;
  } else if (aba === 'equipe') {
    corpo = `<div class="card"><div class="phead" style="margin-bottom:12px"><h3>Equipe do paciente</h3>${['direcao','supervisor'].includes(estado.eu.perfil) ? '<button class="btn ghost sm" id="addeq">+ Profissional</button>' : ''}</div>
      ${equipe.length ? '<div class="lista">' + equipe.map(e => `<div class="it"><div><b>${esc(e.profissional?.nome || e.profissional_id)}</b><small>${esc(esp(e.especialidade_id || e.profissional?.especialidade_id)?.nome || '')}</small></div>
        ${['direcao','supervisor'].includes(estado.eu.perfil) ? `<button class="btn ghost sm" data-rm="${e.profissional_id}">remover</button>` : ''}</div>`).join('') + '</div>' : '<p class="muted">Ninguém na equipe ainda. Só quem está na equipe (ou a direção/supervisão) vê esta pasta.</p>'}</div>`;
  } else {
    const eid = aba.replace('sub-', ''), e = esp(eid);
    if (!e) { ir('#/paciente/' + id + '/ficha'); return; }
    const sub = subpastas.find(s => s.especialidade_id === eid);
    const objs = (sub?.objetivo || []).filter(o => o.ativo);
    const porFase = (f) => objs.filter(o => o.fase === f);
    const bloco = (titulo, lista) => lista.length ? `<h4 style="margin:14px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)">${titulo} <span class="tag">${lista.length}</span></h4>${lista.map(cardObjetivo).join('')}` : '';
    const emAndamento = (pasta.sessoes || []).find(x => x.subpasta_id === sub?.id && x.situacao === 'INICIADA' && x.profissional_id === estado.eu.id);
    const treinaveis = objs.filter(o => o.fase !== 'ADQUIRIDO').length;
    corpo = `<div class="phead" style="margin-bottom:10px"><div><h3>${esc(e.nome)}</h3><p class="muted">${objs.length} objetivo(s) ativo(s)</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${estado.eu.perfil !== 'recepcao' && treinaveis ? (emAndamento ? `<button class="btn" id="sessao" data-id="${emAndamento.id}">▶ Continuar sessão de ${fmtData(emAndamento.data_sessao)}</button>` : '<button class="btn" id="sessao">▶ Iniciar sessão</button>') : ''}
      ${possoConfigurar() ? '<button class="btn ghost" id="addobj">+ Objetivo do catálogo</button>' : ''}</div></div>
      ${listaSessoes((pasta.sessoes || []).filter(x => x.subpasta_id === sub?.id))}
      ${objs.length ? bloco('Linha de base', porFase('LINHA_BASE')) + bloco('Intervenção', porFase('INTERVENCAO')) + bloco('Manutenção', porFase('MANUTENCAO')) + bloco('Generalização', porFase('GENERALIZACAO')) + bloco('Adquiridos', porFase('ADQUIRIDO')) : '<p class="muted">Nenhum objetivo nesta subpasta. Use "+ Objetivo do catálogo" ou aplique uma avaliação (em breve).</p>'}`;
  }

  $('.main', app).innerHTML = `
    <div class="phead"><div><p style="margin:0"><button class="link" onclick="location.hash='#/pacientes'">← Pacientes</button></p><h1>${esc(p.nome)}</h1>
      <p>${idade(p.data_nascimento)} · ${esc(unid?.nome || '')}${p.hipotese ? ' · ' + esc(p.hipotese) : ''}</p></div></div>
    <div class="tabs">${abas.filter(([k]) => !k.startsWith('sub-')).map(([k, t]) => `<button class="${aba === k ? 'on' : ''}" onclick="location.hash='#/paciente/${id}/${k}'">${esc(t)}</button>`).join('')}
      <span class="tabs-rot">Subpastas:</span></div>
    <div class="chips">${abas.filter(([k]) => k.startsWith('sub-')).map(([k, t]) => `<button class="${aba === k ? 'on' : ''}" onclick="location.hash='#/paciente/${id}/${k}'">${esc(t)}${contadorSub(subpastas, k.slice(4))}</button>`).join('')}</div>
    ${corpo}`;

  const ed = $('#editar', app); if (ed) ed.onclick = () => formPaciente(p);
  const nr = $('#novoresp', app); if (nr) nr.onclick = () => formResponsavel(p.id);
  const ae = $('#addeq', app); if (ae) ae.onclick = () => formEquipe(p);
  app.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!confirm('Remover da equipe?')) return;
    await sb.from('equipe_paciente').update({ ativo: false }).eq('paciente_id', p.id).eq('profissional_id', b.dataset.rm);
    render();
  });
  const ao = $('#addobj', app); if (ao) ao.onclick = () => escolherPrograma(p, aba.replace('sub-', ''), subpastas);
  const bs = $('#sessao', app); if (bs) bs.onclick = () => bs.dataset.id ? ir('#/sessao/' + bs.dataset.id) : iniciarSessao(p, aba.replace('sub-', ''), subpastas);
  app.querySelectorAll('[data-ver-sessao]').forEach(b => b.onclick = () => ir('#/sessao/' + b.dataset.verSessao));
  app.querySelectorAll('[data-fase]').forEach(b => b.onclick = () => mudarFase(b.dataset.fase, b.dataset.obj));
};
function contadorSub(subpastas, eid) {
  const n = (subpastas.find(s => s.especialidade_id === eid)?.objetivo || []).filter(o => o.ativo && o.fase !== 'ADQUIRIDO').length;
  return n ? ` <span class="tag b" style="padding:1px 7px">${n}</span>` : '';
}
const FASE_CURTA = { LINHA_BASE: 'LB', INTERVENCAO: 'INT', MANUTENCAO: 'MAN', GENERALIZACAO: 'GEN', ADQUIRIDO: 'ADQ' };
const FASES = { LINHA_BASE: ['Linha de base', 'i'], INTERVENCAO: ['Intervenção', 'b'], MANUTENCAO: ['Manutenção', 'w'], GENERALIZACAO: ['Generalização', 'w'], ADQUIRIDO: ['Adquirido', ''] };
function cardObjetivo(o) {
  const alvos = (o.alvo || []).filter(a => a.ativo).sort((a, b) => a.ordem - b.ordem);
  const tipo = estado.tipos.find(t => t.id === o.tipo_registro_id);
  const campo = (rot, v) => v ? `<div class="campo"><b>${rot}</b>${esc(v)}</div>` : '';
  const prox = { LINHA_BASE: 'INTERVENCAO', INTERVENCAO: 'MANUTENCAO', MANUTENCAO: 'ADQUIRIDO' }[o.fase];
  return `<div class="obj"><div class="cab"><div><h5>${esc(o.nome)}</h5>
      <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap"><span class="tag ${FASES[o.fase][1]}">${FASES[o.fase][0]}</span>${tipo ? `<span class="tag">${esc(tipo.chave)}</span>` : ''}<span class="tag">${o.alvos_por_sessao} alvo(s)/sessão · ${o.tentativas_alvo} tent.</span></div></div>
      ${possoConfigurar() && prox ? `<button class="btn ghost sm" data-fase="${prox}" data-obj="${o.id}">→ ${FASES[prox][0]}</button>` : ''}</div>
    ${alvos.length ? `<div class="alvos">${alvos.map(a => `<span class="tag ${FASES[a.fase][1]}" title="${FASES[a.fase][0]}">${esc(a.nome)}</span>`).join('')}</div>` : ''}
    <details><summary>Ver procedimento</summary>${campo('Objetivo', o.objetivo)}${campo('Instrução (Sd)', o.instrucao_sd)}${campo('Procedimento de ensino', o.procedimento_ensino)}${campo('Passo da dica', o.passo_dica)}${campo('Correção', o.procedimento_correcao)}${campo('Critério', o.criterio_aprendizado)}${campo('Materiais', o.materiais)}</details></div>`;
}
async function mudarFase(fase, objId) {
  if (!confirm(`Mover este objetivo (e todos os alvos) para ${FASES[fase][0]}?`)) return;
  const r1 = await gravar('objetivo', { id: objId, fase }, 'update');
  const { data: alvos } = await sb.from('alvo').select('id').eq('objetivo_id', objId).eq('ativo', true);
  for (const a of alvos || []) await gravar('alvo', { id: a.id, fase, ...(fase === 'ADQUIRIDO' ? { data_adquirido: hoje() } : {}) }, 'update');
  toast(r1.pendente ? 'Alteração guardada para sincronizar.' : 'Fase alterada.'); render();
}

function formResponsavel(pacienteId) {
  modal(`<h3>Responsável</h3><form class="form" id="fr">
    <div><label>Nome</label><input name="nome" required></div>
    <div class="row"><div><label>Parentesco</label><input name="parentesco" placeholder="mãe, pai, avó…"></div><div><label>Telefone</label><input name="telefone"></div></div>
    <div><label>E-mail</label><input name="email" type="email"></div>
    <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Salvar</button></div></form>`);
  $('#fr').onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    for (const k in f) if (f[k] === '') f[k] = null;
    const r = await gravar('responsavel', { id: uuid(), paciente_id: pacienteId, ...f });
    if (!r.ok) return toast(r.erro, 5000);
    fecharModal(); render();
  };
}
async function formEquipe(p) {
  const { data: profs } = await sb.from('profissional').select('id,nome,especialidade_id,unidade_id,perfil(chave)').eq('ativo', true).order('nome');
  const lista = (profs || []).filter(x => ['terapeuta', 'aplicador', 'supervisor'].includes(x.perfil?.chave));
  modal(`<h3>Adicionar à equipe</h3><form class="form" id="fe">
    <div><label>Profissional</label><select name="profissional_id" required>${lista.map(x => `<option value="${x.id}">${esc(x.nome)} — ${esc(estado.especialidades.find(e => e.id === x.especialidade_id)?.nome || x.perfil?.chave)}</option>`).join('')}</select></div>
    <div><label>Atua na subpasta</label><select name="especialidade_id"><option value="">(a da pessoa)</option>${estado.especialidades.filter(e => e.subpasta).map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('')}</select></div>
    <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Adicionar</button></div></form>`);
  $('#fe').onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    const prof = lista.find(x => x.id === f.profissional_id);
    const r = await gravar('equipe_paciente', { paciente_id: p.id, profissional_id: f.profissional_id, especialidade_id: f.especialidade_id || prof?.especialidade_id || null, ativo: true });
    if (!r.ok) return toast(r.erro, 5000);
    fecharModal(); render();
  };
}

// ----------------------------------------------------------------- catálogo -> objetivo
async function escolherPrograma(p, eid, subpastas) {
  const e = estado.especialidades.find(x => x.id === eid);
  const { data: areas } = await sb.from('area_geral').select('codigo,nome').order('ordem');
  modal(`<h3>Objetivo do catálogo — ${esc(e.nome)}</h3>
    <div class="busca" style="flex-wrap:wrap">
      <select id="area"><option value="">Todas as áreas</option>${(areas || []).map(a => `<option value="${a.codigo}">${esc(a.nome)}</option>`).join('')}</select>
      <input id="qb" placeholder="Filtrar pelo nome (opcional)…" autocomplete="off">
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap"><input type="checkbox" id="todas"> todas as especialidades</label>
    </div>
    <div class="cat" id="cat"><div class="spinner"></div></div>
    <p class="muted" id="catinfo" style="font-size:12px;margin:6px 0 0"></p>
    <div class="acoes"><button type="button" class="btn ghost" data-fechar>Fechar</button></div>`);
  let t;
  const buscar = async () => {
    const q = $('#qb').value.trim(), area = $('#area').value, LIM = 150;
    let c = sb.from('programa_completo').select('id,nome,especialidade_nome,area_nome,item_texto').eq('ativo', true).order('nome').limit(LIM);
    if (!$('#todas').checked) c = c.eq('especialidade_id', eid);
    if (area) c = c.eq('area_codigo', area);
    if (q) c = c.ilike('nome', `%${q}%`);
    const { data } = await c;
    $('#cat').innerHTML = (data || []).map(pr => `<button data-id="${pr.id}">${esc(pr.nome)}<small>${esc(pr.especialidade_nome || '')}${pr.area_nome ? ' · ' + esc(pr.area_nome) : ''}${pr.item_texto ? ' · avaliação: ' + esc(pr.item_texto.slice(0, 60)) : ''}</small></button>`).join('') || '<p class="muted">Nada encontrado.</p>';
    $('#catinfo').textContent = (data || []).length >= LIM ? `Mostrando os primeiros ${LIM} — escolha uma área ou digite parte do nome para afinar.` : `${(data || []).length} programa(s).`;
    $('#cat').querySelectorAll('button').forEach(b => b.onclick = () => confirmarObjetivo(p, eid, subpastas, b.dataset.id));
  };
  $('#qb').oninput = () => { clearTimeout(t); t = setTimeout(buscar, 250); };
  $('#area').onchange = buscar; $('#todas').onchange = buscar;
  buscar();
}
async function confirmarObjetivo(p, eid, subpastas, programaId) {
  const [{ data: pr }, { data: alvos }, { data: niveis }] = await Promise.all([
    sb.from('programa_completo').select('*').eq('id', programaId).single(),
    sb.from('programa_alvo').select('*').eq('programa_id', programaId).eq('ativo', true).order('ordem'),
    sb.from('nivel_ajuda').select('*').eq('programa_id', programaId).order('ordem'),
  ]);
  let nv = niveis || [];
  if (!nv.length) { const { data } = await sb.from('nivel_ajuda').select('*').eq('tipo_registro_id', pr.tipo_registro_id).is('programa_id', null).order('ordem'); nv = data || []; }
  const R = estado.regras;
  modal(`<h3>${esc(pr.nome)}</h3>
    <form class="form" id="fo">
      <div class="row"><div><label>Alvos por sessão</label><input name="alvos_por_sessao" type="number" min="1" value="${pr.alvos_por_sessao || 1}"></div>
        <div><label>Tentativas por alvo</label><input name="tentativas_alvo" type="number" min="1" value="${pr.tentativas_alvo || 3}"></div></div>
      <div class="row"><div><label>Critério: % independentes</label><input name="criterio_pct" type="number" min="1" max="100" value="${R.CRIT_PCT || 80}"></div>
        <div><label>em sessões seguidas</label><input name="criterio_sessoes" type="number" min="1" value="${R.CRIT_SESSOES || 3}"></div></div>
      <div class="row"><div><label>Manutenção a cada</label><input name="manut_cada" type="number" min="1" value="${R.MANUT_CADA || 1}"></div>
        <div><label>unidade / quantas</label><div style="display:flex;gap:6px"><select name="manut_unidade">${['DIA','SEMANA','MES'].map(u => `<option ${u === (R.MANUT_UNIDADE || 'SEMANA') ? 'selected' : ''}>${u}</option>`).join('')}</select><input name="manut_qtd" type="number" min="1" value="${R.MANUT_QTD || 4}" style="width:70px"></div></div></div>
      <div><label>Fase inicial</label><select name="fase"><option value="LINHA_BASE">Linha de base</option><option value="INTERVENCAO">Intervenção</option></select></div>
      <div><label>Alvos (um por linha; pode editar)</label><textarea name="alvos" style="min-height:110px">${esc((alvos || []).map(a => a.nome).join('\n'))}</textarea></div>
      <p class="muted" style="margin:0;font-size:12.5px">Níveis de ajuda: ${nv.map(n => esc(n.sigla)).join(' › ') || 'padrão do tipo de registro'}.
        ${pr.passo_dica_padrao ? '<br><span class="padrao">Passo da dica, correção e critério vêm do padrão da clínica (pode editar depois).</span>' : ''}</p>
      <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Adicionar à pasta</button></div>
    </form>`);
  $('#fo').onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    // subpasta existe? senão cria
    let sub = subpastas.find(s => s.especialidade_id === eid);
    if (!sub) { sub = { id: uuid(), paciente_id: p.id, especialidade_id: eid, ativo: true }; const r = await gravar('subpasta', sub); if (!r.ok) return toast(r.erro, 5000); }
    const obj = { id: uuid(), subpasta_id: sub.id, programa_id: pr.id, nome: pr.nome, tipo_registro_id: pr.tipo_registro_id,
      protocolo_id: pr.protocolo_id, habilidade_id: pr.habilidade_id, marco: pr.marco, origem_item_id: pr.item_id,
      alvos_por_sessao: +f.alvos_por_sessao, tentativas_alvo: +f.tentativas_alvo,
      objetivo: pr.objetivo, instrucao_sd: pr.instrucao_sd, procedimento_ensino: pr.procedimento_ensino,
      passo_dica: pr.passo_dica_final, procedimento_correcao: pr.procedimento_correcao_final, criterio_aprendizado: pr.criterio_aprendizado_final,
      materiais: pr.materiais, observacoes: pr.observacoes, fase: f.fase,
      criterio_pct: +f.criterio_pct, criterio_sessoes: +f.criterio_sessoes, manut_cada: +f.manut_cada, manut_unidade: f.manut_unidade, manut_qtd: +f.manut_qtd,
      data_entrada: hoje(), ativo: true, criado_por: estado.eu.id };
    let r = await gravar('objetivo', obj); if (!r.ok) return toast('Não foi possível salvar: ' + r.erro, 6000);
    const nomes = f.alvos.split('\n').map(s => s.trim()).filter(Boolean);
    for (const [i, nome] of nomes.entries()) await gravar('alvo', { id: uuid(), objetivo_id: obj.id, ordem: i, nome, fase: f.fase, ativo: true });
    for (const n of nv) await gravar('objetivo_nivel_ajuda', { id: uuid(), objetivo_id: obj.id, ordem: n.ordem, sigla: n.sigla, grau: n.grau });
    fecharModal(); toast(r.pendente ? 'Objetivo guardado no aparelho; sincroniza depois.' : 'Objetivo adicionado.'); render();
  };
}

// ----------------------------------------------------------------- sessão (registro de tentativas)
function listaSessoes(ss) {
  if (!ss.length) return '';
  const rot = { CRIADA: 'criada', INICIADA: 'em andamento', FINALIZADA: 'finalizada', CANCELADA: 'cancelada' };
  return `<details class="card" style="margin-bottom:14px;padding:10px 14px"><summary style="cursor:pointer;font-weight:600;font-size:13px">Sessões (${ss.length})</summary>
    <div class="lista" style="margin-top:10px">${ss.slice(0, 20).map(x => `<div class="it" data-ver-sessao="${x.id}"><div><b>${fmtData(x.data_sessao)}${x.falta ? ' · falta' : ''}</b><small>${esc(x.profissional?.nome || '')} · ${rot[x.situacao] || x.situacao}${x.observacoes ? ' · ' + esc(x.observacoes.slice(0, 60)) : ''}</small></div><span class="tag ${x.situacao === 'INICIADA' ? 'w' : ''}">${x.situacao === 'INICIADA' ? 'continuar' : 'abrir'}</span></div>`).join('')}</div></details>`;
}

// níveis de ajuda de um objetivo: os dele ou, se não tiver, os padrão do tipo de registro
function niveisDo(o) {
  const prop = (o.objetivo_nivel_ajuda || []).slice().sort((a, b) => a.ordem - b.ordem);
  if (prop.length) return prop;
  return estado.niveisPadrao.filter(n => n.tipo_registro_id === o.tipo_registro_id).sort((a, b) => a.ordem - b.ordem);
}

// quais alvos entram hoje: linha de base e intervenção sempre; manutenção/generalização só se estiver agendada para hoje ou atrasada
function alvosDeHoje(o, agenda) {
  const alvos = (o.alvo || []).filter(a => a.ativo && a.fase !== 'ADQUIRIDO').sort((a, b) => a.ordem - b.ordem);
  const h = hoje();
  const prontos = alvos.filter(a => {
    if (a.fase === 'LINHA_BASE' || a.fase === 'INTERVENCAO') return true;
    const ag = (agenda || []).filter(g => g.alvo_id === a.id && !g.data_realizada);
    return ag.length ? ag.some(g => g.data_programada <= h) : true; // sem agenda ainda (motor de fases vem depois): entra
  });
  return prontos.slice(0, Math.max(1, o.alvos_por_sessao || 1));
}

async function iniciarSessao(p, eid, subpastas) {
  let sub = subpastas.find(s => s.especialidade_id === eid);
  if (!sub) return toast('Esta subpasta ainda não tem objetivos.');
  const ses = { id: uuid(), paciente_id: p.id, subpasta_id: sub.id, profissional_id: estado.eu.id, data_sessao: hoje(),
    situacao: 'INICIADA', inicio: new Date().toISOString(), dispositivo_id: dispositivo };
  const r = await gravar('sessao', ses);
  if (!r.ok) return toast('Não foi possível iniciar: ' + r.erro, 6000);
  // guarda o pacote da sessão no aparelho para funcionar sem internet
  await DB.set('sessao:' + ses.id, { sessao: ses, paciente: { id: p.id, nome: p.nome }, especialidade_id: sub.especialidade_id, objetivos: montarObjetivosSessao(sub), tentativas: [], agenda: [] });
  ir('#/sessao/' + ses.id);
}
function montarObjetivosSessao(sub) {
  return (sub.objetivo || []).filter(o => o.ativo && o.fase !== 'ADQUIRIDO').map(o => ({ ...o, especialidade_id: sub.especialidade_id, niveis: niveisDo(o) }));
}

rotas.sessao = async (app, id) => {
  app.innerHTML = shell('<div class="spinner"></div>', 'pacientes');
  // pacote: tenta o servidor (sessão + objetivos da subpasta + tentativas já feitas); sem rede, usa o guardado
  let pk = await ler('sessao:' + id, async () => {
    const { data: ses, error } = await sb.from('sessao').select('*').eq('id', id).single();
    if (error) return { error };
    const [{ data: pac }, { data: sub }, { data: tent }] = await Promise.all([
      sb.from('paciente').select('id,nome').eq('id', ses.paciente_id).single(),
      sb.from('subpasta').select('id,especialidade_id,objetivo(id,nome,fase,tipo_registro_id,alvos_por_sessao,tentativas_alvo,instrucao_sd,procedimento_ensino,passo_dica,procedimento_correcao,criterio_aprendizado,materiais,ativo,alvo(id,nome,fase,ordem,ativo),objetivo_nivel_ajuda(ordem,sigla,grau))').eq('id', ses.subpasta_id).single(),
      sb.from('tentativa').select('id,alvo_id,numero,sigla_ajuda,independente,erro').eq('sessao_id', id),
    ]);
    const alvoIds = (sub?.objetivo || []).flatMap(o => (o.alvo || []).map(a => a.id));
    const { data: agenda } = alvoIds.length ? await sb.from('manutencao_agenda').select('id,alvo_id,data_programada,data_realizada').in('alvo_id', alvoIds).is('data_realizada', null) : { data: [] };
    return { data: { sessao: ses, paciente: pac, especialidade_id: sub?.especialidade_id, objetivos: montarObjetivosSessao(sub || {}), tentativas: tent || [], agenda: agenda || [] }, error: null };
  });
  if (!pk) { $('.main', app).innerHTML = '<p class="erro">Sessão não encontrada neste aparelho e sem conexão.</p>'; return; }
  const { sessao: ses, paciente: pac } = pk;
  const fechada = ses.situacao === 'FINALIZADA' || ses.situacao === 'CANCELADA';
  const minha = ses.profissional_id === estado.eu.id || ['direcao', 'supervisor'].includes(estado.eu.perfil);
  const podeEditar = !fechada && minha;
  const tent = (alvoId, n) => pk.tentativas.find(t => t.alvo_id === alvoId && t.numero === n);
  const pct = (alvoIds) => { const ts = pk.tentativas.filter(t => alvoIds.includes(t.alvo_id)); return ts.length ? Math.round(100 * ts.filter(t => t.independente).length / ts.length) : null; };
  const tiposTent = ['TDE', 'TDI', 'AT', 'EN'];
  let aberto = null; // {alvoId, numero} com o seletor de nível aberto

  const desenhar = () => {
    const blocos = pk.objetivos.map(o => {
      const tipo = estado.tipos.find(t => t.id === o.tipo_registro_id);
      if (tipo && !tiposTent.includes(tipo.chave)) return `<div class="obj"><h5>${esc(o.nome)}</h5><p class="muted" style="font-size:12.5px;margin:4px 0 0">Registro de ${esc(tipo.nome)} ainda não disponível no app.</p></div>`;
      const alvos = alvosDeHoje(o, pk.agenda);
      if (!alvos.length) return '';
      const pO = pct(alvos.map(a => a.id));
      return `<div class="obj"><div class="cab"><div><h5>${esc(o.nome)}</h5>
          <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap"><span class="tag ${FASES[o.fase][1]}">${FASES[o.fase][0]}</span><span class="tag">${o.tentativas_alvo} tent./alvo</span>${pO !== null ? `<span class="tag ${pO >= (+estado.regras.CRIT_PCT || 80) ? 'b' : ''}">${pO}% independente</span>` : ''}</div></div></div>
        ${alvos.map(a => {
          const pA = pct([a.id]);
          const cels = Array.from({ length: o.tentativas_alvo || 3 }, (_, i) => {
            const n = i + 1, t = tent(a.id, n);
            const cls = !t ? '' : t.independente ? 'ind' : t.erro ? 'err' : 'aj';
            const on = aberto && aberto.alvoId === a.id && aberto.numero === n ? ' on' : '';
            return `<button class="tent ${cls}${on}" data-alvo="${a.id}" data-n="${n}" ${podeEditar ? '' : 'disabled'} title="tentativa ${n}">${t ? esc(t.sigla_ajuda) : n}</button>`;
          }).join('');
          const seletor = aberto && aberto.alvoId === a.id ? `<div class="niveis">${o.niveis.map(nv => `<button class="nv ${nv.grau === 'INDEPENDENTE' ? 'ind' : nv.grau === 'ERRO' ? 'err' : ''}" data-sigla="${esc(nv.sigla)}" data-grau="${nv.grau}" data-alvo="${a.id}" data-n="${aberto.numero}">${esc(nv.sigla)}<small>${rotGrau(nv.grau)}</small></button>`).join('')}<button class="nv limpar" data-alvo="${a.id}" data-n="${aberto.numero}" data-limpar>apagar</button></div>` : '';
          return `<div class="alvo-linha"><div class="alvo-nome"><span class="tag ${FASES[a.fase][1]}" style="padding:1px 7px">${FASE_CURTA[a.fase] || ''}</span> ${esc(a.nome)}${pA !== null ? ` <span class="muted">· ${pA}%</span>` : ''}</div><div class="tents">${cels}</div>${seletor}</div>`;
        }).join('')}
        <details style="margin-top:6px;font-size:12.5px"><summary>Procedimento</summary>${[['Sd', o.instrucao_sd], ['Ensino', o.procedimento_ensino], ['Dica', o.passo_dica], ['Correção', o.procedimento_correcao], ['Critério', o.criterio_aprendizado], ['Materiais', o.materiais]].filter(x => x[1]).map(x => `<div class="campo"><b>${x[0]}</b>${esc(x[1])}</div>`).join('') || '<span class="muted">—</span>'}</details>
      </div>`;
    }).join('');
    const totalT = pk.tentativas.length, indT = pk.tentativas.filter(t => t.independente).length;
    $('.main', app).innerHTML = `
      <div class="phead"><div><p style="margin:0"><button class="link" onclick="location.hash='#/paciente/${ses.paciente_id}/sub-${pk.especialidade_id || ''}'">← ${esc(pac?.nome || 'Paciente')}</button></p>
        <h1>Sessão de ${fmtData(ses.data_sessao)}</h1><p>${fechada ? (ses.falta ? 'Falta registrada' : 'Finalizada') : 'Em andamento'} · ${totalT} tentativa(s)${totalT ? ` · ${Math.round(100 * indT / totalT)}% independentes` : ''}</p></div>
        ${podeEditar ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost" id="falta">Falta</button><button class="btn" id="fim">Finalizar sessão</button></div>` : ''}</div>
      ${ses.observacoes ? `<div class="card" style="margin-bottom:12px"><b style="font-size:12px;color:var(--ink3)">OBSERVAÇÕES</b><div>${esc(ses.observacoes)}</div>${ses.fatores_externos ? `<div class="muted" style="font-size:12.5px;margin-top:4px">Fatores externos: ${esc(ses.fatores_externos)}</div>` : ''}</div>` : ''}
      ${podeEditar ? '<p class="muted" style="font-size:12.5px;margin:0 0 10px">Toque na tentativa e escolha o nível de ajuda. Tudo é salvo na hora (e sincroniza depois se faltar internet).</p>' : ''}
      ${blocos || '<p class="muted">Nenhum alvo programado para hoje nesta subpasta.</p>'}`;
    app.querySelectorAll('.tent').forEach(b => b.onclick = () => { const k = { alvoId: b.dataset.alvo, numero: +b.dataset.n }; aberto = (aberto && aberto.alvoId === k.alvoId && aberto.numero === k.numero) ? null : k; desenhar(); });
    app.querySelectorAll('.nv').forEach(b => b.onclick = () => registrar(b.dataset.alvo, +b.dataset.n, b.hasAttribute('data-limpar') ? null : { sigla: b.dataset.sigla, grau: b.dataset.grau }));
    const bf = $('#fim', app); if (bf) bf.onclick = () => finalizar(false);
    const bx = $('#falta', app); if (bx) bx.onclick = () => finalizar(true);
  };

  const registrar = async (alvoId, numero, nv) => {
    const atual = tent(alvoId, numero);
    if (!nv) {
      if (atual) { pk.tentativas = pk.tentativas.filter(t => t !== atual); await DB.set('sessao:' + id, pk); sb.from('tentativa').delete().eq('id', atual.id).then(() => {}); }
      aberto = null; desenhar(); return;
    }
    const t = { id: atual?.id || uuid(), sessao_id: id, alvo_id: alvoId, numero, sigla_ajuda: nv.sigla, independente: nv.grau === 'INDEPENDENTE', erro: nv.grau === 'ERRO', dispositivo_id: dispositivo };
    if (atual) Object.assign(atual, t); else pk.tentativas.push(t);
    await DB.set('sessao:' + id, pk);
    // próxima tentativa do mesmo alvo já fica aberta, para registrar em sequência
    const max = (pk.objetivos.find(o => (o.alvo || []).some(a => a.id === alvoId))?.tentativas_alvo) || 3;
    aberto = numero < max ? { alvoId, numero: numero + 1 } : null;
    desenhar();
    const r = await gravar('tentativa', t);
    if (!r.ok) toast('Tentativa não gravada: ' + r.erro, 5000);
  };

  const finalizar = (falta) => {
    modal(`<h3>${falta ? 'Registrar falta' : 'Finalizar sessão'}</h3><form class="form" id="ff">
      ${falta ? '<p class="muted" style="margin:0;font-size:13px">A sessão fica registrada como falta do paciente, sem tentativas.</p>' : ''}
      <div><label>Observações${falta ? ' (motivo, se souber)' : ' da sessão'}</label><textarea name="observacoes"></textarea></div>
      ${falta ? '' : '<div><label>Fatores externos (sono, medicação, doença…)</label><input name="fatores_externos"></div>'}
      <div class="acoes"><button type="button" class="btn ghost" data-fechar>Voltar</button><button class="btn">${falta ? 'Registrar falta' : 'Finalizar'}</button></div></form>`);
    $('#ff').onsubmit = async (ev) => {
      ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
      const up = { id, situacao: 'FINALIZADA', falta: !!falta, fim: new Date().toISOString(), observacoes: f.observacoes || null, fatores_externos: f.fatores_externos || null };
      Object.assign(ses, up); await DB.set('sessao:' + id, pk);
      const r = await gravar('sessao', up, 'update');
      // alvos de manutenção/generalização treinados hoje: baixa na agenda
      if (!falta) for (const o of pk.objetivos) for (const a of alvosDeHoje(o, pk.agenda)) {
        if (['MANUTENCAO', 'GENERALIZACAO'].includes(a.fase) && pk.tentativas.some(t => t.alvo_id === a.id)) {
          const g = pk.agenda.filter(x => x.alvo_id === a.id && !x.data_realizada).sort((x, y) => x.data_programada.localeCompare(y.data_programada))[0];
          if (g && g.id) await gravar('manutencao_agenda', { id: g.id, data_realizada: hoje() }, 'update');
        }
      }
      fecharModal(); toast(r.pendente ? 'Sessão guardada; sincroniza quando a internet voltar.' : 'Sessão finalizada.');
      ir('#/paciente/' + ses.paciente_id + '/sub-' + (pk.especialidade_id || ''));
    };
  };
  desenhar();
};
function rotGrau(g) { return { MAIS_INTRUSIVA: 'ajuda total', PARCIAL_INTRUSIVA: 'ajuda parcial', MENOS_INTRUSIVA: 'ajuda leve', INDEPENDENTE: 'independente', ERRO: 'erro', OMISSAO: 'omissão' }[g] || ''; }

// ----------------------------------------------------------------- catálogo (consulta)
rotas.catalogo = async (app) => {
  app.innerHTML = shell(`<div class="phead"><div><h1>Catálogo de programas</h1><p>2.797 programas (CLIA + biblioteca ABA+). Busque pelo nome; para colocar na pasta de um paciente, use a subpasta dele.</p></div></div>
    <div class="busca"><input id="qb" placeholder="Buscar…" autocomplete="off"><select id="esp"><option value="">Todas as especialidades</option>${estado.especialidades.map(e => `<option value="${e.id}">${esc(e.nome)}</option>`).join('')}</select></div>
    <div id="res" class="lista"></div>`, 'catalogo');
  let t;
  const buscar = async () => {
    const q = $('#qb', app).value.trim(); if (q.length < 2) return;
    let c = sb.from('programa_completo').select('id,nome,especialidade_nome,area_nome,item_texto,objetivo').eq('ativo', true).ilike('nome', `%${q}%`).order('nome').limit(60);
    const e = $('#esp', app).value; if (e) c = c.eq('especialidade_id', e);
    const { data } = await c;
    $('#res', app).innerHTML = (data || []).map(pr => `<div class="it" style="cursor:default"><div><b>${esc(pr.nome)}</b><small>${esc(pr.especialidade_nome || '')}${pr.area_nome ? ' · ' + esc(pr.area_nome) : ''}${pr.item_texto ? ' · avaliação: ' + esc(pr.item_texto.slice(0, 80)) : ''}</small>${pr.objetivo ? `<div class="muted" style="font-size:12.5px;margin-top:4px">${esc(pr.objetivo.slice(0, 200))}</div>` : ''}</div></div>`).join('') || '<p class="muted">Nada encontrado.</p>';
  };
  $('#qb', app).oninput = () => { clearTimeout(t); t = setTimeout(buscar, 250); };
  $('#esp', app).onchange = buscar;
};

// ----------------------------------------------------------------- direção: profissionais e convites
rotas.equipe = async (app) => {
  if (!souDirecao()) return rotas.pacientes(app);
  app.innerHTML = shell('<div class="spinner"></div>', 'equipe');
  const [{ data: profs }, { data: conv }] = await Promise.all([
    sb.from('profissional').select('id,nome,email,ativo,unidade_id,especialidade_id,perfil(chave,nome)').order('nome'),
    sb.from('profissional_convite').select('*').is('usado_em', null).order('criado_em'),
  ]);
  const unid = (id) => estado.unidades.find(u => u.id === id)?.nome || '—';
  const espn = (id) => estado.especialidades.find(e => e.id === id)?.nome || '';
  $('.main', app).innerHTML = `
    <div class="phead"><div><h1>Profissionais</h1><p>Quem já criou conta. Pendentes precisam ser liberados aqui.</p></div><button class="btn" id="conv">+ Convite</button></div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><thead><tr><th>Nome</th><th>Perfil</th><th>Unidade</th><th>Especialidade</th><th></th></tr></thead><tbody>
    ${(profs || []).map(x => `<tr><td><b>${esc(x.nome)}</b><br><small class="muted">${esc(x.email)}</small></td><td>${esc(x.perfil?.nome)}</td><td>${esc(unid(x.unidade_id))}</td><td>${esc(espn(x.especialidade_id))}</td>
      <td>${x.ativo ? '<span class="tag b">ativo</span>' : '<span class="tag w">pendente</span>'} <button class="btn ghost sm" data-ed="${x.id}">editar</button></td></tr>`).join('')}</tbody></table></div>
    <h3 style="margin:22px 0 10px">Convites aguardando cadastro</h3>
    <div class="card">${(conv || []).length ? '<dl class="dl">' + conv.map(c => `<dt>${esc(c.email)}</dt><dd>${esc(c.nome)} · ${esc(c.perfil_chave)} · ${esc(c.unidade_nome || '')} ${esc(c.especialidade_nome || '')}</dd>`).join('') + '</dl>' : '<p class="muted">Nenhum.</p>'}</div>`;
  $('#conv', app).onclick = () => formConvite();
  app.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => formProfissional(profs.find(x => x.id === b.dataset.ed)));
};
function selPerfil(v) { return estado.perfis.map(p => `<option value="${p.chave}" ${p.chave === v ? 'selected' : ''}>${esc(p.nome)}</option>`).join(''); }
function selUnidade(v, porNome = false) { return '<option value="">—</option>' + estado.unidades.map(u => `<option value="${porNome ? esc(u.nome) : u.id}" ${(porNome ? u.nome : u.id) === v ? 'selected' : ''}>${esc(u.nome)}</option>`).join(''); }
function selEsp(v, porNome = false) { return '<option value="">—</option>' + estado.especialidades.map(e => `<option value="${porNome ? esc(e.nome) : e.id}" ${(porNome ? e.nome : e.id) === v ? 'selected' : ''}>${esc(e.nome)}</option>`).join(''); }
function formConvite() {
  modal(`<h3>Convite</h3><p class="muted" style="margin:0 0 10px;font-size:13px">A pessoa cria a conta com este e-mail e já entra com o perfil certo.</p><form class="form" id="fc">
    <div><label>E-mail</label><input name="email" type="email" required></div>
    <div><label>Nome</label><input name="nome" required></div>
    <div class="row"><div><label>Perfil</label><select name="perfil_chave">${selPerfil('terapeuta')}</select></div><div><label>Unidade</label><select name="unidade_nome">${selUnidade('', true)}</select></div></div>
    <div class="row"><div><label>Especialidade</label><select name="especialidade_nome">${selEsp('', true)}</select></div><div><label>Conselho / registro</label><div style="display:flex;gap:6px"><input name="conselho" placeholder="CRP" style="width:90px"><input name="registro"></div></div></div>
    <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Salvar convite</button></div></form>`);
  $('#fc').onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target)); for (const k in f) if (f[k] === '') f[k] = null;
    const { error } = await sb.from('profissional_convite').upsert({ ...f, email: f.email.toLowerCase() });
    if (error) return toast(error.message, 5000);
    fecharModal(); render();
  };
}
function formProfissional(x) {
  modal(`<h3>${esc(x.nome)}</h3><form class="form" id="fpf">
    <div><label>Nome</label><input name="nome" value="${esc(x.nome)}" required></div>
    <div class="row"><div><label>Perfil</label><select name="perfil_chave">${selPerfil(x.perfil?.chave)}</select></div><div><label>Unidade</label><select name="unidade_id">${selUnidade(x.unidade_id)}</select></div></div>
    <div class="row"><div><label>Especialidade</label><select name="especialidade_id">${selEsp(x.especialidade_id)}</select></div><div><label>Situação</label><select name="ativo"><option value="true" ${x.ativo ? 'selected' : ''}>Ativo (liberado)</option><option value="false" ${!x.ativo ? 'selected' : ''}>Inativo / pendente</option></select></div></div>
    <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Salvar</button></div></form>`);
  $('#fpf').onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    const perfil_id = estado.perfis.find(p => p.chave === f.perfil_chave)?.id;
    const { error } = await sb.from('profissional').update({ nome: f.nome, perfil_id, unidade_id: f.unidade_id || null, especialidade_id: f.especialidade_id || null, ativo: f.ativo === 'true' }).eq('id', x.id);
    if (error) return toast(error.message, 5000);
    fecharModal(); render();
  };
}

// ----------------------------------------------------------------- conta
rotas.conta = async (app) => {
  const eu = estado.eu; const fila = await DB.filaTodos();
  app.innerHTML = shell(`<div class="phead"><div><h1>${esc(eu.nome)}</h1><p>${esc(eu.email)} · ${esc(eu.perfil_nome)} · ${esc(eu.unidade || 'todas as unidades')}${eu.especialidade ? ' · ' + esc(eu.especialidade) : ''}</p></div></div>
    <div class="card"><dl class="dl"><dt>Aparelho</dt><dd><code style="font-size:11.5px">${dispositivo.slice(0, 8)}</code></dd><dt>Pendentes</dt><dd>${fila.length} registro(s) aguardando sincronização</dd><dt>Versão</dt><dd>${CONFIG.versao}</dd></dl>
      <div class="acoes" style="margin-top:14px"><button class="btn ghost" id="sync">Sincronizar agora</button><button class="btn ghost" id="senha">Trocar senha</button><button class="btn danger" id="sair">Sair</button></div></div>`, 'conta');
  $('#sync', app).onclick = () => sincronizar().then(() => render());
  $('#senha', app).onclick = () => {
    modal(`<h3>Nova senha</h3><form class="form" id="fs"><div><label>Senha (mín. 8)</label><input name="s" type="password" minlength="8" required></div><div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Salvar</button></div></form>`);
    $('#fs').onsubmit = async (ev) => { ev.preventDefault(); const { error } = await sb.auth.updateUser({ password: new FormData(ev.target).get('s') }); if (error) return toast(error.message); fecharModal(); toast('Senha alterada.'); };
  };
  $('#sair', app).onclick = async () => {
    if (fila.length && !confirm(`Há ${fila.length} registro(s) não sincronizados. Sair mesmo assim? Eles ficam guardados neste aparelho.`)) return;
    await sb.auth.signOut(); estado.eu = null; ir('#/'); render();
  };
};

// ----------------------------------------------------------------- modal
function modal(html) {
  fecharModal();
  const m = document.createElement('div'); m.className = 'modal'; m.id = 'modal';
  m.innerHTML = `<div class="box">${html}</div>`;
  m.addEventListener('click', (e) => { if (e.target === m || e.target.hasAttribute('data-fechar')) fecharModal(); });
  document.body.appendChild(m);
  const first = m.querySelector('input,select,textarea'); if (first) first.focus();
}
function fecharModal() { const m = $('#modal'); if (m) m.remove(); }

// ----------------------------------------------------------------- início
sb.auth.onAuthStateChange((ev) => { if (ev === 'PASSWORD_RECOVERY') { render().then(() => rotas.conta($('#app'))); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
atualizarBarraRede();
render();
