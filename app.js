/* ECL_rating — shared runtime (loaded after supabase CDN, before page scripts) */

window.ECL = (function(){

  var SUPABASE_URL =
  "https://qsnncbwoybwkhwyepaai.supabase.co";

  var SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzbm5jYndveWJ3a2h3eWVwYWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2NjUxMjEsImV4cCI6MjEwNjI0MTEyMX0.RWSTvm_FuJq7FDPiYErHgsTOHPmktgnEG2eKMtNc5TE";

  var SKEY = "ecl-session";

  var configured =
    typeof window.supabase !== "undefined" &&
    SUPABASE_URL.indexOf("http") === 0 &&
    SUPABASE_KEY.length > 20;

  var sb = configured
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

  function $(id){
    return document.getElementById(id);
  }

  function esc(s){
    var d = document.createElement("div");
    d.textContent = s == null ? "" : s;
    return d.innerHTML;
  }

  function fmtDate(v){
    if(!v) return "";
    var d = new Date(v);
    if(isNaN(d)) return "";
    return d.toLocaleDateString("pt-PT",{
      day:"2-digit",
      month:"2-digit",
      year:"numeric"
    });
  }

  function fmtDateTime(v){
    if(!v) return "";
    var d = new Date(v);
    if(isNaN(d)) return "";
    return d.toLocaleString("pt-PT",{
      day:"2-digit",
      month:"2-digit",
      year:"numeric",
      hour:"2-digit",
      minute:"2-digit"
    });
  }

  function starsHtml(t){
    var full = Math.round(t);
    return "★★★★★".slice(0,full) + "☆☆☆☆☆".slice(0,5-full);
  }

  function getSession(){
    try{
      var s = JSON.parse(localStorage.getItem(SKEY));
      if(s && s.token && Number(s.exp) * 1000 > Date.now())
        return s;
    }catch(e){}
    return null;
  }

  function saveSession(s){
    localStorage.setItem(SKEY, JSON.stringify(s));
  }

  function endSession(){
    localStorage.removeItem(SKEY);
  }

  var ROLE_LABEL = {
    user:"USER",
    moderator:"MODERATOR",
    admin:"ADMIN",
    owner:"OWNER"
  };

  function badgeHtml(role){
    if(!role)
      return "";
    return '<span class="badge b-' + esc(role) + '">' +
      esc(ROLE_LABEL[role] || String(role).toUpperCase()) +
      '</span>';
  }

  /* Page may assign: ECL.onAuthChange = function(){ ... } */
  var onAuthChange = null;
  var lastNext = null;

  function fireAuthChange(){
    if(onAuthChange)
      onAuthChange();
  }

  function paintAcct(next){

    var el = $("acct");

    if(!el)
      return;

    if(next !== undefined)
      lastNext = next;

    var s = getSession();

    if(s){

      el.innerHTML =
        'Olá, <a href="conta.html"><b>' + esc(s.username) + '</b></a> · ' +
        '<a href="#" id="acctOut">Sair</a>';

      $("acctOut").onclick = function(e){
        e.preventDefault();
        doLogout();
      };

    }else{

      el.innerHTML =
        '<a href="auth.html' +
        (lastNext ? "?next=" + encodeURIComponent(lastNext) : "") +
        '">Entrar</a>';

    }

  }

  function doLogout(){

    var s = getSession();

    if(s && sb){
      sb.rpc("logout",{ p_token:s.token });
    }

    endSession();

    paintAcct();

    fireAuthChange();

  }

  /* transient status message (replaces native alert) */
  function toast(msg, kind){
    var box = $("eclToasts");
    if(!box){
      box = document.createElement("div");
      box.id = "eclToasts";
      document.body.appendChild(box);
    }
    while(box.children.length >= 3)
      box.removeChild(box.firstChild);
    var t = document.createElement("div");
    t.className = "toast" + (kind === "err" ? " err" : "");
    t.setAttribute("role","status");
    t.textContent = msg == null ? "" : String(msg);
    box.appendChild(t);
    setTimeout(function(){
      if(t.parentNode)
        t.parentNode.removeChild(t);
    }, 3400);
  }

  /* promise-based <dialog> confirmation (replaces native confirm) */
  function askConfirm(msg){
    return new Promise(function(resolve){
      var d = document.createElement("dialog");
      d.className = "ecl-dialog";
      d.innerHTML =
        '<p></p>' +
        '<div class="ecl-actions">' +
          '<button type="button" class="logout ecl-no">Cancelar</button>' +
          '<button type="button" class="ecl-ok">Confirmar</button>' +
        '</div>';
      d.querySelector("p").textContent = msg == null ? "" : String(msg);
      function done(v){
        try{ d.close(); }catch(e){}
        if(d.parentNode)
          d.parentNode.removeChild(d);
        resolve(v);
      }
      d.querySelector(".ecl-no").onclick = function(){ done(false); };
      d.querySelector(".ecl-ok").onclick = function(){ done(true); };
      d.addEventListener("cancel",function(e){
        e.preventDefault();
        done(false);
      });
      document.body.appendChild(d);
      d.showModal();
      d.querySelector(".ecl-ok").focus();
    });
  }

  var api = {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_KEY,
    SKEY: SKEY,
    configured: configured,
    sb: sb,
    $: $,
    esc: esc,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    starsHtml: starsHtml,
    getSession: getSession,
    saveSession: saveSession,
    endSession: endSession,
    ROLE_LABEL: ROLE_LABEL,
    badgeHtml: badgeHtml,
    paintAcct: paintAcct,
    doLogout: doLogout,
    fireAuthChange: fireAuthChange,
    toast: toast,
    askConfirm: askConfirm
  };

  Object.defineProperty(api,"onAuthChange",{
    get: function(){ return onAuthChange; },
    set: function(fn){ onAuthChange = fn; }
  });

  if(!configured){
    var w = $("cfgWarn");
    if(w)
      w.classList.remove("hide");
  }

  function initThemeToggle(){

    var stored = null;
    try{
      stored = localStorage.getItem("ecl-theme");
    }catch(e){}

    if(stored === "light" || stored === "dark")
      document.documentElement.setAttribute("data-theme", stored);

    function eff(){
      var a = document.documentElement.getAttribute("data-theme");
      if(a) return a;
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark" : "light";
    }

    function refresh(){

      var cur = eff();

      var sw = document.querySelectorAll("[data-themeswitch]");
      for(var i = 0; i < sw.length; i++){
        var on = sw[i].getAttribute("data-themeswitch") === cur;
        sw[i].setAttribute("aria-pressed", String(on));
        sw[i].classList.toggle("on", on);
      }

    }

    function setTheme(next){
      document.documentElement.setAttribute("data-theme", next);
      try{
        localStorage.setItem("ecl-theme", next);
      }catch(e){}
      refresh();
    }

    document.addEventListener("click", function(e){
      var t = e.target && e.target.closest
        ? e.target.closest("[data-themeswitch]")
        : null;
      if(t)
        setTheme(t.getAttribute("data-themeswitch"));
    });

    refresh();
  }

  initThemeToggle();

  return api;

})();
