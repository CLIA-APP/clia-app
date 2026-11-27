// =============================================================================
// Aplicativo CLIA — app.js
// Uma página só (PWA). Supabase para banco e login; IndexedDB para funcionar
// sem internet; fila de sincronização que esvazia sozinha quando o sinal volta.
// =============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CONFIG = {
  url: 'https://qojifretsdskzdpnuazy.supabase.co',
  chave: 'sb_publishable_u5pmUEjeIA1rnyQbYkW7KQ_3bLtWgKn',   // chave pública: segura no app
  versao: '0.6.0',
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

// bloco da marca: usa logo.png quando existir; senão, o nome escrito
function marca(compacto) {
  return `<div class="brand sem-logo">
    <img class="logo" src="logo.svg" alt="CLIA Núcleo Comportamental" onload="this.closest('.brand').classList.remove('sem-logo')">
    <span class="nome"><span class="mark">C</span><span><b>CLIA</b>${compacto ? '' : '<small>Núcleo Comportamental</small>'}</span></span>
  </div>`;
}

function shell(conteudo, ativo) {
  const eu = estado.eu;
  const item = (h, txt, on) => `<button class="${on ? 'on' : ''}" onclick="location.hash='#/${h}'">${txt}</button>`;
  return `
  <div class="topbar">${marca(true)}<button class="btn ghost sm" onclick="document.querySelector('.side').classList.toggle('aberto')">Menu</button></div>
  <div class="shell">
    <aside class="side">
      ${marca(false)}
      <nav class="nav">
        ${item('pacientes', 'Pacientes', ativo === 'pacientes')}
        ${item('catalogo', 'Catálogo de programas', ativo === 'catalogo')}
        ${podeVerPainel() ? '<div class="sep">Direção</div>' + item('direcao', 'Painel', ativo === 'direcao') : ''}
        ${souDirecao() ? item('equipe', 'Profissionais e convites', ativo === 'equipe') : ''}
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
    ${marca(false)}
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
  app.innerHTML = `<div class="centro"><div class="login">${marca(true)}
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
    const [p, eq, sub, resp, ses, av] = await Promise.all([
      sb.from('paciente').select('*').eq('id', id).single(),
      sb.from('equipe_paciente').select('profissional_id,especialidade_id,ativo,profissional(nome,perfil_id,especialidade_id)').eq('paciente_id', id).eq('ativo', true),
      sb.from('subpasta').select('id,especialidade_id,objetivo(id,nome,fase,tipo_registro_id,objetivo,instrucao_sd,procedimento_ensino,passo_dica,procedimento_correcao,criterio_aprendizado,materiais,alvos_por_sessao,tentativas_alvo,ativo,alvo(id,nome,fase,ordem,ativo,data_adquirido,alvo_evolucao(resultado,fase_anterior,fase_nova,motivo,calculado_em),manutencao_agenda(data_programada,data_realizada)),objetivo_nivel_ajuda(ordem,sigla,grau))').eq('paciente_id', id).eq('ativo', true),
      sb.from('responsavel').select('*').eq('paciente_id', id),
      sb.from('sessao').select('id,subpasta_id,profissional_id,data_sessao,situacao,falta,observacoes,profissional(nome)').eq('paciente_id', id).order('data_sessao', { ascending: false }).limit(60),
      sb.from('avaliacao').select('id,protocolo_id,data_avaliacao,situacao,observacoes,protocolo(nome),profissional:aplicador_id(nome)').eq('paciente_id', id).order('data_avaliacao', { ascending: false }),
    ]);
    return { data: { paciente: p.data, equipe: eq.data || [], subpastas: sub.data || [], responsaveis: resp.data || [], sessoes: ses.data || [], avaliacoes: av.data || [] }, error: p.error };
  });
  if (!pasta?.paciente) { $('.main', app).innerHTML = '<p class="erro">Paciente não encontrado ou sem permissão.</p>'; return; }
  const { paciente: p, equipe, subpastas, responsaveis } = pasta;
  const esp = (eid) => estado.especialidades.find(e => e.id === eid);
  const abas = [['ficha', 'Ficha'], ['equipe', 'Equipe'], ['avaliacoes', 'Avaliações'], ['evolucao', 'Evolução'], ...estado.especialidades.filter(e => e.subpasta).map(e => ['sub-' + e.id, e.nome])];
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
  } else if (aba === 'evolucao') {
    corpo = '<div class="spinner"></div>';
  } else if (aba === 'avaliacoes') {
    const avs = pasta.avaliacoes || [];
    corpo = `<div class="phead" style="margin-bottom:10px"><div><h3>Avaliações</h3><p class="muted">Preencha o protocolo aqui e o app monta a lista de objetivos sugeridos.</p></div>
      ${possoConfigurar() ? '<button class="btn" id="novaav">+ Nova avaliação</button>' : ''}</div>
      ${avs.length ? `<div class="lista">${avs.map(a => `<div class="it" data-ver-av="${a.id}"><div><b>${esc(a.protocolo?.nome || 'Protocolo')}</b><small>${fmtData(a.data_avaliacao)} · ${esc(a.profissional?.nome || '')} · ${a.situacao === 'FINALIZADA' ? 'finalizada' : a.situacao === 'CANCELADA' ? 'cancelada' : 'em preenchimento'}</small></div><span class="tag ${a.situacao === 'INICIADA' ? 'w' : ''}">${a.situacao === 'INICIADA' ? 'continuar' : 'abrir'}</span></div>`).join('')}</div>` : '<p class="muted">Nenhuma avaliação ainda.</p>'}`;
  } else {
    const eid = aba.replace('sub-', ''), e = esp(eid);
    if (!e) { ir('#/paciente/' + id + '/ficha'); return; }
    const sub = subpastas.find(s => s.especialidade_id === eid);
    const objs = (sub?.objetivo || []).filter(o => o.ativo);
    const porFase = (f) => objs.filter(o => o.fase === f);
    const bloco = (titulo, lista) => lista.length ? `<h4 style="margin:14px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)">${titulo} <span class="tag">${lista.length}</span></h4>${lista.map(cardObjetivo).join('')}` : '';
    const emAndamento = (pasta.sessoes || []).find(x => x.subpasta_id === sub?.id && x.situacao === 'INICIADA' && x.profissional_id === estado.eu.id);
    const treinaveis = objs.length;
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

  if (aba === 'evolucao') {
    const periodoAtual = () => sessionStorage.getItem('clia.periodo') || '90';
    const pintar = async (dias) => {
      sessionStorage.setItem('clia.periodo', dias);
      $('.main', app).innerHTML = await corpoEvolucao(p, dias);
      $('#perpac', app).onchange = (e) => pintar(e.target.value);
      const bc = $('#copiarevo', app);
      if (bc) bc.onclick = () => { const t = $('.card p', app).textContent; navigator.clipboard?.writeText(t).then(() => toast('Texto copiado.'), () => toast('Não consegui copiar; selecione o texto.')); };
    };
    pintar(periodoAtual());
  }
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
  app.querySelectorAll('[data-ver-av]').forEach(b => b.onclick = () => ir('#/avaliacao/' + b.dataset.verAv));
  const na = $('#novaav', app); if (na) na.onclick = () => novaAvaliacao(p);
  app.querySelectorAll('[data-fase-menu]').forEach(b => b.onclick = () => menuFase(b.dataset.faseMenu));
  app.querySelectorAll('[data-prox]').forEach(b => b.onclick = () => verProximos(b.dataset.prox, b.dataset.nome, p.id));
  app.querySelectorAll('[data-evo]').forEach(b => b.onclick = () => evolucaoObjetivo(b.dataset.evo, b.dataset.nome, '90'));
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
  const hist = alvos.flatMap(a => (a.alvo_evolucao || []).map(e => ({ ...e, alvo: a.nome }))).sort((x, y) => y.calculado_em.localeCompare(x.calculado_em));
  const proxManut = (a) => { const g = (a.manutencao_agenda || []).filter(m => !m.data_realizada).sort((x, y) => x.data_programada.localeCompare(y.data_programada))[0]; return g ? ` · próx. ${fmtData(g.data_programada)}` : ''; };
  const ultima = hist[0];
  return `<div class="obj"><div class="cab"><div><h5>${esc(o.nome)}</h5>
      <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap"><span class="tag ${FASES[o.fase][1]}">${FASES[o.fase][0]}</span>${tipo ? `<span class="tag">${esc(tipo.chave)}</span>` : ''}<span class="tag">${o.alvos_por_sessao} alvo(s)/sessão · ${o.tentativas_alvo} tent.</span></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn ghost sm" data-evo="${o.id}" data-nome="${esc(o.nome)}">Evolução</button>${o.fase === 'ADQUIRIDO' && possoConfigurar() ? `<button class="btn sm" data-prox="${o.id}" data-nome="${esc(o.nome)}">Próximos objetivos</button>` : ''}${possoConfigurar() ? `<button class="btn ghost sm" data-fase-menu="${o.id}">Mudar fase</button>` : ''}</div></div>
    ${alvos.length ? `<div class="alvos">${alvos.map(a => `<span class="tag ${FASES[a.fase][1]}" title="${FASES[a.fase][0]}${a.fase === 'MANUTENCAO' ? proxManut(a) : ''}">${esc(a.nome)}${a.fase === 'MANUTENCAO' ? proxManut(a) : ''}</span>`).join('')}</div>` : ''}
    ${ultima ? `<div class="evol ${ultima.resultado === 'REGREDIU' ? 'ruim' : ''}"><b>${fmtData(ultima.calculado_em.slice(0, 10))} · ${esc(ultima.alvo)}</b> ${esc(ultima.motivo)}</div>` : ''}
    <details><summary>Ver procedimento${hist.length ? ' e histórico' : ''}</summary>${campo('Objetivo', o.objetivo)}${campo('Instrução (Sd)', o.instrucao_sd)}${campo('Procedimento de ensino', o.procedimento_ensino)}${campo('Passo da dica', o.passo_dica)}${campo('Correção', o.procedimento_correcao)}${campo('Critério', o.criterio_aprendizado)}${campo('Materiais', o.materiais)}
      ${hist.length ? `<div class="campo"><b>Histórico de fases</b>${hist.slice(0, 12).map(e => `<div class="evol ${e.resultado === 'REGREDIU' ? 'ruim' : ''}" style="margin-top:4px"><b>${fmtData(e.calculado_em.slice(0, 10))} · ${esc(e.alvo)} · ${FASES[e.fase_anterior]?.[0] || e.fase_anterior} → ${FASES[e.fase_nova]?.[0] || e.fase_nova}</b> ${esc(e.motivo)}</div>`).join('')}</div>` : ''}</details></div>`;
}
function menuFase(objId) {
  modal(`<h3>Mudar fase do objetivo</h3><p class="muted" style="margin:0 0 10px;font-size:13px">Normalmente o app muda a fase sozinho pelo critério ao finalizar a sessão. Use aqui só quando precisar forçar; fica registrado no histórico com seu nome.</p>
    <form class="form" id="fm">
      <div><label>Nova fase (todos os alvos ativos)</label><select name="fase">${Object.entries(FASES).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></div>
      <div><label>Motivo</label><input name="motivo" placeholder="ex.: supervisão decidiu avançar" required></div>
      <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Mudar</button></div></form>`);
  $('#fm').onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    if (!online()) return toast('Mudança manual de fase precisa de internet.');
    const { data, error } = await sb.rpc('mudar_fase_manual', { p_objetivo: objId, p_fase: f.fase, p_motivo: f.motivo });
    if (error) return toast(error.message, 5000);
    fecharModal(); toast(`${data} alvo(s) alterado(s).`); render();
  };
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

