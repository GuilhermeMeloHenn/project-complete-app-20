
/* =========================================================================
   NAVEIRO — App de gestão de barbearia/salão (protótipo funcional em HTML)
   Armazenamento: window.storage (shared=true) simula um backend único
   compartilhado por todos os logins (dono / barbeiros / clientes).
   ========================================================================= */

const DB_KEY = "naveiro_db_v1";
let DB = null;
let state = { route:"login", user:null, sub:{cliente:"home", barbeiro:"dashboard", dono:"servicos"}, tmp:{} };

/* ---- storage (persistência local com fallback) ---- */
if(!window.storage){
  window.storage = {
    async get(key){ const v = localStorage.getItem(key); return v===null? null : {value:v}; },
    async set(key, value){ localStorage.setItem(key, value); },
  };
}

/* ---- Backend de autenticação (e-mails reais) ---- */
const SESSION_KEY = "naveiro_session_v1";
let SESSION = null; // {access_token, refresh_token, email}
function loadSession(){
  try{ SESSION = JSON.parse(localStorage.getItem(SESSION_KEY)||"null"); }catch(e){ SESSION=null; }
  return SESSION;
}
function saveSession(s){
  SESSION = s;
  if(s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
const SB = window.__SB || {url:"", key:""};
const sbReady = () => Boolean(SB.url && SB.key);
async function sbCall(path, {method="POST", body=null, token=null}={}){
  const headers = { "Content-Type":"application/json", apikey: SB.key };
  headers["Authorization"] = `Bearer ${token || SB.key}`;
  const res = await fetch(`${SB.url}/auth/v1${path}`, { method, headers, body: body?JSON.stringify(body):undefined });
  let data = null; try{ data = await res.json(); }catch(e){}
  if(!res.ok){
    const msg = (data && (data.msg || data.error_description || data.message || data.error)) || "Falha na comunicação.";
    throw new Error(msg);
  }
  return data;
}
const sbSignUp = (email,password) =>
  sbCall(`/signup?redirect_to=${encodeURIComponent(window.location.origin + "/")}`, {body:{email,password}});
const sbSignIn = (email,password) => sbCall(`/token?grant_type=password`, {body:{email,password}});
const sbRecover = (email) =>
  sbCall(`/recover?redirect_to=${encodeURIComponent(window.location.origin + "/")}`, {body:{email}});
const sbUpdatePassword = (token,password) => sbCall(`/user`, {method:"PUT", token, body:{password}});
const sbRefresh = (refresh_token) => sbCall(`/token?grant_type=refresh_token`, {body:{refresh_token}});

/* ---- Banco de dados na nuvem (compartilhado entre dispositivos) ---- */
const CLOUD_ROW_ID = "naveiro";
async function cloudFetch(path, {method="GET", body=null, headers={}}={}){
  const token = SESSION && SESSION.access_token;
  const res = await fetch(`${SB.url}/rest/v1${path}`, {
    method,
    headers: { "Content-Type":"application/json", apikey: SB.key, Authorization:`Bearer ${token}`, ...headers },
    body: body?JSON.stringify(body):undefined,
  });
  if(!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text? JSON.parse(text) : null;
}
async function cloudLoad(){
  const rows = await cloudFetch(`/app_state?id=eq.${CLOUD_ROW_ID}&select=data`);
  return rows && rows[0] ? rows[0].data : null;
}
async function cloudSave(data){
  await cloudFetch(`/app_state?on_conflict=id`, {
    method:"POST",
    body:{ id: CLOUD_ROW_ID, data },
    headers:{ Prefer:"resolution=merge-duplicates,return=minimal" },
  });
}
const cloudReady = () => Boolean(sbReady() && SESSION && SESSION.access_token);

function translateAuthError(msg){
  const m=(msg||"").toLowerCase();
  if(m.includes("email not confirmed")) return "Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.";
  if(m.includes("invalid login")) return "E-mail ou senha inválidos.";
  if(m.includes("already registered") || m.includes("already been registered")) return "Já existe uma conta com esse e-mail.";
  if(m.includes("password should be")) return "A senha deve ter pelo menos 6 caracteres.";
  if(m.includes("rate limit") || m.includes("too many")) return "Muitas tentativas. Aguarde alguns instantes.";
  return msg || "Erro inesperado.";
}

const uid = () => Math.random().toString(36).slice(2,10);
const todayISO = () => new Date().toISOString().slice(0,10);
const money = n => (Number(n)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const pct = (a,b)=>{ if(!b) return a>0?100:0; return Math.round(((a-b)/b)*100); };
const dowShort = ["DOM","SEG","TER","QUA","QUI","SEX","SÁB"];
const monthName = m => ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][m];

function defaultDB(){
  return {
    users: [],
    services: [],
    appointments: [],
    categories: [
      {id:uid(), name:"Serviços", type:"receita"},
      {id:uid(), name:"Produtos", type:"receita"},
      {id:uid(), name:"Aluguel", type:"despesa"},
      {id:uid(), name:"Materiais", type:"despesa"},
      {id:uid(), name:"Comissões", type:"despesa"},
    ],
    paymentMethods: [
      {id:uid(), name:"Dinheiro"},{id:uid(), name:"Pix"},{id:uid(), name:"Cartão de Débito"},{id:uid(), name:"Cartão de Crédito"}
    ],
    financeEntries: [],
    commissions: [], // {barberId, serviceId, percent}
    goals: [], // {id, barberId, month(YYYY-MM), type, target, reward}
    settings: { logo:"💈", name:"Naveiro Barbearia", address:"", phone:"", instagram:"", whatsapp:"",
      hours: {0:{closed:true,open:"09:00",close:"18:00"},1:{closed:false,open:"09:00",close:"19:00"},2:{closed:false,open:"09:00",close:"19:00"},3:{closed:false,open:"09:00",close:"19:00"},4:{closed:false,open:"09:00",close:"19:00"},5:{closed:false,open:"09:00",close:"20:00"},6:{closed:false,open:"09:00",close:"17:00"}}
    },
    pendingBarberApprovals: [], // userId list awaiting owner approval
  };
}

async function loadDB(){
  try{
    const res = await window.storage.get(DB_KEY, true);
    DB = res ? JSON.parse(res.value) : defaultDB();
  }catch(e){ DB = defaultDB(); }
  if(!DB.pendingBarberApprovals) DB.pendingBarberApprovals=[];
}
let saveTimer=null;
function saveDB(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    try{ await window.storage.set(DB_KEY, JSON.stringify(DB), true); }catch(e){ console.error("storage error",e); }
  }, 150);
}

function toast(msg){
  const t=document.createElement('div'); t.className='toast'; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),2600);
}

/* ---------------- AUTH HELPERS ---------------- */
function ownerExists(){ return DB.users.some(u=>u.role==='dono'); }
function findUserByEmail(email){ return DB.users.find(u=>u.email.toLowerCase()===email.toLowerCase()); }

function render(){ document.getElementById('root').innerHTML=''; ROUTES[state.route](); }

/* ============================== ROUTES ============================== */
const ROUTES = {
  login: renderLogin,
  signup: renderSignup,
  forgot: renderForgot,
  reset: renderResetPassword,
  verifyClient: renderVerifyClient,
  verifyBarberPending: renderVerifyBarberPending,
  app: renderApp,
};

function shell(html){
  const root=document.getElementById('root');
  const div=document.createElement('div');
  div.innerHTML = html;
  root.appendChild(div);
}

/* ---------------- LOGIN ---------------- */
function renderLogin(){
  shell(`
  <div class="stripe"></div>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="brand"><div class="brand-mark">💈</div><div class="brand-name">Naveiro</div></div>
      <p class="eyebrow">Gestão de barbearia &amp; salão</p>
      <div id="loginErr" class="err hidden"></div>
      <div class="field"><label>E-mail</label><input id="loginEmail" type="email" placeholder="voce@email.com"></div>
      <div class="field"><label>Senha</label><input id="loginPass" type="password" placeholder="••••••••"></div>
      <button class="btn btn-primary" id="btnLogin">Entrar</button>
      <div class="link-row">
        <button id="goForgot">Esqueci minha senha</button>
        <button id="goSignup">Criar conta</button>
      </div>
      <div class="divider">ou</div>
      <button class="btn btn-google" id="btnGoogle">🔵 Entrar com Google</button>
    </div>
  </div>`);
  document.getElementById('goForgot').onclick=()=>{state.route='forgot';render();};
  document.getElementById('goSignup').onclick=()=>{state.route='signup';render();};
  document.getElementById('btnLogin').onclick=doLogin;
  document.getElementById('btnGoogle').onclick=doGoogleLogin;
}

async function doLogin(){
  const email=document.getElementById('loginEmail').value.trim();
  const pass=document.getElementById('loginPass').value;
  const errEl=document.getElementById('loginErr');
  const fail = (m)=>{ errEl.textContent=m; errEl.classList.remove('hidden'); };
  errEl.classList.add('hidden');
  let u=findUserByEmail(email);
  if(sbReady()){
    const btn=document.getElementById('btnLogin'); btn.disabled=true; btn.textContent="Entrando…";
    try{
      await sbSignIn(email, pass);
    }catch(err){
      btn.disabled=false; btn.textContent="Entrar";
      return fail(translateAuthError(err.message));
    }
    btn.disabled=false; btn.textContent="Entrar";
    if(!u){
      u = {id:uid(), name:email.split('@')[0], email, password:"", role:'cliente', status:'active', whatsapp:"", instagram:"", createdAt:Date.now()};
      DB.users.push(u);
    }
    // E-mail confirmado pelo backend → conta passa a existir de fato
    if(u.role!=='barbeiro' && u.status!=='active'){ u.status='active'; }
    if(u.role==='barbeiro' && u.status!=='active'){
      saveDB();
      return fail("Sua conta ainda aguarda aprovação do dono.");
    }
    saveDB();
  } else {
    if(!u || u.password!==pass) return fail("E-mail ou senha inválidos.");
    if(u.status!=='active') return fail(u.role==='barbeiro' ? "Sua conta ainda aguarda aprovação do dono." : "Verifique seu e-mail antes de entrar.");
  }
  state.user=u; state.route='app'; render();
}

function doGoogleLogin(){
  const email = prompt("Simulação de login Google — digite o e-mail da conta Google:");
  if(!email) return;
  let u = findUserByEmail(email);
  if(!u){
    u = {id:uid(), name:email.split('@')[0], email, password:"(google)", role:'cliente', status:'active',
      whatsapp:"", instagram:"", via:'google', createdAt:Date.now()};
    DB.users.push(u); saveDB();
    toast("Conta criada via Google como Cliente.");
  }
  state.user=u; state.route='app'; render();
}

