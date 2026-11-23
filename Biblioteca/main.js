function escapar(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}
function normalizar(texto) {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function buscarLivro(id) {
  return LIVROS.find(function (l) { return l.id === id; });
}
function el(id) { return document.getElementById(id); }
function janela(id) { return bootstrap.Modal.getOrCreateInstance(el(id)); }

const MSG_SEM_CONFIG = "O site ainda não foi conectado ao Firebase. Siga o passo a passo do arquivo LEIA-ME.md.";
const FB_VERSAO = "10.12.2";
let fbPromessa = null;

function carregarFirebase() {
  if (fbPromessa) return fbPromessa;
  fbPromessa = (async function () {
    if (typeof FIREBASE_CONFIG === "undefined" || !FIREBASE_CONFIG.apiKey || /^COLE/.test(FIREBASE_CONFIG.apiKey)) {
      throw { code: "app/sem-config" };
    }
    const base = "https://www.gstatic.com/firebasejs/" + FB_VERSAO + "/";
    const mods = await Promise.all([
      import(base + "firebase-app.js"),
      import(base + "firebase-auth.js"),
      import(base + "firebase-firestore.js")
    ]);
    const app = mods[0].initializeApp(FIREBASE_CONFIG);
    return { A: mods[1], F: mods[2], auth: mods[1].getAuth(app), db: mods[2].getFirestore(app) };
  })();
  return fbPromessa;
}

function erroFirebase(e) {
  const c = (e && e.code) || "";
  const tabela = {
    "app/sem-config": [0, MSG_SEM_CONFIG],
    "auth/email-already-in-use": [409, "Este e-mail já tem cadastro. Use \"Entrar\"."],
    "auth/invalid-email": [400, "Digite um e-mail válido, como voce@exemplo.com."],
    "auth/weak-password": [400, "A senha precisa ter pelo menos 8 caracteres."],
    "auth/invalid-credential": [401, "E-mail ou senha incorretos."],
    "auth/wrong-password": [401, "E-mail ou senha incorretos."],
    "auth/user-not-found": [401, "E-mail ou senha incorretos."],
    "auth/too-many-requests": [429, "Muitas tentativas. Aguarde alguns minutos."],
    "auth/network-request-failed": [0, "Sem conexão com a internet. Tente de novo."],
    "auth/operation-not-allowed": [500, "O login por e-mail e senha não está ativado no Firebase (veja o LEIA-ME.md)."],
    "permission-denied": [403, "Sem permissão no banco de dados. Confira as regras do Firestore (veja o LEIA-ME.md)."]
  };
  if (!tabela[c]) console.error(e);
  const t = tabela[c] || [500, "Não foi possível concluir. Tente de novo."];
  return { ok: false, status: t[0], dados: { erro: t[1] } };
}

function estadoFirebase(user, dados) {
  dados = dados || {};
  return {
    usuario: { nome: dados.nome || user.displayName || "Leitor", email: user.email },
    reservas: dados.reservas || [],
    favoritos: dados.favoritos || [],
    datas: dados.datas || {}
  };
}

async function lerPerfil(fb, user) {
  const ref = fb.F.doc(fb.db, "usuarios", user.uid);
  const snap = await fb.F.getDoc(ref);
  if (snap.exists()) return snap.data();
  const novo = { nome: user.displayName || "Leitor", email: user.email, reservas: [], favoritos: [], datas: {} };
  await fb.F.setDoc(ref, novo);
  return novo;
}

// Mesma interface de antes (metodo, url, corpo), agora falando com o Firebase.
async function api(metodo, url, corpo) {
  try {
    const fb = await carregarFirebase();
    const A = fb.A, F = fb.F;
    await fb.auth.authStateReady();
    corpo = corpo || {};

    if (url === "/api/me") {
      const user = fb.auth.currentUser;
      if (!user) return { ok: false, status: 401, dados: { erro: "Não autenticado." } };
      return { ok: true, status: 200, dados: estadoFirebase(user, await lerPerfil(fb, user)) };
    }

    if (url === "/api/cadastro") {
      await A.setPersistence(fb.auth, corpo.lembrar ? A.browserLocalPersistence : A.browserSessionPersistence);
      const cred = await A.createUserWithEmailAndPassword(fb.auth, corpo.email, corpo.senha);
      await A.updateProfile(cred.user, { displayName: corpo.nome });
      const perfil = { nome: corpo.nome, email: cred.user.email, reservas: [], favoritos: [], datas: {}, criadoEm: new Date().toISOString() };
      await F.setDoc(F.doc(fb.db, "usuarios", cred.user.uid), perfil);
      return { ok: true, status: 201, dados: estadoFirebase(cred.user, perfil) };
    }

    if (url === "/api/login") {
      await A.setPersistence(fb.auth, corpo.lembrar ? A.browserLocalPersistence : A.browserSessionPersistence);
      const cred = await A.signInWithEmailAndPassword(fb.auth, corpo.email, corpo.senha);
      return { ok: true, status: 200, dados: estadoFirebase(cred.user, await lerPerfil(fb, cred.user)) };
    }

    if (url === "/api/logout") {
      await A.signOut(fb.auth);
      return { ok: true, status: 200, dados: { ok: true } };
    }

    const m = url.match(/^\/api\/(reservas|favoritos)(?:\/(\d+))?$/);
    if (m) {
      const user = fb.auth.currentUser;
      if (!user) return { ok: false, status: 401, dados: { erro: "Entre na sua conta para continuar." } };
      const campo = m[1];
      const id = Number(metodo === "DELETE" ? m[2] : corpo.livroId);
      if (!Number.isInteger(id) || id < 1 || id > 100000) return { ok: false, status: 400, dados: { erro: "Livro inválido." } };
      const ref = F.doc(fb.db, "usuarios", user.uid);
      await lerPerfil(fb, user);
      const mudanca = {};
      if (metodo === "DELETE") {
        mudanca[campo] = F.arrayRemove(id);
        if (campo === "reservas") mudanca["datas." + id] = F.deleteField();
      } else {
        mudanca[campo] = F.arrayUnion(id);
        if (campo === "reservas") mudanca["datas." + id] = new Date().toISOString();
      }
      await F.updateDoc(ref, mudanca);
      const dados = (await F.getDoc(ref)).data();
      return { ok: true, status: 200, dados: campo === "reservas"
        ? { reservas: dados.reservas || [], datas: dados.datas || {} }
        : { favoritos: dados.favoritos || [] } };
    }

    return { ok: false, status: 404, dados: { erro: "Rota não encontrada." } };
  } catch (e) {
    return erroFirebase(e);
  }
}

let usuario = null;
let reservas = new Set();
let favoritos = new Set();
let datas = {};
let verDepois = null;
let livroAberto = null;
let pendenteLivro = null;
let abrirLoginDepois = false;

const ICONE_SALVAR =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v16l-5-3.5L7 20z"/></svg>';

function criarCartao(livro, salvo) {
  const imagem = livro.capa
    ? '<img src="' + escapar(livro.capa) + '" alt="Capa de ' + escapar(livro.titulo) + '" onerror="this.remove()">'
    : "";
  const selo = livro.disponivel
    ? '<span class="livro-selo">Disponível</span>'
    : '<span class="livro-selo indisponivel">Emprestado</span>';
  return (
    '<article class="livro" style="--tom:' + escapar(livro.cor) + '">' +
      '<button type="button" class="livro-abrir" data-abrir="' + livro.id + '" aria-label="Ver detalhes de ' + escapar(livro.titulo) + '">' +
        '<div class="livro-capa">' +
          '<div class="livro-sobre">' +
            '<p class="livro-categoria">' + escapar(livro.categoria) + "</p>" +
            '<h3 class="livro-titulo-capa">' + escapar(livro.titulo) + "</h3>" +
            '<p class="livro-autor-capa">' + escapar(livro.autor) + "</p>" +
          "</div>" +
          imagem + selo +
        "</div>" +
      "</button>" +
      '<div class="livro-rodape">' +
        "<div>" +
          '<h3 class="livro-nome"><button type="button" class="livro-nome-btn" data-abrir="' + livro.id + '">' + escapar(livro.titulo) + "</button></h3>" +
          '<p class="livro-autor">' + escapar(livro.autor) + "</p>" +
        "</div>" +
        '<button type="button" class="btn-salvar' + (salvo ? " ativo" : "") + '" data-id="' + livro.id +
          '" aria-pressed="' + salvo + '" aria-label="Salvar ' + escapar(livro.titulo) + '">' + ICONE_SALVAR + "</button>" +
      "</div>" +
    "</article>"
  );
}

const heroArte = el("hero-arte");
if (heroArte && typeof HERO_IMAGEM !== "undefined" && HERO_IMAGEM) {
  const teste = new Image();
  teste.onload = function () {
    heroArte.style.backgroundImage = "url('" + HERO_IMAGEM + "'), " + getComputedStyle(heroArte).backgroundImage;
  };
  teste.src = HERO_IMAGEM;
}

const lista = el("lista-catalogo");

function dois(n) { return String(n).padStart(2, "0"); }

if (lista) {
  const campoBusca = el("busca-texto");
  const contador   = el("contador");
  const semResult  = el("sem-resultados");
  const setaAnt    = el("seta-anterior");
  const setaProx   = el("seta-proximo");
  const barra      = el("progresso-barra");
  const textoProg  = el("progresso-texto");

  function passo() {
    const cartao = lista.querySelector(".livro");
    return cartao ? cartao.offsetWidth + parseFloat(getComputedStyle(lista).columnGap || 24) : 300;
  }

  function atualizarProgresso() {
    const total = lista.querySelectorAll(".livro").length;
    const maximo = lista.scrollWidth - lista.clientWidth;
    const razao = maximo > 0 ? lista.scrollLeft / maximo : 0;
    const atual = total ? Math.round(razao * (total - 1)) + 1 : 0;
    const visivel = total ? Math.min(1, lista.clientWidth / (lista.scrollWidth / total) / total) : 1;
    barra.style.width = Math.min(100, Math.max(12, (razao * (1 - visivel) + visivel) * 100)) + "%";
    textoProg.textContent = dois(atual) + " / " + dois(total);
    setaAnt.disabled = lista.scrollLeft <= 2;
    setaProx.disabled = lista.scrollLeft >= maximo - 2;
  }

  function filtrar() {
    const termo = normalizar(campoBusca.value.trim());
    const resultado = LIVROS.filter(function (livro) {
      return !termo || normalizar(livro.titulo).includes(termo) || normalizar(livro.autor).includes(termo);
    });
    lista.innerHTML = resultado.map(function (l) { return criarCartao(l, favoritos.has(l.id)); }).join("");
    lista.scrollLeft = 0;
    contador.textContent = resultado.length + (resultado.length === 1 ? " livro" : " livros");
    semResult.classList.toggle("d-none", resultado.length > 0);
    atualizarProgresso();
  }

  lista.addEventListener("click", function (e) {
    const botaoSalvar = e.target.closest(".btn-salvar");
    if (botaoSalvar) { alternarFavorito(botaoSalvar); return; }
    const abrir = e.target.closest("[data-abrir]");
    if (abrir) abrirLivro(Number(abrir.dataset.abrir));
  });

  setaAnt.addEventListener("click",  function () { lista.scrollBy({ left: -passo(), behavior: "smooth" }); });
  setaProx.addEventListener("click", function () { lista.scrollBy({ left:  passo(), behavior: "smooth" }); });
  lista.addEventListener("scroll", atualizarProgresso, { passive: true });
  window.addEventListener("resize", atualizarProgresso);
  campoBusca.addEventListener("input", filtrar);

  const lupa = el("btn-buscar");
  if (lupa) lupa.addEventListener("click", function () { setTimeout(function () { campoBusca.focus({ preventScroll: true }); }, 400); });

  filtrar();
}

async function alternarFavorito(botao) {
  if (!usuario) { janela("modalLogin").show(); return; }
  const id = Number(botao.dataset.id);
  botao.disabled = true;
  const r = favoritos.has(id)
    ? await api("DELETE", "/api/favoritos/" + id)
    : await api("POST", "/api/favoritos", { livroId: id });
  botao.disabled = false;
  if (r.status === 401) { definirUsuario(null); janela("modalLogin").show(); return; }
  if (!r.ok) return;
  favoritos = new Set(r.dados.favoritos);
  marcarFavoritos();
}

function marcarFavoritos() {
  document.querySelectorAll(".btn-salvar").forEach(function (b) {
    const on = favoritos.has(Number(b.dataset.id));
    b.classList.toggle("ativo", on);
    b.setAttribute("aria-pressed", on);
  });
  renderPerfil();
}

function formatarData(d) { return d.toLocaleDateString("pt-BR"); }

function itemPerfil(livro, extra, botoes) {
  const capa = livro.capa ? '<img src="' + escapar(livro.capa) + '" alt="" onerror="this.remove()">' : "";
  return (
    '<article class="perfil-item">' +
      '<button type="button" class="perfil-capa" style="--tom:' + escapar(livro.cor) + '" data-ver="' + livro.id + '" aria-label="Ver detalhes de ' + escapar(livro.titulo) + '">' + capa + "</button>" +
      '<div class="perfil-item-info">' +
        '<h3 class="perfil-item-titulo">' + escapar(livro.titulo) + "</h3>" +
        '<p class="perfil-item-autor">' + escapar(livro.autor) + "</p>" +
        extra +
      "</div>" +
      '<div class="perfil-item-acoes">' + botoes + "</div>" +
    "</article>"
  );
}

function renderPerfil() {
  const painelFav = el("painel-favoritos");
  if (!painelFav) return;
  const painelEmp = el("painel-emprestados");

  if (usuario) {
    el("perfil-titulo").textContent = usuario.nome;
    el("perfil-email").textContent = usuario.email;
  }

  const favs = LIVROS.filter(function (l) { return favoritos.has(l.id); });
  const emps = LIVROS.filter(function (l) { return reservas.has(l.id); });
  el("conta-favoritos").textContent = favs.length;
  el("conta-emprestados").textContent = emps.length;

  painelFav.innerHTML = favs.length
    ? favs.map(function (l) {
        const status = '<p class="perfil-item-status' + (l.disponivel ? "" : " indisponivel") + '">' + (l.disponivel ? "Disponível" : "Emprestado") + "</p>";
        return itemPerfil(l, status,
          '<button type="button" class="perfil-acao" data-ver="' + l.id + '">Ver livro</button>' +
          '<button type="button" class="perfil-acao perfil-acao-sutil" data-desfavoritar="' + l.id + '">Remover</button>');
      }).join("")
    : '<p class="perfil-vazio">Você ainda não salvou nenhum livro. Toque no marcador de um livro do acervo para guardá-lo aqui.</p>';

  painelEmp.innerHTML = emps.length
    ? emps.map(function (l) {
        const inicio = datas[l.id] ? new Date(datas[l.id]) : null;
        let extra;
        if (!inicio || isNaN(inicio)) {
          extra = '<p class="perfil-item-status">' + (l.disponivel ? "Emprestado a você" : "Na fila de espera") + "</p>";
        } else if (l.disponivel) {
          const fim = new Date(inicio.getTime() + l.emprestimo * 86400000);
          extra = '<p class="perfil-item-status">Retirado em ' + formatarData(inicio) + "</p>" +
                  '<p class="perfil-item-prazo">Devolver até ' + formatarData(fim) + "</p>";
        } else {
          extra = '<p class="perfil-item-status indisponivel">Na fila desde ' + formatarData(inicio) + "</p>";
        }
        return itemPerfil(l, extra,
          '<button type="button" class="perfil-acao" data-ver="' + l.id + '">Ver livro</button>' +
          '<button type="button" class="perfil-acao perfil-acao-sutil" data-devolver="' + l.id + '">' + (l.disponivel ? "Devolver" : "Sair da fila") + "</button>");
      }).join("")
    : '<p class="perfil-vazio">Você não tem livros emprestados no momento. Abra um livro do acervo e escolha "Pegar emprestado".</p>';
}

function abrirAba(nome) {
  document.querySelectorAll(".perfil-aba").forEach(function (b) {
    const ativo = b.dataset.aba === nome;
    b.classList.toggle("ativo", ativo);
    b.setAttribute("aria-selected", ativo);
  });
  el("painel-favoritos").classList.toggle("d-none", nome !== "favoritos");
  el("painel-emprestados").classList.toggle("d-none", nome !== "emprestados");
}

el("modalPerfil").addEventListener("show.bs.modal", function () { renderPerfil(); abrirAba("favoritos"); });
el("modalPerfil").addEventListener("hidden.bs.modal", function () {
  if (verDepois !== null) { const id = verDepois; verDepois = null; abrirLivro(id); }
});
el("modalPerfil").addEventListener("click", async function (e) {
  const aba = e.target.closest("[data-aba]");
  if (aba) { abrirAba(aba.dataset.aba); return; }

  const ver = e.target.closest("[data-ver]");
  if (ver) { verDepois = Number(ver.dataset.ver); janela("modalPerfil").hide(); return; }

  const desfav = e.target.closest("[data-desfavoritar]");
  const dev = e.target.closest("[data-devolver]");
  const alvo = desfav || dev;
  if (!alvo) return;
  alvo.disabled = true;
  const id = Number(desfav ? desfav.dataset.desfavoritar : dev.dataset.devolver);
  const r = await api("DELETE", (desfav ? "/api/favoritos/" : "/api/reservas/") + id);
  if (r.status === 401) { definirUsuario(null); janela("modalPerfil").hide(); return; }
  if (r.ok) {
    if (desfav) favoritos = new Set(r.dados.favoritos);
    else { reservas = new Set(r.dados.reservas); datas = r.dados.datas || {}; }
    marcarFavoritos();
    if (livroAberto !== null) atualizarBotaoReserva();
  } else {
    alvo.disabled = false;
  }
});

function abrirLivro(id) {
  const livro = buscarLivro(id);
  if (!livro) return;
  livroAberto = id;

  const arte = el("detalhe-arte");
  const img  = el("detalhe-capa");
  arte.style.setProperty("--tom", livro.cor);
  arte.style.backgroundImage = livro.capa ? "url('" + encodeURI(livro.capa) + "')" : "none";
  img.style.display = livro.capa ? "" : "none";
  img.onerror = function () { img.style.display = "none"; arte.style.backgroundImage = "none"; };
  img.src = livro.capa || "";
  img.alt = "Capa de " + livro.titulo;

  const status = el("detalhe-status");
  status.textContent = livro.disponivel ? "Disponível para empréstimo" : "Emprestado · reserve para entrar na fila";
  status.classList.toggle("indisponivel", !livro.disponivel);

  el("detalhe-categoria").textContent = livro.categoria;
  el("detalhe-titulo").textContent = livro.titulo;
  el("detalhe-autor").textContent = "por " + livro.autor;
  el("detalhe-ano").textContent = livro.ano;
  el("detalhe-paginas").textContent = livro.paginas + " páginas";
  el("detalhe-dias").textContent = livro.emprestimo + " dias";
  el("detalhe-sinopse").textContent = livro.sinopse;

  const cit = el("detalhe-citacao");
  cit.textContent = livro.citacao ? "\u201C" + livro.citacao + "\u201D" : "";
  cit.classList.toggle("d-none", !livro.citacao);

  el("detalhe-erro").classList.add("d-none");
  atualizarBotaoReserva();
  janela("modalLivro").show();
}

function atualizarBotaoReserva() {
  const botao = el("btn-reservar");
  const reservado = reservas.has(livroAberto);
  const livro = buscarLivro(livroAberto);
  const livre = livro && livro.disponivel;
  el("btn-reservar-texto").textContent = reservado
    ? (livre ? "Devolver este livro" : "Sair da fila")
    : (livre ? "Pegar emprestado" : "Entrar na fila");
  botao.classList.toggle("btn-reservado", reservado);
  botao.classList.toggle("btn-escuro", !reservado);
  botao.disabled = false;
}

function mostrarErroDetalhe(msg) {
  const e = el("detalhe-erro");
  e.textContent = msg;
  e.classList.remove("d-none");
}

el("btn-reservar").addEventListener("click", async function () {
  if (livroAberto === null) return;

  if (!usuario) {
    pendenteLivro = livroAberto;
    abrirLoginDepois = true;
    janela("modalLivro").hide();
    return;
  }

  const botao = el("btn-reservar");
  botao.disabled = true;
  const cancelar = reservas.has(livroAberto);
  const r = cancelar
    ? await api("DELETE", "/api/reservas/" + livroAberto)
    : await api("POST", "/api/reservas", { livroId: livroAberto });

  if (r.status === 401) {
    definirUsuario(null);
    mostrarErroDetalhe("Sua sessão expirou. Entre novamente para continuar.");
  } else if (!r.ok) {
    mostrarErroDetalhe(r.dados.erro || "Não foi possível concluir. Tente de novo.");
  } else {
    reservas = new Set(r.dados.reservas);
    datas = r.dados.datas || {};
    renderPerfil();
    el("detalhe-erro").classList.add("d-none");
  }
  atualizarBotaoReserva();
});

el("modalLivro").addEventListener("hidden.bs.modal", function () {
  if (abrirLoginDepois) { abrirLoginDepois = false; janela("modalLogin").show(); }
  else { livroAberto = null; }
});

let modo = "login";
const formLogin   = el("form-login");
const campoNome   = el("login-nome");
const campoEmail  = el("login-email");
const campoSenha  = el("login-senha");
const erroLogin   = el("login-erro");

function definirModo(novo) {
  modo = novo;
  const cadastro = novo === "cadastro";
  el("loginTitulo").textContent = cadastro ? "Crie sua conta" : "Entre na sua conta";
  el("login-texto").textContent = cadastro
    ? "Cadastre-se para reservar livros e montar suas listas de leitura."
    : "Acompanhe reservas, renovações e suas listas de leitura.";
  el("grupo-nome").classList.toggle("d-none", !cadastro);
  el("dica-senha").classList.toggle("d-none", !cadastro);
  el("link-esqueci").classList.toggle("d-none", cadastro);
  el("login-enviar-texto").textContent = cadastro ? "Criar conta" : "Entrar";
  el("login-rodape-texto").textContent = cadastro ? "Já tem cadastro?" : "Ainda não tem cadastro?";
  el("link-trocar-modo").textContent = cadastro ? "Entrar" : "Criar conta";
  campoSenha.setAttribute("autocomplete", cadastro ? "new-password" : "current-password");
  erroLogin.classList.add("d-none");
}

function mostrarErroLogin(msg) {
  erroLogin.textContent = msg;
  erroLogin.classList.remove("d-none");
}

el("modalLogin").addEventListener("show.bs.modal", function (e) {
  const origem = e.relatedTarget;
  definirModo(origem && origem.dataset && origem.dataset.modo ? origem.dataset.modo : "login");
});
el("modalLogin").addEventListener("shown.bs.modal", function () {
  (modo === "cadastro" ? campoNome : campoEmail).focus();
});
el("modalLogin").addEventListener("hidden.bs.modal", function () {
  formLogin.reset();
  campoSenha.type = "password";
  erroLogin.classList.add("d-none");
  if (pendenteLivro !== null && usuario) abrirLivro(pendenteLivro);
  pendenteLivro = null;
});

el("link-trocar-modo").addEventListener("click", function (e) {
  e.preventDefault();
  definirModo(modo === "login" ? "cadastro" : "login");
});
el("link-esqueci").addEventListener("click", function (e) {
  e.preventDefault();
  mostrarErroLogin("A recuperação de senha ainda não está disponível. Fale com a biblioteca.");
});
el("ver-senha").addEventListener("click", function () {
  const mostrando = campoSenha.type === "text";
  campoSenha.type = mostrando ? "password" : "text";
  this.setAttribute("aria-label", mostrando ? "Mostrar senha" : "Ocultar senha");
});

formLogin.addEventListener("submit", async function (e) {
  e.preventDefault();
  const nome = campoNome.value.trim();
  const email = campoEmail.value.trim();
  const senha = campoSenha.value;

  if (modo === "cadastro" && nome.length < 2) return mostrarErroLogin("Digite seu nome.");
  if (!email || !campoEmail.checkValidity()) return mostrarErroLogin("Digite um e-mail válido, como voce@exemplo.com.");
  if (!senha) return mostrarErroLogin("Digite sua senha.");
  if (modo === "cadastro" && senha.length < 8) return mostrarErroLogin("A senha precisa ter pelo menos 8 caracteres.");

  const botao = el("login-enviar");
  botao.disabled = true;
  const corpo = { email: email, senha: senha, lembrar: el("login-lembrar").checked };
  if (modo === "cadastro") corpo.nome = nome;
  const r = await api("POST", modo === "cadastro" ? "/api/cadastro" : "/api/login", corpo);
  botao.disabled = false;

  if (!r.ok) return mostrarErroLogin(r.dados.erro || "Não foi possível entrar. Tente de novo.");
  definirUsuario(r.dados.usuario, r.dados.reservas, r.dados.favoritos, r.dados.datas);
  janela("modalLogin").hide();
});

function definirUsuario(u, listaReservas, listaFavoritos, mapaDatas) {
  usuario = u;
  reservas = new Set(listaReservas || []);
  favoritos = new Set(listaFavoritos || []);
  datas = mapaDatas || {};
  el("btn-entrar").classList.toggle("d-none", !!u);
  el("usuario-area").classList.toggle("d-none", !u);
  el("btn-criar-conta").classList.toggle("d-none", !!u);
  if (u) {
    const primeiro = u.nome.split(" ")[0];
    el("usuario-nome").textContent = primeiro;
    const inicial = primeiro.charAt(0).toUpperCase();
    el("perfil-avatar").textContent = inicial;
    el("perfil-avatar-grande").textContent = inicial;
  }
  marcarFavoritos();
  if (livroAberto !== null) atualizarBotaoReserva();
}

el("btn-sair").addEventListener("click", async function () {
  await api("POST", "/api/logout");
  definirUsuario(null);
});

api("GET", "/api/me").then(function (r) {
  if (r.ok) definirUsuario(r.dados.usuario, r.dados.reservas, r.dados.favoritos, r.dados.datas);
});

const linksMenu = document.querySelectorAll(".site-header .nav-link");
if ("IntersectionObserver" in window) {
  const observador = new IntersectionObserver(function (entradas) {
    entradas.forEach(function (entrada) {
      if (!entrada.isIntersecting) return;
      linksMenu.forEach(function (link) {
        link.classList.toggle("active", link.getAttribute("href") === "#" + entrada.target.id);
      });
    });
  }, { rootMargin: "-40% 0px -55% 0px" });
  ["inicio", "acervo"].forEach(function (id) { if (el(id)) observador.observe(el(id)); });
}