// quais alvos entram hoje:
// - treino (linha de base e intervenção): até "alvos por sessão";
// - manutenção/generalização, e alvo já adquirido com manutenção marcada: entram além do limite,
//   mas só quando a data programada é hoje ou já passou.
function alvosDeHoje(o, agenda) {
  const alvos = (o.alvo || []).filter(a => a.ativo).sort((a, b) => a.ordem - b.ordem);
  const h = hoje();
  const pendente = (a) => (agenda || []).filter(g => g.alvo_id === a.id && !g.data_realizada);
  const treino = alvos.filter(a => a.fase === 'LINHA_BASE' || a.fase === 'INTERVENCAO').slice(0, Math.max(1, o.alvos_por_sessao || 1));
  const manut = alvos.filter(a => {
    if (a.fase === 'LINHA_BASE' || a.fase === 'INTERVENCAO') return false;
    const ag = pendente(a);
    if (a.fase === 'ADQUIRIDO') return ag.some(g => g.data_programada <= h);
    return ag.length ? ag.some(g => g.data_programada <= h) : true;
  });
  return [...treino, ...manut];
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
  // objetivo adquirido ainda entra se tiver manutenção pendente — alvosDeHoje decide o que aparece
  return (sub.objetivo || []).filter(o => o.ativo).map(o => ({ ...o, especialidade_id: sub.especialidade_id, niveis: niveisDo(o) }));
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
          const emManut = ['MANUTENCAO', 'GENERALIZACAO'].includes(a.fase) || (a.fase === 'ADQUIRIDO' && (pk.agenda || []).some(g => g.alvo_id === a.id && !g.data_realizada));
          return `<div class="alvo-linha"><div class="alvo-nome"><span class="tag ${FASES[a.fase][1]}" style="padding:1px 7px">${FASE_CURTA[a.fase] || ''}</span>${emManut ? ' <span class="tag w" style="padding:1px 7px">manutenção</span>' : ''} ${esc(a.nome)}${pA !== null ? ` <span class="muted">· ${pA}%</span>` : ''}</div><div class="tents">${cels}</div>${seletor}</div>`;
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
      fecharModal();
      const voltar = () => ir('#/paciente/' + ses.paciente_id + '/sub-' + (pk.especialidade_id || ''));
      if (r.pendente || falta) { toast(r.pendente ? 'Sessão guardada; sincroniza quando a internet voltar.' : 'Falta registrada.'); return voltar(); }
      // o motor de fases rodou no servidor ao finalizar: mostra o que decidiu
      const { data: dec } = await sb.from('alvo_evolucao').select('resultado,fase_anterior,fase_nova,motivo,alvo(nome)').eq('sessao_id', id).order('calculado_em');
      if (!dec || !dec.length) { toast('Sessão finalizada. Nenhuma mudança de fase.'); return voltar(); }
      // objetivos que ficaram inteiros adquiridos: dá para já pegar os próximos
      const { data: prontos } = await sb.from('objetivo').select('id,nome').eq('fase', 'ADQUIRIDO')
        .in('id', [...new Set(pk.objetivos.map(o => o.id))]);
      modal(`<h3>Sessão finalizada — ${dec.length} decisão(ões) do critério</h3>
        ${dec.map(e => `<div class="evol ${e.resultado === 'REGREDIU' ? 'ruim' : ''}" style="margin-bottom:6px"><b>${esc(e.alvo?.nome || '')} · ${FASES[e.fase_anterior]?.[0] || e.fase_anterior} → ${FASES[e.fase_nova]?.[0] || e.fase_nova}</b> ${esc(e.motivo)}</div>`).join('')}
        ${(prontos || []).length ? `<p class="muted" style="font-size:12.5px;margin:10px 0 6px">Objetivo concluído — quer ver o que vem depois?</p>${prontos.map(o => `<button class="btn ghost block" data-prox2="${o.id}" data-nome="${esc(o.nome)}" style="margin-bottom:6px;text-align:left">Próximos de "${esc(o.nome)}"</button>`).join('')}` : ''}
        <div class="acoes"><button class="btn" id="okdec">Entendi</button></div>`);
      document.querySelectorAll('[data-prox2]').forEach(b => b.onclick = () => { fecharModal(); verProximos(b.dataset.prox2, b.dataset.nome, ses.paciente_id); });
      $('#okdec').onclick = () => { fecharModal(); voltar(); };
    };
  };
  desenhar();
};
function rotGrau(g) { return { MAIS_INTRUSIVA: 'ajuda total', PARCIAL_INTRUSIVA: 'ajuda parcial', MENOS_INTRUSIVA: 'ajuda leve', INDEPENDENTE: 'independente', ERRO: 'erro', OMISSAO: 'omissão' }[g] || ''; }