/* ---------------- FORGOT PASSWORD ---------------- */
function renderForgot(){
  shell(`
  <div class="stripe"></div>
  <div class="auth-wrap"><div class="auth-card">
    <div class="brand"><div class="brand-mark">💈</div><div class="brand-name">Naveiro</div></div>
    <p class="eyebrow">Recuperar senha</p>
    <div class="notice">Informe seu e-mail cadastrado. Enviaremos um link real para você criar e confirmar uma nova senha.</div>
    <div class="field"><label>E-mail cadastrado</label><input id="fEmail" type="email"></div>
    <div id="fArea"></div>
    <button class="btn btn-primary" id="btnSend">Enviar link de redefinição</button>
    <div class="link-row"><button id="backLogin">← Voltar para login</button><span></span></div>
  </div></div>`);
  document.getElementById('backLogin').onclick=()=>{state.route='login';render();};
  document.getElementById('btnSend').onclick=async ()=>{
    const email=document.getElementById('fEmail').value.trim();
    const area=document.getElementById('fArea');
    if(!email){ area.innerHTML=`<div class="notice warn">Informe seu e-mail.</div>`; return; }
    const btn=document.getElementById('btnSend'); btn.disabled=true; btn.textContent="Enviando…";
    try{
      if(!sbReady()) throw new Error("Serviço de e-mail indisponível.");
      await sbRecover(email);
      area.innerHTML=`<div class="notice">📧 Enviamos um e-mail para <b>${email}</b> com o link para criar e confirmar uma nova senha. Confira também a caixa de spam.</div>`;
    }catch(err){
      area.innerHTML=`<div class="notice warn">${translateAuthError(err.message)}</div>`;
    }
    btn.disabled=false; btn.textContent="Enviar link de redefinição";
  };
}

/* ---------------- NOVA SENHA (link do e-mail) ---------------- */
function renderResetPassword(){
  shell(`
  <div class="stripe"></div>
  <div class="auth-wrap"><div class="auth-card">
    <div class="brand"><div class="brand-mark">💈</div><div class="brand-name">Naveiro</div></div>
    <p class="eyebrow">Criar nova senha</p>
    <div id="rsErr" class="err hidden"></div>
    <div class="field"><label>Nova senha</label><input id="rsPass" type="password"></div>
    <div class="field"><label>Confirmar nova senha</label><input id="rsPass2" type="password"></div>
    <button class="btn btn-primary" id="rsSave">Salvar nova senha</button>
    <div class="link-row"><button id="backLogin">← Voltar para login</button><span></span></div>
  </div></div>`);
  document.getElementById('backLogin').onclick=()=>{state.route='login';render();};
  document.getElementById('rsSave').onclick=async ()=>{
    const p1=document.getElementById('rsPass').value, p2=document.getElementById('rsPass2').value;
    const errEl=document.getElementById('rsErr'); errEl.classList.add('hidden');
    const fail=(m)=>{ errEl.textContent=m; errEl.classList.remove('hidden'); };
    if(p1.length<6) return fail("A senha deve ter pelo menos 6 caracteres.");
    if(p1!==p2) return fail("As senhas não conferem.");
    try{
      const data = await sbUpdatePassword(state.tmp.recoveryToken, p1);
      const local = data && data.email ? findUserByEmail(data.email) : null;
      if(local){ local.status = local.role==='barbeiro' ? local.status : 'active'; saveDB(); }
      toast("Senha alterada! Faça login.");
      state.tmp.recoveryToken=null; state.route='login'; render();
    }catch(err){ fail(translateAuthError(err.message)); }
  };
}

/* ---------------- SIGNUP ---------------- */
function renderSignup(){
  const hasOwner = ownerExists();
  state.tmp.role = state.tmp.role || 'cliente';
  shell(`
  <div class="stripe"></div>
  <div class="auth-wrap"><div class="auth-card">
    <div class="brand"><div class="brand-mark">💈</div><div class="brand-name">Naveiro</div></div>
    <p class="eyebrow">Criar conta</p>
    <label style="display:block;font-size:12px;color:var(--text-dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:.6px;">Tipo de conta</label>
    <div class="role-grid">
      <button class="role-opt ${state.tmp.role==='cliente'?'active':''}" data-role="cliente"><span class="ic">🙋</span><span>Cliente</span></button>
      <button class="role-opt ${state.tmp.role==='barbeiro'?'active':''}" data-role="barbeiro"><span class="ic">✂️</span><span>Barbeiro</span></button>
      <button class="role-opt ${state.tmp.role==='dono'?'active':''} ${hasOwner?'disabled':''}" data-role="dono" ${hasOwner?'disabled':''}><span class="ic">👑</span><span>Dono</span></button>
    </div>
    ${hasOwner?'<div class="notice">Já existe um Dono cadastrado nesta barbearia — essa opção fica bloqueada.</div>':''}
    ${state.tmp.role==='barbeiro' && !hasOwner ? '<div class="notice warn">Ainda não existe Dono cadastrado — cadastre o Dono primeiro para poder aprovar barbeiros.</div>':''}
    ${state.tmp.role==='barbeiro' ? '<div class="notice">Sua conta só será ativada depois que o <b>Dono</b> aprovar sua solicitação.</div>':''}
    <div id="suErr" class="err hidden"></div>
    <div class="field"><label>Nome</label><input id="suName" type="text"></div>
    <div class="field"><label>E-mail</label><input id="suEmail" type="email"></div>
    <div class="field"><label>Senha</label><input id="suPass" type="password"></div>
    <button class="btn btn-primary" id="btnCreate">Criar conta</button>
    <div class="link-row"><button id="backLogin">← Voltar para login</button><span></span></div>
  </div></div>`);
  document.querySelectorAll('.role-opt').forEach(b=>{
    b.onclick=()=>{ if(b.disabled) return; state.tmp.role=b.dataset.role; render(); };
  });
  document.getElementById('backLogin').onclick=()=>{state.route='login';render();};
  document.getElementById('btnCreate').onclick=async ()=>{
    const name=document.getElementById('suName').value.trim();
    const email=document.getElementById('suEmail').value.trim();
    const pass=document.getElementById('suPass').value;
    const errEl=document.getElementById('suErr');
    if(!name||!email||!pass){ errEl.textContent="Preencha todos os campos."; errEl.classList.remove('hidden'); return; }
    if(findUserByEmail(email)){ errEl.textContent="Já existe uma conta com esse e-mail."; errEl.classList.remove('hidden'); return; }
    const role = state.tmp.role;
    if(role==='dono' && ownerExists()){ errEl.textContent="Já existe um Dono cadastrado."; errEl.classList.remove('hidden'); return; }
    if(pass.length<6){ errEl.textContent="A senha deve ter pelo menos 6 caracteres."; errEl.classList.remove('hidden'); return; }
    const btn=document.getElementById('btnCreate');
    if(sbReady()){
      btn.disabled=true; btn.textContent="Criando…";
      try{ await sbSignUp(email, pass); }
      catch(err){
        btn.disabled=false; btn.textContent="Criar conta";
        errEl.textContent=translateAuthError(err.message); errEl.classList.remove('hidden'); return;
      }
      btn.disabled=false; btn.textContent="Criar conta";
    }
    const u = {id:uid(), name, email, password:pass, role,
      status: 'pending',
      whatsapp:"", instagram:"", createdAt:Date.now()};
    DB.users.push(u);
    if(role==='barbeiro'){ DB.pendingBarberApprovals.push(u.id); }
    saveDB();
    state.tmp.pendingUser = u.id;
    if(role==='barbeiro'){ state.route='verifyBarberPending'; }
    else { state.route='verifyClient'; }
    render();
  };
}

function renderVerifyClient(){
  const u = DB.users.find(x=>x.id===state.tmp.pendingUser);
  const simulate = !sbReady();
  shell(`
  <div class="stripe"></div>
  <div class="auth-wrap"><div class="auth-card">
    <div class="brand"><div class="brand-mark">💈</div><div class="brand-name">Naveiro</div></div>
    <h2 style="margin-bottom:10px;">Verifique seu e-mail</h2>
    <div class="notice">📧 Enviamos um e-mail de verificação para <b>${u?u.email:''}</b>. Sua conta só existe de fato depois que você clicar no link de confirmação. Confira também a caixa de spam.</div>
    ${simulate?'<button class="btn btn-primary" id="btnVerify">Simular clique no link de verificação</button>':''}
    <div class="link-row"><button id="backLogin">← Voltar para login</button><span></span></div>
  </div></div>`);
  document.getElementById('backLogin').onclick=()=>{state.route='login';render();};
  const bv=document.getElementById('btnVerify');
  if(bv) bv.onclick=()=>{
    if(u){ u.status='active'; saveDB(); }
    toast("E-mail verificado! Conta ativa.");
    state.route='login'; render();
  };
}

function renderVerifyBarberPending(){
  const u = DB.users.find(x=>x.id===state.tmp.pendingUser);
  shell(`
  <div class="stripe"></div>
  <div class="auth-wrap"><div class="auth-card">
    <div class="brand"><div class="brand-mark">💈</div><div class="brand-name">Naveiro</div></div>
    <h2 style="margin-bottom:10px;">Aguardando aprovação</h2>
    <div class="notice">📧 Enviamos um e-mail de verificação para <b>${u?u.email:''}</b> — confirme-o primeiro. Depois disso, sua conta de barbeiro será ativada quando o <b>Dono</b> aprovar na aba Dono → Equipe.</div>
    <button class="btn btn-ghost" id="backLogin">← Voltar para login</button>
  </div></div>`);
  document.getElementById('backLogin').onclick=()=>{state.route='login';render();};
}

/* ============================== APP SHELL ============================== */
function logout(){ state.user=null; state.route='login'; render(); }

function renderApp(){
  const u = state.user;
  const tabs = [{k:'cliente',label:'Cliente'}];
  if(u.role==='barbeiro'||u.role==='dono') tabs.push({k:'barbeiro',label:'Barbeiro'});
  if(u.role==='dono') tabs.push({k:'dono',label:'Dono'});
  if(!state.mainTab || !tabs.find(t=>t.k===state.mainTab)) state.mainTab='cliente';

  const myUpcoming = DB.appointments.filter(a=>a.clientId===u.id && a.status==='scheduled' && withinNextMinutes(a,30));

  shell(`
  <div class="topbar"><div class="topbar-inner">
    <div class="brand"><div class="brand-mark" style="width:28px;height:28px;font-size:13px;">${DB.settings.logo}</div><div class="brand-name" style="font-size:16px;">${DB.settings.name}</div></div>
    <div class="tabs">${tabs.map(t=>`<button class="tab-btn ${state.mainTab===t.k?'active':''}" data-tab="${t.k}">${t.label}</button>`).join('')}</div>
    <div class="user-menu">
      <div class="bell" id="bellBtn">🔔${myUpcoming.length?'<span class="dot"></span>':''}</div>
      <div class="avatar" id="avatarBtn">${u.name.slice(0,1).toUpperCase()}</div>
      <div id="ddUser" class="dropdown hidden">
        <div class="dd-title">${u.name} · ${u.role}</div>
        <button id="ddProfile">Meu perfil</button>
        <button id="ddLogout">Sair</button>
      </div>
      <div id="ddBell" class="dropdown hidden" style="min-width:280px;"></div>
    </div>
  </div></div>
  <div class="app-shell" id="pageArea"></div>
  `);

  tabs.forEach(t=>{
    document.querySelector(`[data-tab="${t.k}"]`).onclick=()=>{ state.mainTab=t.k; render(); };
  });
  document.getElementById('avatarBtn').onclick=(e)=>{ toggleDD('ddUser'); };
  document.getElementById('ddProfile').onclick=()=>{ openProfileModal(); };
  document.getElementById('ddLogout').onclick=logout;
  document.getElementById('bellBtn').onclick=()=>{
    const dd=document.getElementById('ddBell');
    dd.innerHTML = myUpcoming.length ?
      `<div class="dd-title">Lembretes</div>` + myUpcoming.map(a=>{
        const s=DB.services.find(x=>x.id===a.serviceId); const b=DB.users.find(x=>x.id===a.barberId);
        return `<div style="padding:8px 10px;font-size:12.5px;color:var(--text-dim);">⏰ <b style="color:var(--text)">${s?s.name:''}</b> às ${a.time} com ${b?b.name:''} — em breve!</div>`;
      }).join('') :
      `<div style="padding:10px;font-size:12.5px;color:var(--text-faint);">Nenhum lembrete no momento.</div>`;
    toggleDD('ddBell');
    if(myUpcoming.length) simulatePush(myUpcoming[0]);
  };

  const page = document.getElementById('pageArea');
  if(state.mainTab==='cliente') renderClienteTab(page);
  if(state.mainTab==='barbeiro') renderBarbeiroTab(page);
  if(state.mainTab==='dono') renderDonoTab(page);
}
function toggleDD(id){
  ['ddUser','ddBell'].forEach(x=>{ if(x!==id) document.getElementById(x).classList.add('hidden'); });
  document.getElementById(id).classList.toggle('hidden');
}
function withinNextMinutes(appt,mins){
  try{
    const dt = new Date(appt.date+'T'+appt.time+':00');
    const diff = (dt - new Date())/60000;
    return diff>0 && diff<=mins;
  }catch(e){return false;}
}
function simulatePush(a){
  if("Notification" in window){
    if(Notification.permission==="granted"){ new Notification("Naveiro — lembrete", {body:`Seu horário é em breve, às ${a.time}.`}); }
    else if(Notification.permission!=="denied"){ Notification.requestPermission(); }
  }
}