// ----------------------------------------------------------------- avaliação
async function novaAvaliacao(p) {
  const { data: prots } = await sb.from('protocolo').select('id,nome,tipo').eq('ativo', true).order('nome');
  modal(`<h3>Nova avaliação — ${esc(p.nome)}</h3>
    <p class="muted" style="margin:0 0 10px;font-size:13px">Aplique o protocolo no formulário original e registre aqui o resultado de cada item. Ao finalizar, o app mostra os objetivos sugeridos.</p>
    <form class="form" id="fa">
      <div><label>Protocolo</label><select name="protocolo_id" required>${(prots || []).map(x => `<option value="${x.id}">${esc(x.nome)}${x.tipo === 'REDUCAO' ? ' (comportamento-problema)' : ''}</option>`).join('')}</select></div>
      <div><label>Data da aplicação</label>${campoData('data_avaliacao', hoje())}</div>
      <div><label>Observações</label><input name="observacoes"></div>
      <div class="acoes"><button type="button" class="btn ghost" data-fechar>Cancelar</button><button class="btn">Começar</button></div></form>`);
  $('#fa').onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    const d = lerDatas(ev.target);
    const reg = { id: uuid(), paciente_id: p.id, protocolo_id: f.protocolo_id, aplicador_id: estado.eu.id,
      data_avaliacao: d.data_avaliacao || hoje(), situacao: 'INICIADA', observacoes: f.observacoes || null };
    const r = await gravar('avaliacao', reg);
    if (!r.ok) return toast('Não foi possível criar: ' + r.erro, 6000);
    fecharModal(); ir('#/avaliacao/' + reg.id);
  };
}

rotas.avaliacao = async (app, id) => {
  app.innerHTML = shell('<div class="spinner"></div>', 'pacientes');
  const pk = await ler('avaliacao:' + id, async () => {
    const { data: av, error } = await sb.from('avaliacao').select('*, protocolo(id,nome,tipo), paciente(id,nome)').eq('id', id).single();
    if (error) return { error };
    const [{ data: itens }, { data: pont }, { data: niveis }, { data: habs }, { data: resp }] = await Promise.all([
      sb.from('protocolo_item').select('id,nivel_id,habilidade_id,marco,numero_item,ordem,texto,grupo_pontuacao,inverso').eq('protocolo_id', av.protocolo_id).eq('ativo', true).order('ordem'),
      sb.from('protocolo_pontuacao').select('id,grupo,ordem,rotulo,tipo_resposta,valor_pct').eq('protocolo_id', av.protocolo_id).order('ordem'),
      sb.from('protocolo_nivel').select('id,ordem,nome').eq('protocolo_id', av.protocolo_id).order('ordem'),
      sb.from('protocolo_habilidade').select('id,ordem,nome').eq('protocolo_id', av.protocolo_id).order('ordem'),
      sb.from('avaliacao_resposta').select('id,item_id,pontuacao_id,observacao').eq('avaliacao_id', id),
    ]);
    return { data: { av, itens: itens || [], pont: pont || [], niveis: niveis || [], habs: habs || [], resp: resp || [] }, error: null };
  });
  if (!pk) { $('.main', app).innerHTML = '<p class="erro">Avaliação não encontrada neste aparelho e sem conexão.</p>'; return; }
  const { av, itens, pont, niveis, habs } = pk;
  const fechada = av.situacao !== 'INICIADA';
  const podeEditar = !fechada && possoConfigurar();
  const corte = +estado.regras.PONTO_DE_CORTE || 75;
  const resp = (itemId) => pk.resp.find(r => r.item_id === itemId);
  const escalaDe = (it) => pont.filter(x => x.grupo === (it.grupo_pontuacao || 0)).sort((a, b) => a.ordem - b.ordem);
  const nome = (lista, id2) => lista.find(x => x.id === id2)?.nome || '';
  const grupos = [];
  for (const it of itens) {
    const chave = (it.nivel_id || '') + '|' + (it.habilidade_id || '');
    let g = grupos.find(x => x.chave === chave);
    if (!g) { g = { chave, nivel: nome(niveis, it.nivel_id), hab: nome(habs, it.habilidade_id), itens: [] }; grupos.push(g); }
    g.itens.push(it);
  }
  let abertos = new Set();

  const desenhar = () => {
    const respondidos = pk.resp.length;
    const abaixo = pk.resp.filter(r => { const it = itens.find(i => i.id === r.item_id); const p = pctResposta(r, it, pont); return p !== null && p < corte; }).length;
    const blocos = grupos.map((g, gi) => {
      const feitos = g.itens.filter(i => resp(i.id)).length;
      const aberto = abertos.has(gi);
      return `<div class="grupo-av"><button class="cab-grupo" data-g="${gi}">
          <span><b>${esc(g.hab || g.nivel || 'Itens')}</b>${g.nivel && g.hab ? ` <span class="muted">· ${esc(g.nivel)}</span>` : ''}</span>
          <span class="tag ${feitos === g.itens.length ? 'b' : ''}">${feitos}/${g.itens.length}</span></button>
        ${aberto ? g.itens.map(it => {
          const r = resp(it.id), esc0 = escalaDe(it);
          const p = r ? pctResposta(r, it, pont) : null;
          return `<div class="item-av ${p === null ? '' : p < corte ? 'baixo' : 'ok'}">
            <div class="item-txt">${it.marco ? `<span class="tag">${esc(it.marco)}</span> ` : ''}${esc(it.texto)}${it.inverso ? ' <span class="tag w" title="pontuação alta = dificuldade">invertido</span>' : ''}</div>
            <div class="escala">${esc0.map(x => `<button class="nota ${r && r.pontuacao_id === x.id ? 'on' : ''}" data-item="${it.id}" data-pont="${x.id}" ${podeEditar ? '' : 'disabled'} title="${esc(x.tipo_resposta || '')}">${esc(x.rotulo)}</button>`).join('')}${r && podeEditar ? `<button class="nota limpar" data-item="${it.id}" data-limpar>apagar</button>` : ''}</div></div>`;
        }).join('') : ''}</div>`;
    }).join('');
    $('.main', app).innerHTML = `
      <div class="phead"><div><p style="margin:0"><button class="link" onclick="location.hash='#/paciente/${av.paciente_id}/avaliacoes'">← ${esc(av.paciente?.nome || 'Paciente')}</button></p>
        <h1>${esc(av.protocolo?.nome || 'Avaliação')}</h1>
        <p>${fmtData(av.data_avaliacao)} · ${respondidos} de ${itens.length} itens${respondidos ? ` · ${abaixo} abaixo de ${corte}%` : ''}${fechada ? ' · finalizada' : ''}</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${fechada ? `<button class="btn" id="props">Ver objetivos sugeridos</button>` : (podeEditar && respondidos ? `<button class="btn" id="fimav">Finalizar e sugerir objetivos</button>` : '')}</div></div>
      ${podeEditar ? `<p class="muted" style="font-size:12.5px;margin:0 0 10px">Abra um bloco e toque na nota de cada item. Não precisa responder tudo — só o que foi aplicado. Itens abaixo de ${corte}% viram sugestão de objetivo.</p>` : ''}
      <div class="busca"><input id="qav" placeholder="Procurar item…" autocomplete="off"><button class="btn ghost sm" id="abretudo">abrir/fechar tudo</button></div>
      ${blocos}`;
    app.querySelectorAll('.cab-grupo').forEach(b => b.onclick = () => { const g = +b.dataset.g; abertos.has(g) ? abertos.delete(g) : abertos.add(g); desenhar(); });
    app.querySelectorAll('.nota').forEach(b => b.onclick = () => responder(b.dataset.item, b.hasAttribute('data-limpar') ? null : b.dataset.pont));
    const bt = $('#abretudo', app); if (bt) bt.onclick = () => { if (abertos.size) abertos = new Set(); else grupos.forEach((_, i) => abertos.add(i)); desenhar(); };
    const bq = $('#qav', app); if (bq) bq.oninput = () => {
      const q = bq.value.trim().toLowerCase();
      if (q.length < 2) return;
      abertos = new Set(grupos.map((g, i) => g.itens.some(it => it.texto.toLowerCase().includes(q)) ? i : -1).filter(i => i >= 0));
      const v2 = bq.value; desenhar(); const n = $('#qav', app); n.value = v2; n.focus();
    };
    const bf = $('#fimav', app); if (bf) bf.onclick = () => finalizarAvaliacao();
    const bp = $('#props', app); if (bp) bp.onclick = () => verPropostas(av, id);
  };

  const responder = async (itemId, pontId) => {
    const atual = resp(itemId);
    if (!pontId) {
      if (atual) { pk.resp = pk.resp.filter(r => r !== atual); await DB.set('avaliacao:' + id, pk); sb.from('avaliacao_resposta').delete().eq('id', atual.id).then(() => {}); }
      return desenhar();
    }
    const reg = { id: atual?.id || uuid(), avaliacao_id: id, item_id: itemId, pontuacao_id: pontId };
    if (atual) Object.assign(atual, reg); else pk.resp.push(reg);
    await DB.set('avaliacao:' + id, pk);
    desenhar();
    const r = await gravar('avaliacao_resposta', reg);
    if (!r.ok) toast('Resposta não gravada: ' + r.erro, 5000);
  };

  const finalizarAvaliacao = () => {
    const faltam = itens.length - pk.resp.length;
    modal(`<h3>Finalizar avaliação</h3>
      <p class="muted" style="margin:0 0 10px;font-size:13px">${faltam ? `${faltam} item(ns) sem resposta — eles ficam de fora das sugestões.` : 'Todos os itens foram respondidos.'}</p>
      <form class="form" id="ffa"><div><label>Observações da avaliação</label><textarea name="observacoes">${esc(av.observacoes)}</textarea></div>
      <div class="acoes"><button type="button" class="btn ghost" data-fechar>Voltar</button><button class="btn">Finalizar</button></div></form>`);
    $('#ffa').onsubmit = async (ev) => {
      ev.preventDefault();
      if (!online()) return toast('Para finalizar e gerar as sugestões é preciso estar com internet.');
      const up = { id, situacao: 'FINALIZADA', observacoes: new FormData(ev.target).get('observacoes') || null };
      const { error } = await sb.from('avaliacao').update(up).eq('id', id);
      if (error) return toast(error.message, 5000);
      Object.assign(av, up); await DB.set('avaliacao:' + id, pk);
      fecharModal(); verPropostas(av, id);
    };
  };
  desenhar();
};