/* ---------------- PROFILE MODAL (all roles) ---------------- */
function openProfileModal(){
  const u=state.user;
  openModal(`
    <h3>Meu perfil</h3>
    <div class="field"><label>Nome</label><input id="pfName" value="${u.name}"></div>
    <div class="field"><label>E-mail</label><input value="${u.email}" disabled style="opacity:.6;"></div>
    <div class="field"><label>WhatsApp</label><input id="pfWhats" value="${u.whatsapp||''}" placeholder="(51) 99999-9999"></div>
    <div class="field"><label>Instagram</label><input id="pfInsta" value="${u.instagram||''}" placeholder="@usuario"></div>
    <button class="btn btn-primary" id="pfSave">Salvar alterações</button>
  `);
  document.getElementById('pfSave').onclick=()=>{
    u.name=document.getElementById('pfName').value.trim()||u.name;
    u.whatsapp=document.getElementById('pfWhats').value.trim();
    u.instagram=document.getElementById('pfInsta').value.trim();
    saveDB(); closeModal(); toast("Perfil atualizado."); render();
  };
}
function openModal(innerHtml){
  const bg=document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML=`<div class="modal"><button class="modal-close" id="modalClose">✕</button>${innerHtml}</div>`;
  document.body.appendChild(bg);
  document.getElementById('modalClose').onclick=closeModal;
  bg.onclick=(e)=>{ if(e.target.id==='modalBg') closeModal(); };
}
function closeModal(){ const m=document.getElementById('modalBg'); if(m) m.remove(); }

/* ============================== CLIENTE TAB ============================== */
function renderClienteTab(page){
  const subs=[{k:'home',l:'Início'},{k:'agendar',l:'Agendar corte'},{k:'meus',l:'Meus cortes'}];
  page.innerHTML = `
    <div class="page-head"><p class="eyebrow">Área do cliente</p><h1>Olá, ${state.user.name.split(' ')[0]} 👋</h1></div>
    <div class="subnav">${subs.map(s=>`<button class="${state.sub.cliente===s.k?'active':''}" data-s="${s.k}">${s.l}</button>`).join('')}</div>
    <div id="clienteBody"></div>`;
  subs.forEach(s=> page.querySelector(`[data-s="${s.k}"]`).onclick=()=>{ state.sub.cliente=s.k; state.tmp.wizard=null; render(); });
  const body=document.getElementById('clienteBody');
  if(state.sub.cliente==='home') renderClienteHome(body);
  if(state.sub.cliente==='agendar') renderClienteAgendar(body);
  if(state.sub.cliente==='meus') renderClienteMeusCortes(body);
}

function topServices(){
  const counts={};
  DB.appointments.forEach(a=>{ counts[a.serviceId]=(counts[a.serviceId]||0)+1; });
  return DB.services.slice().sort((a,b)=>(counts[b.id]||0)-(counts[a.id]||0)).filter(s=>counts[s.id]).slice(0,6);
}
function renderClienteHome(body){
  const top = topServices();
  body.innerHTML = `
    <div class="section-title"><h2>Serviços mais pedidos</h2><span class="hint">Atualiza conforme os agendamentos</span></div>
    ${top.length? `<div class="grid g3">${top.map(svcCardHtml).join('')}</div>` :
      `<div class="empty"><span class="ic">✂️</span>Ainda não há serviços agendados o suficiente para gerar um ranking.</div>`}
    <div class="section-title"><h2>Pronto para marcar?</h2></div>
    <button class="btn btn-primary" style="max-width:260px;" id="goAgendar">Agendar corte</button>
  `;
  document.getElementById('goAgendar').onclick=()=>{ state.sub.cliente='agendar'; render(); };
}
function svcCardHtml(s){
  return `<div class="svc-card"><div class="svc-emoji">${s.emoji}</div><div class="svc-name">${s.name}</div>
    <div class="svc-meta"><span>⏱ ${s.duration} min</span><span class="svc-price">${money(s.price)}</span></div></div>`;
}

function renderClienteAgendar(body){
  if(DB.services.length===0){
    body.innerHTML = `<div class="empty"><span class="ic">🗓️</span>O Dono ainda não cadastrou serviços disponíveis.</div>`; return;
  }
  const barbers = DB.users.filter(u=>(u.role==='barbeiro'||u.role==='dono') && u.status==='active');
  const w = state.tmp.wizard = state.tmp.wizard || {step:1, serviceId:null, barberId:null, date:null, time:null};

  body.innerHTML = `
    <div class="wizard-steps">${[1,2,3,4].map(i=>`<span class="${w.step>=i?'done':''}"></span>`).join('')}</div>
    <div id="wizArea"></div>`;
  renderWizardStep();

  function renderWizardStep(){
    const area=document.getElementById('wizArea');
    if(w.step===1){
      area.innerHTML = `<h2 style="margin-bottom:14px;">1. Escolha o serviço</h2>
        <div class="grid g3">${DB.services.map(s=>`<div class="svc-card ${w.serviceId===s.id?'selected':''}" data-id="${s.id}">
          <div class="svc-emoji">${s.emoji}</div><div class="svc-name">${s.name}</div>
          <div class="svc-meta"><span>⏱ ${s.duration} min</span><span class="svc-price">${money(s.price)}</span></div></div>`).join('')}</div>
        <button class="btn btn-primary" style="max-width:200px;margin-top:18px;" id="nextBtn" ${!w.serviceId?'disabled style="opacity:.4;max-width:200px;margin-top:18px;"':''}>Continuar</button>`;
      area.querySelectorAll('.svc-card').forEach(el=> el.onclick=()=>{ w.serviceId=el.dataset.id; renderWizardStep(); });
      const nb=document.getElementById('nextBtn'); if(w.serviceId) nb.onclick=()=>{ w.step=2; renderWizardStep(); };
    }
    else if(w.step===2){
      if(barbers.length===0){ area.innerHTML=`<div class="empty">Nenhum barbeiro ativo no momento.</div>`; return; }
      area.innerHTML = `<h2 style="margin-bottom:14px;">2. Escolha o barbeiro</h2>
        ${barbers.map(b=>`<div class="barber-pick ${w.barberId===b.id?'selected':''}" data-id="${b.id}">
          <div class="avatar">${b.name.slice(0,1)}</div><div><div style="font-weight:700;">${b.name}</div><div style="font-size:12px;color:var(--text-faint);">Barbeiro</div></div></div>`).join('')}
        <div style="display:flex;gap:10px;margin-top:10px;">
          <button class="btn btn-ghost" id="backBtn" style="max-width:120px;">Voltar</button>
          <button class="btn btn-primary" id="nextBtn" style="max-width:200px;" ${!w.barberId?'disabled':''}>Continuar</button>
        </div>`;
      area.querySelectorAll('.barber-pick').forEach(el=> el.onclick=()=>{ w.barberId=el.dataset.id; renderWizardStep(); });
      document.getElementById('backBtn').onclick=()=>{ w.step=1; renderWizardStep(); };
      const nb=document.getElementById('nextBtn'); if(w.barberId) nb.onclick=()=>{ w.step=3; renderWizardStep(); };
    }
    else if(w.step===3){
      const days = generateAvailableDays();
      w.date = w.date || days[0].iso;
      area.innerHTML = `<h2 style="margin-bottom:14px;">3. Escolha data e horário</h2>
        <div class="day-scroll">${days.map(d=>`<div class="day-chip ${w.date===d.iso?'active':''}" data-iso="${d.iso}">
          <div class="dow">${dowShort[d.dow]}</div><div class="num">${d.day}</div><div class="dow">${monthName(d.month)}</div></div>`).join('')}</div>
        <div class="time-grid" id="timeGrid"></div>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-ghost" id="backBtn" style="max-width:120px;">Voltar</button>
          <button class="btn btn-primary" id="nextBtn" style="max-width:200px;" ${!w.time?'disabled':''}>Continuar</button>
        </div>`;
      area.querySelectorAll('.day-chip').forEach(el=> el.onclick=()=>{ w.date=el.dataset.iso; w.time=null; renderWizardStep(); });
      document.getElementById('backBtn').onclick=()=>{ w.step=2; renderWizardStep(); };
      renderTimeGrid();
      function renderTimeGrid(){
        const slots = generateSlotsForDay(w.date, w.barberId);
        document.getElementById('timeGrid').innerHTML = slots.length? slots.map(t=>`<div class="time-slot ${w.time===t?'active':''}" data-t="${t}">${t}</div>`).join('')
          : `<div class="empty" style="grid-column:1/-1;padding:16px;">Sem horários livres neste dia.</div>`;
        document.querySelectorAll('.time-slot').forEach(el=> el.onclick=()=>{ w.time=el.dataset.t; renderWizardStep(); });
      }
      const nb=document.getElementById('nextBtn'); if(w.time) nb.onclick=()=>{ w.step=4; renderWizardStep(); };
    }
    else if(w.step===4){
      const s=DB.services.find(x=>x.id===w.serviceId), b=DB.users.find(x=>x.id===w.barberId);
      area.innerHTML = `<h2 style="margin-bottom:14px;">4. Confirmar agendamento</h2>
        <div class="ticket">
          <div class="ticket-row"><span class="k">Serviço</span><span class="v">${s.emoji} ${s.name}</span></div>
          <div class="ticket-row"><span class="k">Barbeiro</span><span class="v">${b.name}</span></div>
          <div class="ticket-row"><span class="k">Data</span><span class="v">${formatDatePt(w.date)}</span></div>
          <div class="ticket-row"><span class="k">Horário</span><span class="v">${w.time}</span></div>
          <div class="ticket-row"><span class="k">Endereço</span><span class="v" style="text-align:right;">${DB.settings.address||'Não informado'}</span></div>
          <div class="ticket-row"><span class="k">Total</span><span class="v" style="color:var(--brass-glow);font-size:16px;">${money(s.price)}</span></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;">
          <button class="btn btn-ghost" id="backBtn" style="max-width:120px;">Voltar</button>
          <button class="btn btn-primary" id="confirmBtn">Confirmar agendamento</button>
        </div>`;
      document.getElementById('backBtn').onclick=()=>{ w.step=3; renderWizardStep(); };
      document.getElementById('confirmBtn').onclick=()=>{
        DB.appointments.push({id:uid(), clientId:state.user.id, barberId:w.barberId, serviceId:w.serviceId,
          date:w.date, time:w.time, status:'scheduled', paymentMethodId:null, rating:null, createdAt:Date.now()});
        saveDB();
        state.tmp.wizard=null;
        toast("Agendamento confirmado! ✂️");
        state.sub.cliente='meus'; render();
      };
    }
  }
}
function generateAvailableDays(){
  const days=[]; const now=new Date();
  for(let i=0;i<45;i++){
    const d=new Date(now); d.setDate(d.getDate()+i);
    const dow=d.getDay();
    const hrs = DB.settings.hours[dow];
    if(hrs && !hrs.closed){
      days.push({iso:d.toISOString().slice(0,10), dow, day:d.getDate(), month:d.getMonth()});
    }
  }
  return days;
}
function generateSlotsForDay(iso, barberId){
  const d = new Date(iso+'T00:00:00');
  const hrs = DB.settings.hours[d.getDay()];
  if(!hrs || hrs.closed) return [];
  const slots=[];
  let [oh,om]=hrs.open.split(':').map(Number); let [ch,cm]=hrs.close.split(':').map(Number);
  let cur=oh*60+om; const end=ch*60+cm;
  while(cur+45<=end){ slots.push(String(Math.floor(cur/60)).padStart(2,'0')+':'+String(cur%60).padStart(2,'0')); cur+=45; }
  const taken = new Set(DB.appointments.filter(a=>a.barberId===barberId && a.date===iso && a.status!=='cancelled').map(a=>a.time));
  return slots.filter(t=>!taken.has(t));
}
function formatDatePt(iso){
  const d=new Date(iso+'T00:00:00');
  return `${dowShort[d.getDay()]}, ${d.getDate()} de ${monthName(d.getMonth())}`;
}