// quando um objetivo é concluído: o que treinar em seguida
async function verProximos(objetivoId, nomeObjetivo, pacienteId) {
  modal('<h3>Próximos objetivos</h3><div class="spinner"></div>');
  const { data, error } = await sb.rpc('sugerir_proximos', { p_objetivo: objetivoId });
  if (error) { fecharModal(); return toast(error.message, 6000); }
  const props = data || [];
  const escolhidos = new Set(props.filter(p => p.origem === 'ITEM').map(p => p.programa_id));
  const desenhar = () => {
    const box = $('#modal .box');
    box.innerHTML = `<h3>Próximos objetivos</h3>
      <p class="muted" style="margin:0 0 10px;font-size:13px">Depois de "${esc(nomeObjetivo)}". ${props.length ? 'Os que vêm do item seguinte do protocolo já vêm marcados; os "por área" são parecidos, confira antes.' : ''}</p>
      ${props.length ? `<div class="lista" style="max-height:48vh;overflow:auto">${props.map(p => `<div class="it prop ${escolhidos.has(p.programa_id) ? 'on' : ''}" data-pg="${p.programa_id}" style="cursor:pointer">
        <div><b>${escolhidos.has(p.programa_id) ? '☑' : '☐'} ${esc(p.programa_nome)}</b>
        <small>${p.origem === 'ITEM' ? 'próximo item do protocolo' : 'por área (confira)'}${p.especialidade ? ' · ' + esc(p.especialidade) : ''}${p.item_texto ? ' · ' + esc(p.item_texto.slice(0, 80)) : ''}</small></div></div>`).join('')}</div>`
        : '<p class="muted">Não achei um próximo passo automático para este objetivo. Use "+ Objetivo do catálogo" na subpasta.</p>'}
      <div class="acoes"><button type="button" class="btn ghost" data-fechar>Fechar</button>${props.length ? `<button class="btn" id="addprox">Adicionar ${escolhidos.size}</button>` : ''}</div>`;
    box.querySelectorAll('.prop').forEach(b => b.onclick = () => { const k = b.dataset.pg; escolhidos.has(k) ? escolhidos.delete(k) : escolhidos.add(k); desenhar(); });
    const ba = $('#addprox'); if (ba) ba.onclick = async () => {
      if (!escolhidos.size) return toast('Marque pelo menos um.');
      const { data: n, error: e2 } = await sb.rpc('criar_objetivos_das_propostas',
        { p_paciente: pacienteId, p_avaliacao: null, p_programas: [...escolhidos] });
      if (e2) return toast(e2.message, 6000);
      fecharModal(); toast(`${n} objetivo(s) adicionado(s).`); render();
    };
  };
  desenhar();
}

// % de uma resposta (espelha resposta_pct do banco: normaliza a escala e inverte se o item for invertido)
function pctResposta(r, it, pont) {
  const p = pont.find(x => x.id === r.pontuacao_id);
  if (!p) return r.valor_pct ?? null;
  const grupo = pont.filter(x => x.grupo === p.grupo);
  const min = Math.min(...grupo.map(x => +x.valor_pct)), max = Math.max(...grupo.map(x => +x.valor_pct));
  let v2 = max > min ? 100 * (+p.valor_pct - min) / (max - min) : +p.valor_pct;
  if (it && it.inverso) v2 = 100 - v2;
  return Math.round(v2 * 100) / 100;
}

async function verPropostas(av, avaliacaoId) {
  const app = $('#app');
  app.innerHTML = shell('<div class="spinner"></div>', 'pacientes');
  const { data, error } = await sb.rpc('propor_objetivos', { p_avaliacao: avaliacaoId, p_especialidade: null });
  if (error) { $('.main', app).innerHTML = `<p class="erro">${esc(error.message)}</p>`; return; }
  const props = data || [];
  const porEsp = [];
  for (const p of props) {
    let g = porEsp.find(x => x.id === p.especialidade_id);
    if (!g) { g = { id: p.especialidade_id, nome: p.especialidade || 'Sem especialidade', itens: [] }; porEsp.push(g); }
    g.itens.push(p);
  }
  const escolhidos = new Set(props.filter(p => p.origem === 'ITEM').map(p => p.programa_id));
  const desenhar = () => {
    $('.main', app).innerHTML = `
      <div class="phead"><div><p style="margin:0"><button class="link" onclick="location.hash='#/paciente/${av.paciente_id}/avaliacoes'">← ${esc(av.paciente?.nome || 'Paciente')}</button></p>
        <h1>Objetivos sugeridos</h1><p>${esc(av.protocolo?.nome || '')} · ${props.length} sugestão(ões) a partir dos itens abaixo de ${+estado.regras.PONTO_DE_CORTE || 75}%</p></div>
        <button class="btn" id="aplicar">Adicionar ${escolhidos.size} à pasta</button></div>
      ${props.length ? '' : '<p class="muted">Nenhum item ficou abaixo do ponto de corte — nada a sugerir.</p>'}
      <p class="muted" style="font-size:12.5px;margin:0 0 12px">Vêm marcados os que ligam direto ao item da avaliação. Os marcados como "por área" são parecidos, confira antes. Eles entram em linha de base, na subpasta da especialidade.</p>
      ${porEsp.map(g => `<div class="card" style="margin-bottom:12px"><div class="phead" style="margin-bottom:8px"><h3>${esc(g.nome)}</h3><span class="tag">${g.itens.filter(p => escolhidos.has(p.programa_id)).length} de ${g.itens.length}</span></div>
        <div class="lista">${g.itens.map(p => `<div class="it prop ${escolhidos.has(p.programa_id) ? 'on' : ''}" data-pg="${p.programa_id}" style="cursor:pointer">
          <div><b>${escolhidos.has(p.programa_id) ? '☑' : '☐'} ${esc(p.programa_nome)}</b>
          <small>${p.origem === 'ITEM' ? 'ligado ao item' : 'por área (confira)'} · ${esc(p.habilidade || p.nivel || '')} · ${esc((p.item_texto || '').slice(0, 90))}${p.resposta_pct > 0 ? ` · pontuou ${p.resposta_pct}%` : ' · não pontuou'}</small></div></div>`).join('')}</div></div>`).join('')}`;
    app.querySelectorAll('.prop').forEach(b => b.onclick = () => { const k = b.dataset.pg; escolhidos.has(k) ? escolhidos.delete(k) : escolhidos.add(k); desenhar(); });
    $('#aplicar', app).onclick = async () => {
      if (!escolhidos.size) return toast('Marque pelo menos um objetivo.');
      const { data: n, error: e2 } = await sb.rpc('criar_objetivos_das_propostas',
        { p_paciente: av.paciente_id, p_avaliacao: avaliacaoId, p_programas: [...escolhidos] });
      if (e2) return toast(e2.message, 6000);
      toast(`${n} objetivo(s) adicionado(s) nas subpastas.`, 4000);
      ir('#/paciente/' + av.paciente_id + '/avaliacoes');
    };
  };
  desenhar();
}

// ----------------------------------------------------------------- evolução
const PERIODOS = [['30', 'últimos 30 dias'], ['90', 'últimos 3 meses'], ['180', 'últimos 6 meses'], ['', 'tudo']];
function desde(dias) { if (!dias) return null; const d = new Date(); d.setDate(d.getDate() - (+dias)); return d.toISOString().slice(0, 10); }

// gráfico de linha simples em SVG: pontos {d: 'AAAA-MM-DD', v: 0..100}
function grafico(series, corte) {
  const todos = series.flatMap(s => s.pontos);
  if (todos.length < 1) return '<p class="muted" style="font-size:12.5px">Sem sessões registradas no período.</p>';
  const datas = [...new Set(todos.map(p => p.d))].sort();
  const L = 34, R = 10, T = 10, B = 26, W = 560, H = 170;
  const px = (d) => datas.length < 2 ? L + (W - L - R) / 2 : L + (W - L - R) * datas.indexOf(d) / (datas.length - 1);
  const py = (v) => T + (H - T - B) * (1 - v / 100);
  const cores = ['var(--brand)', '#b45309', '#1d4ed8', '#9333ea', '#be123c', '#0f766e'];
  const linhas = series.map((s, i) => {
    const ps = s.pontos.slice().sort((a, b) => a.d.localeCompare(b.d));
    if (!ps.length) return '';
    const dd = ps.map(p => `${px(p.d)},${py(p.v)}`).join(' ');
    return `<polyline points="${dd}" fill="none" stroke="${cores[i % cores.length]}" stroke-width="2" stroke-linejoin="round"/>
      ${ps.map(p => `<circle cx="${px(p.d)}" cy="${py(p.v)}" r="3" fill="${cores[i % cores.length]}"><title>${esc(s.nome)} · ${fmtData(p.d)} · ${p.v}%</title></circle>`).join('')}`;
  }).join('');
  const marcasY = [0, 50, 100].map(v => `<line x1="${L}" y1="${py(v)}" x2="${W - R}" y2="${py(v)}" stroke="var(--line)" stroke-dasharray="2 3"/><text x="4" y="${py(v) + 4}" font-size="10" fill="var(--ink3)">${v}%</text>`).join('');
  const mostra = datas.length <= 6 ? datas : [datas[0], datas[Math.floor(datas.length / 2)], datas[datas.length - 1]];
  const marcasX = mostra.map(d => `<text x="${px(d)}" y="${H - 8}" font-size="10" fill="var(--ink3)" text-anchor="middle">${fmtData(d).slice(0, 5)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="graf" role="img">${marcasY}
    <line x1="${L}" y1="${py(corte)}" x2="${W - R}" y2="${py(corte)}" stroke="var(--brand)" stroke-width="1.5" stroke-dasharray="5 3" opacity=".6"/>
    <text x="${W - R}" y="${py(corte) - 4}" font-size="10" fill="var(--brand-3)" text-anchor="end">critério ${corte}%</text>
    ${marcasX}${linhas}</svg>
    ${series.length > 1 ? `<div class="legenda">${series.map((s, i) => `<span><i style="background:${cores[i % cores.length]}"></i>${esc(s.nome)}</span>`).join('')}</div>` : ''}`;
}

async function evolucaoObjetivo(objetivoId, nomeObjetivo, dias) {
  modal('<h3>Evolução</h3><div class="spinner"></div>');
  const d = desde(dias);
  const [{ data: porAlvo }, { data: porObj }] = await Promise.all([
    sb.rpc('evolucao_alvo', { p_objetivo: objetivoId, p_desde: d }),
    sb.rpc('evolucao_objetivo', { p_objetivo: objetivoId, p_desde: d }),
  ]);
  const corte = +estado.regras.CRIT_PCT || 80;
  const alvos = [];
  for (const r of porAlvo || []) {
    let g = alvos.find(x => x.id === r.alvo_id);
    if (!g) { g = { id: r.alvo_id, nome: r.alvo, fase: r.fase, pontos: [] }; alvos.push(g); }
    if (r.pct !== null) g.pontos.push({ d: r.data_sessao, v: +r.pct });
  }
  const serieObj = [{ nome: 'objetivo', pontos: (porObj || []).filter(r => r.pct !== null).map(r => ({ d: r.data_sessao, v: +r.pct })) }];
  const box = $('#modal .box');
  box.innerHTML = `<h3>Evolução — ${esc(nomeObjetivo)}</h3>
    <div class="busca"><select id="perevo">${PERIODOS.map(([v, t]) => `<option value="${v}" ${v === String(dias ?? '') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <b style="font-size:12px;color:var(--ink3)">O OBJETIVO AO LONGO DO TEMPO</b>
    ${grafico(serieObj, corte)}
    ${alvos.length > 1 ? `<b style="font-size:12px;color:var(--ink3);display:block;margin-top:14px">ALVO A ALVO</b>${grafico(alvos, corte)}` : ''}
    <b style="font-size:12px;color:var(--ink3);display:block;margin-top:14px">SESSÕES</b>
    <div class="lista" style="max-height:30vh;overflow:auto">${(porObj || []).slice().reverse().map(r => `<div class="it" style="cursor:default"><div><b>${fmtData(r.data_sessao)} · ${r.pct}%</b><small>${r.independentes} de ${r.tentativas} independentes${r.profissional ? ' · ' + esc(r.profissional) : ''}${r.fase ? ' · passou para ' + (FASES[r.fase]?.[0] || r.fase) : ''}</small></div></div>`).join('') || '<p class="muted">Sem sessões no período.</p>'}</div>
    <div class="acoes"><button type="button" class="btn ghost" data-fechar>Fechar</button></div>`;
  $('#perevo').onchange = (e) => evolucaoObjetivo(objetivoId, nomeObjetivo, e.target.value);
}

async function corpoEvolucao(p, dias) {
  const d = desde(dias);
  const [{ data: resumo }, { data: marcos }] = await Promise.all([
    sb.rpc('resumo_paciente', { p_paciente: p.id, p_desde: d, p_especialidade: null }),
    sb.rpc('marcos_paciente', { p_paciente: p.id, p_desde: d }),
  ]);
  const rs = resumo || [], ms = marcos || [];
  const total = rs.reduce((a, r) => a + r.sessoes, 0), faltas = rs.reduce((a, r) => a + r.faltas, 0);
  const adq = rs.reduce((a, r) => a + r.adquiridos_no_periodo, 0), al = rs.reduce((a, r) => a + r.alertas, 0);
  const periodo = PERIODOS.find(x => x[0] === String(dias ?? ''))?.[1] || 'o período';
  const frases = [];
  frases.push(`Nos ${periodo}, ${esc(p.nome)} teve ${total} sessão(ões) registrada(s)${faltas ? ` e ${faltas} falta(s)` : ''}.`);
  if (adq) frases.push(`${adq} alvo(s) atingiram o critério e foram marcados como adquiridos.`);
  if (al) frases.push(`${al} alvo(s) tiveram queda de desempenho e estão sinalizados para revisão do nível de ajuda ou do procedimento.`);
  const ativas = rs.filter(r => r.sessoes || r.objetivos_ativos);
  if (ativas.length) frases.push('Por especialidade: ' + ativas.map(r =>
    `${r.especialidade} — ${r.objetivos_ativos} objetivo(s) ativo(s)` +
    (r.pct_geral !== null ? `, ${r.pct_geral}% de respostas independentes` : ', sem sessões no período') +
    ` (${r.em_linha_base} em linha de base, ${r.em_intervencao} em intervenção, ${r.adquiridos} adquirido(s))`).join('; ') + '.');
  return `<div class="phead" style="margin-bottom:10px"><div><h3>Evolução</h3><p class="muted">Números das sessões registradas no app. A evolução clínica de cada atendimento continua no Métodos.</p></div>
      <select id="perpac">${PERIODOS.map(([v, t]) => `<option value="${v}" ${v === String(dias ?? '') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="card" style="margin-bottom:12px"><b style="font-size:12px;color:var(--ink3)">RESUMO</b>
      <p style="margin:6px 0 0;font-size:13.5px;line-height:1.55">${frases.join(' ')}</p>
      <div class="acoes" style="margin-top:10px"><button class="btn ghost sm" id="copiarevo">Copiar texto</button></div></div>
    ${rs.filter(r => r.objetivos_ativos).map(r => `<div class="card" style="margin-bottom:10px"><div class="phead" style="margin-bottom:6px"><h3>${esc(r.especialidade)}</h3><span class="tag ${r.pct_geral >= (+estado.regras.CRIT_PCT || 80) ? 'b' : ''}">${r.pct_geral !== null ? r.pct_geral + '% independentes' : 'sem sessões'}</span></div>
      <dl class="dl"><dt>Sessões</dt><dd>${r.sessoes}${r.faltas ? ` (+${r.faltas} falta(s))` : ''} · ${r.tentativas} tentativa(s)</dd>
        <dt>Objetivos</dt><dd>${r.em_linha_base} linha de base · ${r.em_intervencao} intervenção · ${r.em_manutencao} manutenção · ${r.adquiridos} adquirido(s)</dd>
        <dt>No período</dt><dd>${r.adquiridos_no_periodo} alvo(s) adquirido(s)${r.alertas ? ` · ${r.alertas} alerta(s) de queda` : ''}</dd></dl></div>`).join('')}
    <h3 style="margin:18px 0 8px;font-size:14px">O que mudou</h3>
    ${ms.length ? `<div class="lista">${ms.slice(0, 40).map(m => `<div class="it" style="cursor:default"><div><b>${fmtData(m.quando)} · ${esc(m.especialidade)} · ${esc(m.alvo)}</b><small>${esc(m.objetivo)} — ${esc(m.motivo)}</small></div><span class="tag ${m.resultado === 'REGREDIU' ? 'w' : 'b'}">${FASES[m.fase_nova]?.[0] || m.fase_nova}</span></div>`).join('')}</div>` : '<p class="muted">Nenhuma mudança de fase no período.</p>'}`;
}

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

// ----------------------------------------------------------------- painel da direção
const podeVerPainel = () => ['direcao', 'supervisor'].includes(estado.eu?.perfil);
const ABAS_DIR = [['alertas', 'O que precisa de atenção'], ['numeros', 'Números'], ['pacientes', 'Pacientes'], ['equipe', 'Equipe']];
const GRAV = { 3: ['urg', 'Urgente'], 2: ['ate', 'Atenção'], 1: ['avi', 'Aviso'] };

function filtrosPainel(dias, unidade) {
  const sel = (id, ops, v) => `<select id="${id}">${ops.map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  return `<div class="busca">
    ${sel('pdias', [['30', 'últimos 30 dias'], ['60', 'últimos 2 meses'], ['90', 'últimos 3 meses'], ['180', 'últimos 6 meses']], dias)}
    ${souDirecao() ? sel('punid', [['', 'Todas as unidades'], ...estado.unidades.map(u => [u.id, u.nome])], unidade) : ''}
  </div>`;
}

rotas.direcao = async (app, aba = 'alertas') => {
  if (!podeVerPainel()) return rotas.pacientes(app);
  const dias = sessionStorage.getItem('pdias') || '30';
  const unid = souDirecao() ? (sessionStorage.getItem('punid') || '') : '';
  const abas = ABAS_DIR.map(([k, t]) => `<button class="${k === aba ? 'on' : ''}" onclick="location.hash='#/direcao/${k}'">${esc(t)}</button>`).join('');
  app.innerHTML = shell(`<div class="phead"><div><h1>Painel da direção</h1>
      <p>${souDirecao() ? 'Todas as unidades da CLIA.' : 'Sua unidade.'} Nada aqui muda o prontuário — é só leitura do que a equipe já registrou.</p></div></div>
    <div class="abas">${abas}</div>
    ${filtrosPainel(dias, unid)}
    <div id="corpo"><div class="spinner"></div></div>`, 'direcao');
  const trocar = (id) => { const el = $('#' + id, app); if (el) el.onchange = () => { sessionStorage.setItem(id, el.value); rotas.direcao(app, aba); }; };
  trocar('pdias'); trocar('punid');
  const alvo = $('#corpo', app);
  const u = unid || null;
  try {
    if (aba === 'numeros') await painelNumeros(alvo, dias, u);
    else if (aba === 'pacientes') await painelPacientes(alvo, dias, u);
    else if (aba === 'equipe') await painelEquipe(alvo, dias, u);
    else await painelAlertas(alvo, dias, u);
  } catch (e) {
    alvo.innerHTML = `<div class="card"><p class="muted">Não consegui carregar: ${esc(e.message || String(e))}</p></div>`;
  }
};

async function painelAlertas(alvo, dias, u) {
  const linhas = await ler('painel_alertas_' + dias + '_' + (u || 'all'),
    () => sb.rpc('alertas_direcao', { p_unidade: u, p_dias: +dias })) || [];
  if (!linhas.length) {
    alvo.innerHTML = '<div class="card"><p class="muted">Nenhum alerta. Nenhum paciente parado, nenhuma manutenção atrasada e nenhuma sessão esquecida aberta.</p></div>';
    return;
  }
  const porTipo = {};
  linhas.forEach(l => { (porTipo[l.tipo] = porTipo[l.tipo] || { rotulo: l.rotulo, gravidade: l.gravidade, itens: [] }).itens.push(l); });
  const ordem = Object.values(porTipo).sort((a, b) => b.gravidade - a.gravidade || b.itens.length - a.itens.length);
  const resumo = ordem.map(g => `<span class="pill ${GRAV[g.gravidade][0]}">${esc(g.rotulo)} <b>${g.itens.length}</b></span>`).join('');
  alvo.innerHTML = `<div class="pills">${resumo}</div>` + ordem.map(g => `
    <div class="card bloco-al ${GRAV[g.gravidade][0]}">
      <div class="cab-al"><h3>${esc(g.rotulo)}</h3><span class="tag ${GRAV[g.gravidade][0]}">${GRAV[g.gravidade][1]}</span><span class="muted">${g.itens.length}</span></div>
      <div class="lista">${g.itens.map(l => `<div class="it" data-p="${l.paciente_id}">
        <div><b>${esc(l.paciente)}</b><small>${[l.especialidade, l.profissional, l.objetivo].filter(Boolean).map(esc).join(' · ')}</small>
        <div class="muted" style="font-size:12.5px;margin-top:3px">${esc(l.detalhe || '')}</div></div>
        ${l.dias != null ? `<span class="dias">${l.dias}<small>${l.tipo === 'FALTAS' ? 'faltas' : 'dias'}</small></span>` : ''}
      </div>`).join('')}</div>
    </div>`).join('');
  alvo.querySelectorAll('.it[data-p]').forEach(el => { el.onclick = () => ir('#/paciente/' + el.dataset.p + '/evolucao'); });
}

async function painelNumeros(alvo, dias, u) {
  const nums = await ler('painel_num_' + dias + '_' + (u || 'all'),
    () => sb.rpc('painel_numeros', { p_dias: +dias, p_unidade: u })) || [];
  const v = (k) => nums.find(n => n.chave === k) || {};
  const num = (x) => String(x).replace('.', ',');
  const PCT = ['independencia'];
  const fmt = (n) => n.valor == null ? '—' : (PCT.includes(n.chave) ? num(n.valor) + '%' : num(n.valor));
  const cartao = (k) => { const n = v(k); return `<div class="stat"><span class="n">${fmt(n)}</span><span class="r">${esc(n.rotulo || '')}</span>${n.detalhe ? `<span class="d">${esc(n.detalhe)}</span>` : ''}</div>`; };
  const fases = ['linha_base', 'intervencao', 'manutencao', 'adquirido'];
  const tot = fases.reduce((s, k) => s + (+v(k).valor || 0), 0) || 1;
  alvo.innerHTML = `
    <div class="stats">${['pacientes', 'sessoes', 'faltas', 'independencia', 'objetivos', 'equipe'].map(cartao).join('')}</div>
    <div class="card"><h3 style="margin:0 0 10px">Onde estão os objetivos</h3>
      <div class="barra">${fases.map((k, i) => { const n = +v(k).valor || 0; return n ? `<span class="f f${i}" style="width:${100 * n / tot}%" title="${esc(v(k).rotulo)}: ${n}"></span>` : ''; }).join('')}</div>
      <div class="legfase">${fases.map((k, i) => `<span><i class="f${i}"></i>${esc(v(k).rotulo)} <b>${v(k).valor ?? 0}</b></span>`).join('')}</div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">${esc(v('adquirido').detalhe || '')}. Objetivo em linha de base por muito tempo aparece como alerta na primeira aba.</p>
    </div>`;
}

async function painelPacientes(alvo, dias, u) {
  const linhas = await ler('painel_pac_' + dias + '_' + (u || 'all'),
    () => sb.rpc('panorama_pacientes', { p_dias: +dias, p_unidade: u })) || [];
  if (!linhas.length) { alvo.innerHTML = '<div class="card"><p class="muted">Nenhum paciente ativo.</p></div>'; return; }
  alvo.innerHTML = `<div class="card tabela"><table class="tb"><thead><tr>
      <th>Paciente</th><th>Fases</th><th class="c">Sessões</th><th class="c">Faltas</th><th class="c">Indep.</th><th class="c">Adquir.</th><th>Última sessão</th></tr></thead><tbody>
    ${linhas.map(l => `<tr data-p="${l.paciente_id}">
      <td><b>${esc(l.paciente)}</b><br><small class="muted">${esc(l.unidade || '')} · ${l.especialidades} especialidade(s) · ${l.objetivos} objetivo(s)</small></td>
      <td><span class="mini lb">${l.linha_base}</span><span class="mini iv">${l.intervencao}</span><span class="mini mn">${l.manutencao}</span><span class="mini ad">${l.adquirido}</span></td>
      <td class="c">${l.sessoes}</td>
      <td class="c ${l.faltas >= 3 ? 'ruim' : ''}">${l.faltas}</td>
      <td class="c">${l.pct == null ? '—' : String(l.pct).replace('.', ',') + '%'}</td>
      <td class="c">${l.adquiridos_periodo || '—'}</td>
      <td>${l.ultima_sessao ? fmtData(l.ultima_sessao) + ` <small class="muted">(${l.dias}d)</small>` : '<span class="ruim">nunca</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted" style="font-size:12.5px">LB = linha de base · INT = intervenção · MAN = manutenção · ADQ = adquirido. Clique numa linha para abrir a evolução do paciente.</p>`;
  alvo.querySelectorAll('tr[data-p]').forEach(el => { el.onclick = () => ir('#/paciente/' + el.dataset.p + '/evolucao'); });
}

async function painelEquipe(alvo, dias, u) {
  const linhas = (await ler('painel_eq_' + dias + '_' + (u || 'all'),
    () => sb.rpc('producao_equipe', { p_dias: +dias, p_unidade: u })) || [])
    .filter(l => !['recepcao', 'Recepção'].includes(l.perfil) || l.sessoes);
  if (!linhas.length) { alvo.innerHTML = '<div class="card"><p class="muted">Ninguém cadastrado ainda.</p></div>'; return; }
  alvo.innerHTML = `<div class="card tabela"><table class="tb"><thead><tr>
      <th>Profissional</th><th class="c">Pacientes</th><th class="c">Sessões</th><th class="c">Faltas</th><th class="c">Tentativas</th><th class="c">Indep.</th><th class="c">Objetivos</th><th>Última sessão</th></tr></thead><tbody>
    ${linhas.map(l => `<tr>
      <td><b>${esc(l.profissional)}</b><br><small class="muted">${[l.perfil, l.especialidade, l.unidade].filter(Boolean).map(esc).join(' · ')}</small></td>
      <td class="c">${l.pacientes}</td><td class="c">${l.sessoes}</td><td class="c">${l.faltas}</td>
      <td class="c">${l.tentativas}</td><td class="c">${l.pct == null ? '—' : String(l.pct).replace('.', ',') + '%'}</td><td class="c">${l.objetivos}</td>
      <td>${l.ultima_sessao ? fmtData(l.ultima_sessao) + ` <small class="muted">(${l.dias}d)</small>` : '<span class="ruim">nunca</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted" style="font-size:12.5px">"Objetivos" conta os objetivos ativos dos pacientes em que a pessoa está na equipe. "Indep." é o % de respostas independentes nas sessões que ela aplicou no período.</p>`;
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