function renderClienteMeusCortes(body){
  const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth()-3);
  const mine = DB.appointments.filter(a=>a.clientId===state.user.id && new Date(a.date)>=threeMonthsAgo)
    .sort((a,b)=> new Date(b.date+'T'+b.time) - new Date(a.date+'T'+a.time));
  if(mine.length===0){ body.innerHTML=`<div class="empty"><span class="ic">📭</span>Você ainda não tem cortes nos últimos 3 meses.</div>`; return; }
  body.innerHTML = mine.map(a=>{
    const s=DB.services.find(x=>x.id===a.serviceId)||{}; const b=DB.users.find(x=>x.id===a.barberId)||{};
    return `<div class="list-row">
      <div class="main"><div class="name">${s.emoji||''} ${s.name||'Serviço'} — ${b.name||''}</div>
        <div class="sub">${formatDatePt(a.date)} às ${a.time} · ${money(s.price)}</div></div>
      <span class="badge ${a.status}">${a.status==='scheduled'?'Agendado':a.status==='done'?'Concluído':'Cancelado'}</span>
      ${a.status==='done' ? ratingHtml(a) : ''}
    </div>`;
  }).join('');
  document.querySelectorAll('[data-rate]').forEach(el=>{
    el.onclick=()=>{
      const apt = DB.appointments.find(x=>x.id===el.closest('.list-row').dataset.id);
      apt.rating = Number(el.dataset.rate); saveDB(); toast("Obrigado pela avaliação!"); render();
    };
  });
}
function ratingHtml(a){
  const stars=[1,2,3,4,5];
  return `<div class="stars" data-id-holder>${stars.map(n=>`<span class="${a.rating>=n?'on':''}" data-rate="${n}">★</span>`).join('')}</div>`.replace('data-id-holder', `id="stars-${a.id}"`);
}
// fix: attach appointment id to row for rating clicks
const _origMeus = renderClienteMeusCortes;
renderClienteMeusCortes = function(body){
  const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth()-3);
  const mine = DB.appointments.filter(a=>a.clientId===state.user.id && new Date(a.date)>=threeMonthsAgo)
    .sort((a,b)=> new Date(b.date+'T'+b.time) - new Date(a.date+'T'+a.time));
  if(mine.length===0){ body.innerHTML=`<div class="empty"><span class="ic">📭</span>Você ainda não tem cortes nos últimos 3 meses.</div>`; return; }
  body.innerHTML = mine.map(a=>{
    const s=DB.services.find(x=>x.id===a.serviceId)||{}; const b=DB.users.find(x=>x.id===a.barberId)||{};
    const stars=[1,2,3,4,5];
    return `<div class="list-row" data-id="${a.id}">
      <div class="main"><div class="name">${s.emoji||''} ${s.name||'Serviço'} — ${b.name||''}</div>
        <div class="sub">${formatDatePt(a.date)} às ${a.time} · ${money(s.price)}</div></div>
      <span class="badge ${a.status}">${a.status==='scheduled'?'Agendado':a.status==='done'?'Concluído':'Cancelado'}</span>
      ${a.status==='done' ? `<div class="stars">${stars.map(n=>`<span class="${a.rating>=n?'on':''}" data-rate="${n}">★</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  document.querySelectorAll('.stars span').forEach(el=>{
    el.onclick=()=>{
      const id = el.closest('.list-row').dataset.id;
      const apt = DB.appointments.find(x=>x.id===id);
      apt.rating = Number(el.dataset.rate); saveDB(); toast("Obrigado pela avaliação!");
      renderClienteMeusCortes(body);
    };
  });
};

/* ============================== BARBEIRO TAB ============================== */
function renderBarbeiroTab(page){
  const subs=[{k:'dashboard',l:'Painel'},{k:'agenda',l:'Agenda do dia'},{k:'sugestoes',l:'Sugestões IA'},{k:'comissoes',l:'Comissões'}];
  page.innerHTML = `
    <div class="page-head"><p class="eyebrow">Área do barbeiro</p><h1>Painel de ${state.user.name.split(' ')[0]}</h1></div>
    <div class="subnav">${subs.map(s=>`<button class="${state.sub.barbeiro===s.k?'active':''}" data-s="${s.k}">${s.l}</button>`).join('')}</div>
    <div id="barbBody"></div>`;
  subs.forEach(s=> page.querySelector(`[data-s="${s.k}"]`).onclick=()=>{ state.sub.barbeiro=s.k; render(); });
  const body=document.getElementById('barbBody');
  if(state.sub.barbeiro==='dashboard') renderBarbDash(body);
  if(state.sub.barbeiro==='agenda') renderBarbAgenda(body);
  if(state.sub.barbeiro==='sugestoes') renderBarbSugestoes(body);
  if(state.sub.barbeiro==='comissoes') renderBarbComissoes(body);
}

function barberStatsFor(barberId, dateISO){
  const day = dateISO;
  const yesterday = new Date(dateISO); yesterday.setDate(yesterday.getDate()-1);
  const yISO = yesterday.toISOString().slice(0,10);
  const todayCount = DB.appointments.filter(a=>a.barberId===barberId && a.date===day && a.status==='done').length;
  const yestCount = DB.appointments.filter(a=>a.barberId===barberId && a.date===yISO && a.status==='done').length;
  const now=new Date(dateISO); const curMonth=now.getMonth(), curYear=now.getFullYear();
  const prevDate=new Date(curYear,curMonth-1,1);
  const revenue = (m,y)=> DB.appointments.filter(a=>{
    const d=new Date(a.date); return a.barberId===barberId && a.status==='done' && d.getMonth()===m && d.getFullYear()===y;
  }).reduce((sum,a)=>{ const s=DB.services.find(x=>x.id===a.serviceId); return sum+(s?s.price:0); },0);
  const curRev = revenue(curMonth,curYear);
  const prevRev = revenue(prevDate.getMonth(), prevDate.getFullYear());
  const ratings = DB.appointments.filter(a=>a.barberId===barberId && a.rating!=null);
  const avgRating = ratings.length ? (ratings.reduce((s,a)=>s+a.rating,0)/ratings.length) : 0;
  return {todayCount, yestCount, curRev, prevRev, avgRating, ratingsCount:ratings.length,
    todayAppts: DB.appointments.filter(a=>a.barberId===barberId && a.date===day).length};
}

function renderBarbDash(body){
  const st = barberStatsFor(state.user.id, todayISO());
  body.innerHTML = `
    <div class="grid g4">
      <div class="stat-card"><div class="label">Agendados hoje</div><div class="value">${st.todayAppts}</div></div>
      <div class="stat-card"><div class="label">Cortes feitos hoje</div><div class="value">${st.todayCount}</div>
        <div class="delta ${st.todayCount>=st.yestCount?'up':'down'}">${pct(st.todayCount,st.yestCount)>=0?'+':''}${pct(st.todayCount,st.yestCount)}% vs. ontem</div></div>
      <div class="stat-card clickable" id="revClick"><div class="label">Faturamento do mês</div><div class="value">${money(st.curRev)}</div>
        <div class="delta ${st.curRev>=st.prevRev?'up':'down'}">${pct(st.curRev,st.prevRev)>=0?'+':''}${pct(st.curRev,st.prevRev)}% vs. mês anterior</div></div>
      <div class="stat-card"><div class="label">Avaliação média</div><div class="value">⭐ ${st.avgRating.toFixed(1)}</div>
        <div class="delta">${st.ratingsCount} avaliações</div></div>
    </div>
    <div class="grid g2" style="margin-top:20px;">
      <div class="card"><h3 style="margin-bottom:12px;">Top 5 clientes frequentes</h3><div id="topClients"></div></div>
      <div class="card"><h3 style="margin-bottom:12px;">Top 5 serviços realizados</h3><div id="topSvcsBarber"></div></div>
    </div>
  `;
  document.getElementById('revClick').onclick=()=> openMonthRevenueModal(state.user.id);
  const doneAppts = DB.appointments.filter(a=>a.barberId===state.user.id && a.status==='done');
  const clientCounts={};
  doneAppts.forEach(a=>{ clientCounts[a.clientId]=(clientCounts[a.clientId]||0)+1; });
  const topClients = Object.entries(clientCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  document.getElementById('topClients').innerHTML = topClients.length? topClients.map(([cid,c])=>{
    const u=DB.users.find(x=>x.id===cid); return `<div class="list-row" style="margin-bottom:6px;padding:10px 14px;"><div class="main"><div class="name">${u?u.name:'Cliente'}</div></div><span class="sub">${c} cortes</span></div>`;
  }).join('') : `<div class="empty" style="padding:16px;">Sem dados ainda.</div>`;
  const svcCounts={};
  doneAppts.forEach(a=>{ svcCounts[a.serviceId]=(svcCounts[a.serviceId]||0)+1; });
  const topSvcs = Object.entries(svcCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  document.getElementById('topSvcsBarber').innerHTML = topSvcs.length? topSvcs.map(([sid,c])=>{
    const s=DB.services.find(x=>x.id===sid); return `<div class="list-row" style="margin-bottom:6px;padding:10px 14px;"><div class="main"><div class="name">${s?s.emoji+' '+s.name:'Serviço'}</div></div><span class="sub">${c}x</span></div>`;
  }).join('') : `<div class="empty" style="padding:16px;">Sem dados ainda.</div>`;
}

function openMonthRevenueModal(barberId){
  const now=new Date();
  const items = DB.appointments.filter(a=>{
    const d=new Date(a.date); return a.barberId===barberId && a.status==='done' && d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
  }).sort((a,b)=> new Date(a.date)-new Date(b.date));
  const total = items.reduce((s,a)=>{ const sv=DB.services.find(x=>x.id===a.serviceId); return s+(sv?sv.price:0); },0);
  openModal(`
    <h3>Faturamento de ${monthName(now.getMonth())}</h3>
    <p style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">Todos os serviços concluídos desde o dia 1.</p>
    ${items.length? `<table><thead><tr><th>Data</th><th>Serviço</th><th>Cliente</th><th>Valor</th></tr></thead><tbody>
      ${items.map(a=>{ const sv=DB.services.find(x=>x.id===a.serviceId); const cl=DB.users.find(x=>x.id===a.clientId);
        return `<tr><td>${a.date.slice(8,10)}/${a.date.slice(5,7)}</td><td>${sv?sv.name:''}</td><td>${cl?cl.name:''}</td><td>${money(sv?sv.price:0)}</td></tr>`; }).join('')}
      </tbody></table><div style="text-align:right;margin-top:12px;font-weight:700;font-family:var(--font-mono);">Total: ${money(total)}</div>`
      : `<div class="empty">Nenhum atendimento concluído este mês.</div>`}
  `);
}

function renderBarbAgenda(body){
  const today = DB.appointments.filter(a=>a.barberId===state.user.id && a.date===todayISO())
    .sort((a,b)=> a.time.localeCompare(b.time));
  if(today.length===0){ body.innerHTML=`<div class="empty"><span class="ic">🗓️</span>Nenhum agendamento para hoje.</div>`; return; }
  body.innerHTML = today.map(a=>{
    const s=DB.services.find(x=>x.id===a.serviceId)||{}; const c=DB.users.find(x=>x.id===a.clientId)||{};
    return `<div class="list-row" data-id="${a.id}">
      <div class="main">
        <div class="name" style="cursor:pointer;" data-openclient="${c.id}">${a.time} · ${s.emoji||''} ${s.name||''} — ${c.name||'Cliente'}</div>
        <div class="sub">${money(s.price||0)}</div>
      </div>
      <span class="badge ${a.status}">${a.status==='scheduled'?'Agendado':a.status==='done'?'Feito':'Cancelado'}</span>
      ${a.status==='scheduled' ? `<div class="row-actions">
        <button class="btn-sm green" data-done>Marcar feito</button>
        <button class="btn-sm red" data-cancel>Cancelar</button>
      </div>` : ''}
    </div>`;
  }).join('');
  document.querySelectorAll('[data-openclient]').forEach(el=> el.onclick=()=> openClientContactModal(el.dataset.openclient));
  document.querySelectorAll('[data-done]').forEach(el=> el.onclick=(e)=>{
    const id = e.target.closest('.list-row').dataset.id;
    openPaymentPickModal(id);
  });
  document.querySelectorAll('[data-cancel]').forEach(el=> el.onclick=(e)=>{
    const id = e.target.closest('.list-row').dataset.id;
    const apt = DB.appointments.find(x=>x.id===id); apt.status='cancelled'; saveDB(); toast("Agendamento cancelado."); renderBarbAgenda(body);
  });
}
function openClientContactModal(clientId){
  const c = DB.users.find(x=>x.id===clientId);
  openModal(`<h3>${c?c.name:'Cliente'}</h3>
    <div class="notice">📱 WhatsApp: <b>${c&&c.whatsapp?c.whatsapp:'não informado'}</b></div>
    <div class="notice">📷 Instagram: <b>${c&&c.instagram?c.instagram:'não informado'}</b></div>`);
}
function openPaymentPickModal(appointmentId){
  if(DB.paymentMethods.length===0){ toast("Cadastre formas de pagamento na aba Dono."); return; }
  openModal(`<h3>Forma de pagamento usada</h3>
    <div class="field"><select id="pmSel">${DB.paymentMethods.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
    <button class="btn btn-primary" id="pmConfirm">Confirmar atendimento concluído</button>`);
  document.getElementById('pmConfirm').onclick=()=>{
    const apt = DB.appointments.find(x=>x.id===appointmentId);
    apt.status='done'; apt.paymentMethodId=document.getElementById('pmSel').value; saveDB();
    closeModal(); toast("Atendimento concluído! O cliente já pode avaliar.");
    state.sub.barbeiro='agenda'; render();
  };
}

function renderBarbSugestoes(body){
  const suggestions = buildAISuggestions(state.user.id);
  body.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">Sugestões geradas automaticamente a partir da sua agenda e histórico de clientes.</p>` +
    (suggestions.length ? suggestions.map(s=>`<div class="ai-card"><div class="tag">${s.tag}</div><p>${s.text}</p></div>`).join('')
    : `<div class="empty"><span class="ic">🤖</span>Sem sugestões no momento — volte quando tiver mais agendamentos e clientes.</div>`);
}
function buildAISuggestions(barberId){
  const out=[];
  const done = DB.appointments.filter(a=>a.barberId===barberId && a.status==='done');
  const lastByClient={};
  done.forEach(a=>{ if(!lastByClient[a.clientId] || a.date>lastByClient[a.clientId]) lastByClient[a.clientId]=a.date; });
  const now=new Date();
  Object.entries(lastByClient).forEach(([cid,date])=>{
    const days = Math.floor((now - new Date(date))/86400000);
    if(days>=28 && days<=40){
      const c=DB.users.find(x=>x.id===cid);
      out.push({tag:'Reengajamento', text:`${c?c.name:'Cliente'} completa ~30 dias sem cortar. Sugestão de mensagem: "Oi ${c?c.name.split(' ')[0]:''}! Faz um tempinho que você não passa por aqui — bora agendar seu corte esta semana? 💈"`});
    }
  });
  const upcoming = DB.appointments.filter(a=>a.barberId===barberId && a.status==='scheduled');
  upcoming.slice(0,3).forEach(a=>{
    const s=DB.services.find(x=>x.id===a.serviceId); const c=DB.users.find(x=>x.id===a.clientId);
    if(s && !/barba/i.test(s.name)){
      out.push({tag:'Upsell', text:`${c?c.name:'Cliente'} já marcou "${s.name}". Vale oferecer o combo corte + barba no atendimento — pode aumentar o ticket médio.`});
    }
  });
  if(done.length>=2){
    out.push({tag:'Instagram', text:`Ideia de post: monte um antes/depois de um degradê recente e marque o cliente (peça autorização) — funciona bem para engajamento.`});
  }
  return out.slice(0,6);
}

function renderBarbComissoes(body){
  const myComms = DB.commissions.filter(c=>c.barberId===state.user.id);
  const doneAppts = DB.appointments.filter(a=>a.barberId===state.user.id && a.status==='done');
  const [filter,setFilter] = [state.tmp.commFilter||'mensal', v=>{state.tmp.commFilter=v;}];
  body.innerHTML = `
    <div class="subnav">
      ${['diario','semanal','mensal'].map(f=>`<button class="${filter===f?'active':''}" data-cf="${f}">${f==='diario'?'Diário':f==='semanal'?'Semanal':'Mensal'}</button>`).join('')}
    </div>
    <div id="commArea"></div>`;
  document.querySelectorAll('[data-cf]').forEach(el=> el.onclick=()=>{ state.tmp.commFilter=el.dataset.cf; renderBarbComissoes(body); });
  const now=new Date();
  const inRange = doneAppts.filter(a=>{
    const d=new Date(a.date);
    if(filter==='diario') return a.date===todayISO();
    if(filter==='semanal'){ const diff=(now-d)/86400000; return diff>=0 && diff<7; }
    return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
  });
  let total=0;
  const rows = inRange.map(a=>{
    const s=DB.services.find(x=>x.id===a.serviceId); if(!s) return '';
    const comm = myComms.find(c=>c.serviceId===a.serviceId);
    const percent = comm?comm.percent:0;
    const value = s.price*(percent/100); total+=value;
    return `<tr><td>${a.date.slice(8,10)}/${a.date.slice(5,7)}</td><td>${s.name}</td><td>${percent}%</td><td>${money(value)}</td></tr>`;
  }).join('');
  document.getElementById('commArea').innerHTML = inRange.length ? `
    <table><thead><tr><th>Data</th><th>Serviço</th><th>Comissão</th><th>Valor</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="text-align:right;margin-top:12px;font-weight:700;font-family:var(--font-mono);color:var(--brass-glow);">Total a receber: ${money(total)}</div>`
    : `<div class="empty">Nenhum atendimento no período selecionado.</div>`;
}

/* ============================== DONO TAB ============================== */
function renderDonoTab(page){
  const subs=[{k:'servicos',l:'Serviços'},{k:'horarios',l:'Horários'},{k:'equipe',l:'Equipe'},
    {k:'financeiro',l:'Financeiro'},{k:'metas',l:'Metas'},{k:'config',l:'Configurações'}];
  const pendingCount = DB.pendingBarberApprovals.length;
  page.innerHTML = `
    <div class="page-head"><p class="eyebrow">Área do dono</p><h1>${DB.settings.name}</h1></div>
    <div class="subnav">${subs.map(s=>`<button class="${state.sub.dono===s.k?'active':''}" data-s="${s.k}">${s.l}${s.k==='equipe'&&pendingCount?` (${pendingCount})`:''}</button>`).join('')}</div>
    <div id="donoBody"></div>`;
  subs.forEach(s=> page.querySelector(`[data-s="${s.k}"]`).onclick=()=>{ state.sub.dono=s.k; render(); });
  const body=document.getElementById('donoBody');
  if(state.sub.dono==='servicos') renderDonoServicos(body);
  if(state.sub.dono==='horarios') renderDonoHorarios(body);
  if(state.sub.dono==='equipe') renderDonoEquipe(body);
  if(state.sub.dono==='financeiro') renderDonoFinanceiro(body);
  if(state.sub.dono==='metas') renderDonoMetas(body);
  if(state.sub.dono==='config') renderDonoConfig(body);
}

/* --- Serviços --- */
function renderDonoServicos(body){
  body.innerHTML = `
    <div class="section-title"><h2>Serviços</h2><button class="btn-sm brass" id="addSvc">+ Novo serviço</button></div>
    ${DB.services.length? `<div class="grid g3">${DB.services.map(s=>`
      <div class="svc-card" data-id="${s.id}">
        <div class="svc-emoji">${s.emoji}</div><div class="svc-name">${s.name}</div>
        <div class="svc-meta"><span>⏱ ${s.duration} min</span><span class="svc-price">${money(s.price)}</span></div>
        <div class="row-actions" style="margin-top:6px;"><button class="btn-sm" data-edit>Editar</button><button class="btn-sm red" data-del>Excluir</button></div>
      </div>`).join('')}</div>` : `<div class="empty">Nenhum serviço cadastrado ainda.</div>`}
  `;
  document.getElementById('addSvc').onclick=()=> openServiceModal();
  document.querySelectorAll('[data-edit]').forEach(el=> el.onclick=(e)=>{ e.stopPropagation(); openServiceModal(el.closest('.svc-card').dataset.id); });
  document.querySelectorAll('[data-del]').forEach(el=> el.onclick=(e)=>{ e.stopPropagation();
    const id=el.closest('.svc-card').dataset.id; DB.services=DB.services.filter(s=>s.id!==id); saveDB(); renderDonoServicos(body); });
}
function openServiceModal(id){
  const s = id ? DB.services.find(x=>x.id===id) : null;
  openModal(`<h3>${s?'Editar':'Novo'} serviço</h3>
    <div class="field"><label>Nome</label><input id="svName" value="${s?s.name:''}"></div>
    <div class="field"><label>Emoji</label><input id="svEmoji" value="${s?s.emoji:'✂️'}" maxlength="4"></div>
    <div class="field"><label>Duração (min)</label><input id="svDur" type="number" value="${s?s.duration:30}"></div>
    <div class="field"><label>Preço (R$)</label><input id="svPrice" type="number" step="0.01" value="${s?s.price:0}"></div>
    <button class="btn btn-primary" id="svSave">Salvar</button>`);
  document.getElementById('svSave').onclick=()=>{
    const name=document.getElementById('svName').value.trim();
    const emoji=document.getElementById('svEmoji').value.trim()||'✂️';
    const duration=Number(document.getElementById('svDur').value)||30;
    const price=Number(document.getElementById('svPrice').value)||0;
    if(!name){ toast("Informe o nome do serviço."); return; }
    if(s){ s.name=name; s.emoji=emoji; s.duration=duration; s.price=price; }
    else{ DB.services.push({id:uid(), name, emoji, duration, price}); }
    saveDB(); closeModal(); render();
  };
}

/* --- Horários --- */
function renderDonoHorarios(body){
  const days=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
  body.innerHTML = `<div class="card">
    <div class="hoursGrid"><span></span><span class="lbl">Aberto</span><span class="lbl">Abre</span><span class="lbl">Fecha</span></div>
    ${days.map((d,i)=>{ const h=DB.settings.hours[i];
      return `<div class="hoursGrid">
        <span class="lbl">${d}</span>
        <input type="checkbox" data-day="${i}" data-f="open" ${!h.closed?'checked':''}>
        <input type="time" data-day="${i}" data-f="openTime" value="${h.open}" ${h.closed?'disabled':''}>
        <input type="time" data-day="${i}" data-f="closeTime" value="${h.close}" ${h.closed?'disabled':''}>
      </div>`; }).join('')}
    <button class="btn btn-primary" style="margin-top:14px;max-width:220px;" id="saveHours">Salvar horários</button>
  </div>`;
  document.getElementById('saveHours').onclick=()=>{
    for(let i=0;i<7;i++){
      const chk=document.querySelector(`[data-day="${i}"][data-f="open"]`).checked;
      const ot=document.querySelector(`[data-day="${i}"][data-f="openTime"]`).value;
      const ct=document.querySelector(`[data-day="${i}"][data-f="closeTime"]`).value;
      DB.settings.hours[i]={closed:!chk, open:ot, close:ct};
    }
    saveDB(); toast("Horários atualizados."); render();
  };
}

/* --- Equipe --- */
function renderDonoEquipe(body){
  const pending = DB.users.filter(u=>DB.pendingBarberApprovals.includes(u.id));
  const active = DB.users.filter(u=>u.role==='barbeiro' && u.status==='active');
  body.innerHTML = `
    <div class="section-title"><h2>Aprovações pendentes</h2></div>
    ${pending.length? pending.map(u=>`<div class="list-row"><div class="main"><div class="name">${u.name}</div><div class="sub">${u.email}</div></div>
      <div class="row-actions"><button class="btn-sm green" data-app="${u.id}">Aprovar</button><button class="btn-sm red" data-rej="${u.id}">Rejeitar</button></div></div>`).join('')
      : `<div class="empty" style="padding:16px;">Nenhuma solicitação pendente.</div>`}
    <div class="section-title"><h2>Equipe ativa</h2></div>
    ${active.length? active.map(u=>{
      const myComms = DB.commissions.filter(c=>c.barberId===u.id);
      return `<div class="list-row"><div class="main"><div class="name">${u.name}</div><div class="sub">${u.email} · ${myComms.length} comissões definidas</div></div>
      <button class="btn-sm" data-comm="${u.id}">Definir comissões</button></div>`;
    }).join('') : `<div class="empty" style="padding:16px;">Nenhum barbeiro ativo ainda.</div>`}
  `;
  document.querySelectorAll('[data-app]').forEach(el=> el.onclick=()=>{
    const u=DB.users.find(x=>x.id===el.dataset.app); u.status='active';
    DB.pendingBarberApprovals=DB.pendingBarberApprovals.filter(id=>id!==u.id);
    saveDB(); toast(`${u.name} aprovado como barbeiro.`); render();
  });
  document.querySelectorAll('[data-rej]').forEach(el=> el.onclick=()=>{
    const id=el.dataset.rej; DB.users=DB.users.filter(x=>x.id!==id);
    DB.pendingBarberApprovals=DB.pendingBarberApprovals.filter(x=>x!==id);
    saveDB(); toast("Solicitação rejeitada."); render();
  });
  document.querySelectorAll('[data-comm]').forEach(el=> el.onclick=()=> openCommissionModal(el.dataset.comm));
}
function openCommissionModal(barberId){
  if(DB.services.length===0){ toast("Cadastre serviços primeiro."); return; }
  openModal(`<h3>Comissões por serviço</h3>
    ${DB.services.map(s=>{
      const c=DB.commissions.find(x=>x.barberId===barberId && x.serviceId===s.id);
      return `<div class="field" style="display:flex;align-items:center;gap:10px;">
        <label style="flex:1;margin:0;">${s.emoji} ${s.name}</label>
        <input type="number" style="width:90px;" data-svc="${s.id}" value="${c?c.percent:0}" min="0" max="100">%
      </div>`;
    }).join('')}
    <button class="btn btn-primary" id="commSave">Salvar comissões</button>`);
  document.getElementById('commSave').onclick=()=>{
    document.querySelectorAll('[data-svc]').forEach(inp=>{
      const svcId=inp.dataset.svc; const percent=Number(inp.value)||0;
      let c = DB.commissions.find(x=>x.barberId===barberId && x.serviceId===svcId);
      if(c) c.percent=percent; else DB.commissions.push({barberId, serviceId:svcId, percent});
    });
    saveDB(); closeModal(); toast("Comissões salvas.");
  };
}

/* --- Financeiro --- */
function renderDonoFinanceiro(body){
  const fsubs=[{k:'visao',l:'Visão geral'},{k:'lancamentos',l:'Lançamentos'},{k:'relatorio',l:'Relatório de serviços'},{k:'categorias',l:'Categorias'},{k:'pagamento',l:'Formas de pgto'},{k:'caixa',l:'Fluxo de caixa'}];
  state.tmp.finSub = state.tmp.finSub || 'visao';
  body.innerHTML = `<div class="subnav">${fsubs.map(f=>`<button class="${state.tmp.finSub===f.k?'active':''}" data-f="${f.k}">${f.l}</button>`).join('')}</div>
    <div id="finArea"></div>`;
  fsubs.forEach(f=> body.querySelector(`[data-f="${f.k}"]`).onclick=()=>{ state.tmp.finSub=f.k; renderDonoFinanceiro(body); });
  const area = document.getElementById('finArea');
  if(state.tmp.finSub==='visao') renderFinVisaoGeral(area);
  if(state.tmp.finSub==='lancamentos') renderFinLancamentos(area);
  if(state.tmp.finSub==='relatorio') renderFinRelatorio(area);
  if(state.tmp.finSub==='categorias') renderFinCategorias(area);
  if(state.tmp.finSub==='pagamento') renderFinPagamento(area);
  if(state.tmp.finSub==='caixa') renderFinCaixa(area);
}

function allRevenueForMonth(m,y){
  const serviceRev = DB.appointments.filter(a=>{ const d=new Date(a.date); return a.status==='done' && d.getMonth()===m && d.getFullYear()===y; })
    .reduce((s,a)=>{ const sv=DB.services.find(x=>x.id===a.serviceId); return s+(sv?sv.price:0); },0);
  const otherRev = DB.financeEntries.filter(e=>{ const d=new Date(e.date); return e.type==='receita' && d.getMonth()===m && d.getFullYear()===y; })
    .reduce((s,e)=>s+Number(e.amount),0);
  return serviceRev+otherRev;
}
function allExpenseForMonth(m,y){
  return DB.financeEntries.filter(e=>{ const d=new Date(e.date); return e.type==='despesa' && d.getMonth()===m && d.getFullYear()===y; })
    .reduce((s,e)=>s+Number(e.amount),0);
}
function renderFinVisaoGeral(area){
  const now=new Date(); const curM=now.getMonth(), curY=now.getFullYear();
  const prev=new Date(curY,curM-1,1);
  const curRev=allRevenueForMonth(curM,curY), prevRev=allRevenueForMonth(prev.getMonth(),prev.getFullYear());
  const curExp=allExpenseForMonth(curM,curY), prevExp=allExpenseForMonth(prev.getMonth(),prev.getFullYear());
  const curProfit=curRev-curExp, prevProfit=prevRev-prevExp;
  const curAttend=DB.appointments.filter(a=>{const d=new Date(a.date);return a.status==='done'&&d.getMonth()===curM&&d.getFullYear()===curY;}).length;
  const prevAttend=DB.appointments.filter(a=>{const d=new Date(a.date);return a.status==='done'&&d.getMonth()===prev.getMonth()&&d.getFullYear()===prev.getFullYear();}).length;

  const months12=[]; for(let i=11;i>=0;i--){ const d=new Date(curY,curM-i,1); months12.push({m:d.getMonth(),y:d.getFullYear(),rev:allRevenueForMonth(d.getMonth(),d.getFullYear())}); }
  months12.forEach(x=> x.exp = allExpenseForMonth(x.m,x.y));
  const maxBar = Math.max(1,...months12.map(x=>Math.max(x.rev,x.exp)));
  const revSlices = revenueBreakdown(curM,curY);
  const expSlices = expenseBreakdown(curM,curY);

  area.innerHTML = `
    <div class="grid g4">
      <div class="stat-card"><div class="label">Faturamento do mês</div><div class="value">${money(curRev)}</div>
        <div class="delta ${curRev>=prevRev?'up':'down'}">${pct(curRev,prevRev)>=0?'+':''}${pct(curRev,prevRev)}% vs. anterior</div></div>
      <div class="stat-card"><div class="label">Lucro líquido</div><div class="value">${money(curProfit)}</div>
        <div class="delta ${curProfit>=prevProfit?'up':'down'}">${pct(curProfit,prevProfit)>=0?'+':''}${pct(curProfit,prevProfit)}% vs. anterior</div></div>
      <div class="stat-card"><div class="label">Atendimentos do mês</div><div class="value">${curAttend}</div>
        <div class="delta ${curAttend>=prevAttend?'up':'down'}">${pct(curAttend,prevAttend)>=0?'+':''}${pct(curAttend,prevAttend)}% vs. anterior</div></div>
      <div class="stat-card"><div class="label">Despesas do mês</div><div class="value">${money(curExp)}</div></div>
    </div>
    <div class="section-title"><h2>Composição do mês</h2></div>
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">
      ${pieCardHtml("Receitas do mês", revSlices, curRev)}
      ${pieCardHtml("Despesas do mês", expSlices, curExp)}
    </div>
    <div class="section-title"><h2>Receitas x Despesas — últimos 12 meses</h2></div>
    <div class="card">
      <div style="display:flex;gap:16px;margin-bottom:12px;font-size:12px;color:var(--text-dim);">
        <span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--green);margin-right:6px;"></i>Receita</span>
        <span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--red);margin-right:6px;"></i>Despesa</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:8px;height:180px;">
      ${months12.map(x=>`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
        <div style="display:flex;align-items:flex-end;gap:2px;width:100%;height:130px;">
          <div style="flex:1;background:var(--green);border-radius:3px 3px 0 0;height:${Math.max(3,(x.rev/maxBar)*130)}px;" title="Receita ${monthName(x.m)}: ${money(x.rev)}"></div>
          <div style="flex:1;background:var(--red);border-radius:3px 3px 0 0;height:${Math.max(3,(x.exp/maxBar)*130)}px;" title="Despesa ${monthName(x.m)}: ${money(x.exp)}"></div>
        </div>
        <span style="font-size:10px;color:var(--text-faint);">${monthName(x.m)}</span>
      </div>`).join('')}
      </div>
    </div>`;
}

const PIE_COLORS = ["#c9a227","#e0b83a","#4caf7d","#3f8cff","#b45cd6","#ff8a3d","#e05252","#7a8b99","#2fb0a5","#d4d4d4"];
function revenueBreakdown(m,y){
  const map={};
  DB.appointments.filter(a=>{ const d=new Date(a.date); return a.status==='done' && d.getMonth()===m && d.getFullYear()===y; })
    .forEach(a=>{ const sv=DB.services.find(x=>x.id===a.serviceId); const name = sv? sv.name : 'Serviços';
      map[name]=(map[name]||0)+(sv?sv.price:0); });
  DB.financeEntries.filter(e=>{ const d=new Date(e.date); return e.type==='receita' && d.getMonth()===m && d.getFullYear()===y; })
    .forEach(e=>{ const c=DB.categories.find(c=>c.id===e.categoryId); const name=c?c.name:'Outras receitas';
      map[name]=(map[name]||0)+Number(e.amount); });
  return Object.entries(map).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value);
}
function expenseBreakdown(m,y){
  const map={};
  DB.financeEntries.filter(e=>{ const d=new Date(e.date); return e.type==='despesa' && d.getMonth()===m && d.getFullYear()===y; })
    .forEach(e=>{ const c=DB.categories.find(c=>c.id===e.categoryId); const name=c?c.name:'Outras despesas';
      map[name]=(map[name]||0)+Number(e.amount); });
  return Object.entries(map).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value);
}
function pieCardHtml(title, slices, total){
  if(!total || slices.length===0){
    return `<div class="card"><div style="font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">${title}</div>
      <div class="empty">Sem dados neste mês.</div></div>`;
  }
  let acc=0;
  const stops = slices.map((s,i)=>{
    const start=(acc/total)*100; acc+=s.value; const end=(acc/total)*100;
    return `${PIE_COLORS[i%PIE_COLORS.length]} ${start}% ${end}%`;
  }).join(',');
  return `<div class="card">
    <div style="font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">${title}</div>
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
      <div style="width:150px;height:150px;border-radius:50%;background:conic-gradient(${stops});flex:none;"></div>
      <div style="flex:1;min-width:140px;">
        ${slices.map((s,i)=>`<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px;">
          <i style="width:10px;height:10px;border-radius:2px;background:${PIE_COLORS[i%PIE_COLORS.length]};flex:none;"></i>
          <span style="flex:1;">${s.label}</span>
          <span style="font-family:var(--font-mono);">${money(s.value)} · ${Math.round((s.value/total)*100)}%</span>
        </div>`).join('')}
        <div style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px;font-size:12px;display:flex;justify-content:space-between;">
          <b>Total</b><b style="font-family:var(--font-mono);">${money(total)}</b></div>
      </div>
    </div>
  </div>`;
}

/* --- Relatório de serviços prestados --- */
function renderFinRelatorio(area){
  const t = state.tmp;
  if(!t.repFrom){ const d=new Date(); t.repFrom = new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10); }
  if(!t.repTo) t.repTo = todayISO();
  if(!t.repMode) t.repMode = 'periodo';
  const from=t.repFrom, to=t.repTo;
  const done = DB.appointments.filter(a=>a.status==='done' && a.date>=from && a.date<=to);
  const svcName = id => { const s=DB.services.find(x=>x.id===id); return s? s.name : 'Serviço removido'; };
  const svcPrice = id => { const s=DB.services.find(x=>x.id===id); return s? s.price : 0; };

  const byService={};
  done.forEach(a=>{ const k=a.serviceId; byService[k]=byService[k]||{qty:0,total:0}; byService[k].qty++; byService[k].total+=svcPrice(a.serviceId); });
  const totQty=done.length, totVal=Object.values(byService).reduce((s,x)=>s+x.total,0);

  const byDay={};
  done.forEach(a=>{ byDay[a.date]=byDay[a.date]||{}; const d=byDay[a.date];
    d[a.serviceId]=d[a.serviceId]||{qty:0,total:0}; d[a.serviceId].qty++; d[a.serviceId].total+=svcPrice(a.serviceId); });

  area.innerHTML = `
    <div class="section-title"><h2>Relatório de serviços prestados</h2></div>
    <div class="card" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;">
      <div class="field" style="margin:0;"><label>De</label><input id="repFrom" type="date" value="${from}"></div>
      <div class="field" style="margin:0;"><label>Até</label><input id="repTo" type="date" value="${to}"></div>
      <div class="field" style="margin:0;"><label>Agrupar</label>
        <select id="repMode">
          <option value="periodo" ${t.repMode==='periodo'?'selected':''}>Por período (total)</option>
          <option value="dia" ${t.repMode==='dia'?'selected':''}>Por dia</option>
        </select></div>
      <button class="btn-sm brass" id="repGo">Gerar</button>
    </div>
    <div class="grid g4" style="margin-bottom:12px;">
      <div class="stat-card"><div class="label">Serviços prestados</div><div class="value">${totQty}</div></div>
      <div class="stat-card"><div class="label">Valor total</div><div class="value">${money(totVal)}</div></div>
      <div class="stat-card"><div class="label">Ticket médio</div><div class="value">${money(totQty?totVal/totQty:0)}</div></div>
    </div>
    ${totQty===0 ? `<div class="empty">Nenhum serviço prestado nesse período.</div>` :
      (t.repMode==='periodo'
        ? `<table><thead><tr><th>Serviço</th><th>Quantidade</th><th>Valor total</th></tr></thead><tbody>
            ${Object.entries(byService).sort((a,b)=>b[1].total-a[1].total).map(([id,v])=>
              `<tr><td>${svcName(id)}</td><td>${v.qty}</td><td>${money(v.total)}</td></tr>`).join('')}
            <tr><td><b>Total</b></td><td><b>${totQty}</b></td><td><b>${money(totVal)}</b></td></tr>
          </tbody></table>`
        : Object.keys(byDay).sort().reverse().map(day=>{
            const rows=Object.entries(byDay[day]);
            const dq=rows.reduce((s,[,v])=>s+v.qty,0), dv=rows.reduce((s,[,v])=>s+v.total,0);
            return `<div class="card" style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <b>${formatDatePt(day)}</b>
                <span style="font-family:var(--font-mono);color:var(--brass-glow);">${dq} serviço(s) · ${money(dv)}</span></div>
              <table><thead><tr><th>Serviço</th><th>Quantidade</th><th>Valor</th></tr></thead><tbody>
                ${rows.sort((a,b)=>b[1].total-a[1].total).map(([id,v])=>`<tr><td>${svcName(id)}</td><td>${v.qty}</td><td>${money(v.total)}</td></tr>`).join('')}
              </tbody></table></div>`;
          }).join(''))}`;

  area.querySelector('#repGo').onclick=()=>{
    t.repFrom=area.querySelector('#repFrom').value||from;
    t.repTo=area.querySelector('#repTo').value||to;
    t.repMode=area.querySelector('#repMode').value;
    renderFinRelatorio(area);
  };
}
function renderFinLancamentos(area){
  area.innerHTML = `
    <div class="section-title"><h2>Lançamentos</h2><button class="btn-sm brass" id="addEntry">+ Nova receita/despesa</button></div>
    ${DB.financeEntries.length? `<table><thead><tr><th>Data</th><th>Tipo</th><th>Categoria</th><th>Descrição</th><th>Pagamento</th><th>Valor</th></tr></thead><tbody>
      ${DB.financeEntries.slice().sort((a,b)=>new Date(b.date)-new Date(a.date)).map(e=>{
        const cat=DB.categories.find(c=>c.id===e.categoryId); const pm=DB.paymentMethods.find(p=>p.id===e.paymentMethodId);
        return `<tr><td>${e.date.slice(8,10)}/${e.date.slice(5,7)}</td><td style="color:${e.type==='receita'?'var(--green)':'var(--red)'}">${e.type==='receita'?'Receita':'Despesa'}</td>
        <td>${cat?cat.name:''}</td><td>${e.description||''}</td><td>${pm?pm.name:''}</td><td>${money(e.amount)}</td></tr>`;
      }).join('')}</tbody></table>` : `<div class="empty">Nenhum lançamento ainda.</div>`}`;
  document.getElementById('addEntry').onclick=()=> openEntryModal();
}
function openEntryModal(){
  if(DB.categories.length===0 || DB.paymentMethods.length===0){ toast("Cadastre categorias e formas de pagamento primeiro."); return; }
  openModal(`<h3>Novo lançamento</h3>
    <div class="field"><label>Tipo</label><select id="enType"><option value="receita">Receita</option><option value="despesa">Despesa</option></select></div>
    <div class="field"><label>Categoria</label><select id="enCat"></select></div>
    <div class="field"><label>Descrição</label><input id="enDesc"></div>
    <div class="field"><label>Valor (R$)</label><input id="enVal" type="number" step="0.01"></div>
    <div class="field"><label>Data</label><input id="enDate" type="date" value="${todayISO()}"></div>
    <div class="field"><label>Forma de pagamento</label><select id="enPm">${DB.paymentMethods.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select></div>
    <button class="btn btn-primary" id="enSave">Salvar</button>`);
  const typeSel=document.getElementById('enType'), catSel=document.getElementById('enCat');
  function refreshCats(){ catSel.innerHTML = DB.categories.filter(c=>c.type===typeSel.value).map(c=>`<option value="${c.id}">${c.name}</option>`).join(''); }
  typeSel.onchange=refreshCats; refreshCats();
  document.getElementById('enSave').onclick=()=>{
    const amount=Number(document.getElementById('enVal').value);
    if(!amount){ toast("Informe um valor válido."); return; }
    if(!catSel.value){ toast("Cadastre uma categoria desse tipo primeiro."); return; }
    DB.financeEntries.push({id:uid(), type:typeSel.value, categoryId:catSel.value, description:document.getElementById('enDesc').value,
      amount, date:document.getElementById('enDate').value||todayISO(), paymentMethodId:document.getElementById('enPm').value});
    saveDB(); closeModal(); toast("Lançamento salvo."); render();
  };
}
function renderFinCategorias(area){
  area.innerHTML = `<div class="section-title"><h2>Categorias</h2><button class="btn-sm brass" id="addCat">+ Nova categoria</button></div>
    ${DB.categories.map(c=>`<div class="list-row"><div class="main"><div class="name">${c.name}</div><div class="sub" style="color:${c.type==='receita'?'var(--green)':'var(--red)'}">${c.type==='receita'?'Receita':'Despesa'}</div></div>
      <div class="row-actions"><button class="btn-sm" data-editcat="${c.id}">Editar</button><button class="btn-sm red" data-delcat="${c.id}">Excluir</button></div></div>`).join('')}`;
  document.getElementById('addCat').onclick=()=> openCatModal();
  document.querySelectorAll('[data-editcat]').forEach(el=> el.onclick=()=> openCatModal(el.dataset.editcat));
  document.querySelectorAll('[data-delcat]').forEach(el=> el.onclick=()=>{
    DB.categories = DB.categories.filter(c=>c.id!==el.dataset.delcat); saveDB(); renderFinCategorias(area);
  });
}
function openCatModal(id){
  const c = id ? DB.categories.find(x=>x.id===id) : null;
  openModal(`<h3>${c?'Editar':'Nova'} categoria</h3>
    <div class="field"><label>Nome</label><input id="catName" value="${c?c.name:''}"></div>
    <div class="field"><label>Tipo</label><select id="catType"><option value="receita" ${c&&c.type==='receita'?'selected':''}>Receita</option><option value="despesa" ${c&&c.type==='despesa'?'selected':''}>Despesa</option></select></div>
    <button class="btn btn-primary" id="catSave">Salvar</button>`);
  document.getElementById('catSave').onclick=()=>{
    const name=document.getElementById('catName').value.trim(); const type=document.getElementById('catType').value;
    if(!name){ toast("Informe o nome."); return; }
    if(c){ c.name=name; c.type=type; } else { DB.categories.push({id:uid(), name, type}); }
    saveDB(); closeModal(); render();
  };
}
function renderFinPagamento(area){
  area.innerHTML = `<div class="section-title"><h2>Formas de pagamento</h2><button class="btn-sm brass" id="addPm">+ Nova forma</button></div>
    ${DB.paymentMethods.map(p=>`<div class="list-row"><div class="main"><div class="name">${p.name}</div></div>
      <div class="row-actions"><button class="btn-sm" data-editpm="${p.id}">Editar</button><button class="btn-sm red" data-delpm="${p.id}">Excluir</button></div></div>`).join('')
      || `<div class="empty">Nenhuma forma de pagamento cadastrada.</div>`}`;
  document.getElementById('addPm').onclick=()=> openPmModal(null, area);
  document.querySelectorAll('[data-editpm]').forEach(el=> el.onclick=()=> openPmModal(el.dataset.editpm, area));
  document.querySelectorAll('[data-delpm]').forEach(el=> el.onclick=()=>{
    DB.paymentMethods = DB.paymentMethods.filter(p=>p.id!==el.dataset.delpm); saveDB(); renderFinPagamento(area);
  });
}
function openPmModal(id, area){
  const p = id ? DB.paymentMethods.find(x=>x.id===id) : null;
  openModal(`<h3>${p?'Editar':'Nova'} forma de pagamento</h3>
    <div class="field"><label>Nome</label><input id="pmName" value="${p?p.name:''}" placeholder="Ex: Pix"></div>
    <button class="btn btn-primary" id="pmSave">Salvar</button>`);
  document.getElementById('pmSave').onclick=()=>{
    const name=document.getElementById('pmName').value.trim();
    if(!name){ toast("Informe o nome."); return; }
    if(p) p.name=name; else DB.paymentMethods.push({id:uid(), name});
    saveDB(); closeModal(); toast("Forma de pagamento salva."); renderFinPagamento(area);
  };
}
function renderFinCaixa(area){
  const byMethod={};
  DB.paymentMethods.forEach(p=> byMethod[p.id]={name:p.name, in:0, out:0});
  DB.appointments.filter(a=>a.status==='done' && a.paymentMethodId).forEach(a=>{
    const s=DB.services.find(x=>x.id===a.serviceId); if(byMethod[a.paymentMethodId]) byMethod[a.paymentMethodId].in += (s?s.price:0);
  });
  DB.financeEntries.forEach(e=>{
    if(!byMethod[e.paymentMethodId]) return;
    if(e.type==='receita') byMethod[e.paymentMethodId].in += Number(e.amount);
    else byMethod[e.paymentMethodId].out += Number(e.amount);
  });
  area.innerHTML = `<div class="section-title"><h2>Fluxo de caixa por forma de pagamento</h2></div>
    <table><thead><tr><th>Forma</th><th>Entradas</th><th>Saídas</th><th>Saldo</th></tr></thead><tbody>
    ${Object.values(byMethod).map(m=>`<tr><td>${m.name}</td><td style="color:var(--green)">${money(m.in)}</td><td style="color:var(--red)">${money(m.out)}</td><td>${money(m.in-m.out)}</td></tr>`).join('')}
    </tbody></table>`;
}

/* --- Metas --- */
function renderDonoMetas(body){
  const barbers = DB.users.filter(u=>u.role==='barbeiro' && u.status==='active');
  const curMonthKey = todayISO().slice(0,7);
  body.innerHTML = `<div class="section-title"><h2>Metas mensais</h2><button class="btn-sm brass" id="addGoal">+ Nova meta</button></div>
    ${DB.goals.filter(g=>g.month===curMonthKey).length? DB.goals.filter(g=>g.month===curMonthKey).map(g=>{
      const b=DB.users.find(u=>u.id===g.barberId);
      const now=new Date();
      let progress=0;
      if(g.type==='faturamento'){ progress = allRevenueForBarberMonth(g.barberId, now.getMonth(), now.getFullYear()); }
      else { progress = DB.appointments.filter(a=>a.barberId===g.barberId && a.status==='done' && new Date(a.date).getMonth()===now.getMonth()).length; }
      const percent = Math.min(100, Math.round((progress/g.target)*100));
      return `<div class="card" style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <div><b>${b?b.name:''}</b> — ${g.type==='faturamento'?'Faturamento':'Atendimentos'}</div>
          <div style="font-family:var(--font-mono);color:var(--brass-glow);">${g.type==='faturamento'?money(progress):progress} / ${g.type==='faturamento'?money(g.target):g.target}</div>
        </div>
        <div style="height:10px;background:var(--bg2);border-radius:6px;overflow:hidden;"><div style="height:100%;width:${percent}%;background:linear-gradient(90deg,var(--brass),var(--brass-glow));"></div></div>
        <div style="font-size:12px;color:var(--text-faint);margin-top:6px;">🎁 Prêmio: ${g.reward} · ${percent}% concluído</div>
      </div>`;
    }).join('') : `<div class="empty">Nenhuma meta cadastrada para este mês.</div>`}`;
  document.getElementById('addGoal').onclick=()=>{
    if(barbers.length===0){ toast("Nenhum barbeiro ativo ainda."); return; }
    openModal(`<h3>Nova meta mensal</h3>
      <div class="field"><label>Barbeiro</label><select id="goalBarber">${barbers.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}</select></div>
      <div class="field"><label>Tipo de meta</label><select id="goalType"><option value="faturamento">Faturamento (R$)</option><option value="atendimentos">Nº de atendimentos</option></select></div>
      <div class="field"><label>Valor alvo</label><input id="goalTarget" type="number"></div>
      <div class="field"><label>Prêmio</label><input id="goalReward" placeholder="Ex: bônus de R$100"></div>
      <button class="btn btn-primary" id="goalSave">Salvar meta</button>`);
    document.getElementById('goalSave').onclick=()=>{
      DB.goals.push({id:uid(), barberId:document.getElementById('goalBarber').value, type:document.getElementById('goalType').value,
        target:Number(document.getElementById('goalTarget').value)||1, reward:document.getElementById('goalReward').value||'—', month:curMonthKey});
      saveDB(); closeModal(); render();
    };
  };
}
function allRevenueForBarberMonth(barberId,m,y){
  return DB.appointments.filter(a=>{ const d=new Date(a.date); return a.barberId===barberId && a.status==='done' && d.getMonth()===m && d.getFullYear()===y; })
    .reduce((s,a)=>{ const sv=DB.services.find(x=>x.id===a.serviceId); return s+(sv?sv.price:0); },0);
}

/* --- Configurações --- */
function renderDonoConfig(body){
  const s=DB.settings;
  body.innerHTML = `<div class="card">
    <div class="field"><label>Emoji / logo</label><input id="cfLogo" value="${s.logo}" maxlength="4"></div>
    <div class="field"><label>Nome da barbearia</label><input id="cfName" value="${s.name}"></div>
    <div class="field"><label>Endereço</label><input id="cfAddr" value="${s.address}"></div>
    <div class="field"><label>Telefone / WhatsApp</label><input id="cfPhone" value="${s.phone}"></div>
    <div class="field"><label>Instagram</label><input id="cfInsta" value="${s.instagram}"></div>
    <button class="btn btn-primary" id="cfSave">Salvar configurações</button>
  </div>`;
  document.getElementById('cfSave').onclick=()=>{
    s.logo=document.getElementById('cfLogo').value||'💈'; s.name=document.getElementById('cfName').value||s.name;
    s.address=document.getElementById('cfAddr').value; s.phone=document.getElementById('cfPhone').value; s.instagram=document.getElementById('cfInsta').value;
    saveDB(); toast("Configurações salvas."); render();
  };
}

/* ============================== BOOT ============================== */
document.addEventListener('click', (e)=>{
  if(!e.target.closest('.user-menu')){
    ['ddUser','ddBell'].forEach(id=>{ const el=document.getElementById(id); if(el) el.classList.add('hidden'); });
  }
});

(async function boot(){
  document.getElementById('root').innerHTML = `<div class="auth-wrap"><div style="color:var(--text-faint);">Carregando…</div></div>`;
  await loadDB();
  // Links vindos do e-mail (confirmação de cadastro / redefinição de senha)
  const hash = new URLSearchParams((window.location.hash||'').replace(/^#/,''));
  const token = hash.get('access_token'); const type = hash.get('type');
  if(token){
    history.replaceState(null,'',window.location.pathname);
    if(type==='recovery'){ state.tmp.recoveryToken=token; state.route='reset'; render(); return; }
    try{
      const me = await sbCall('/user', {method:'GET', token});
      const local = me && me.email ? findUserByEmail(me.email) : null;
      if(local && local.role!=='barbeiro' && local.status!=='active'){ local.status='active'; saveDB(); }
      toast("E-mail confirmado! Sua conta está ativa.");
    }catch(e){ /* link expirado */ }
  }
  render();
})();
