'use strict';
(function(){
  // Account server URL. Empty = accounts not deployed yet (page shows "Almost Here").
  var API = 'https://koumakan-accounts.sannyo-arena.workers.dev';
  var TURNSTILE_SITEKEY = '0x4AAAAAAGQJWtcHRR5B_Nx7'; // Cloudflare Turnstile site key (public). Empty = no bot check widget.
  var PRODUCTS = {
    youkai808:  { name: 'Youkai808',   img: '../img/p/youkai808.webp' },
    melodyveil: { name: 'Melody Veil', img: '../img/p/melodyveil.webp' },
    all:        { name: 'All Plugins', img: '../img/koumakan-logo.webp' } // one code unlocks everything
  };
  var $ = function(id){ return document.getElementById(id); };
  var store = { get:function(){ try{return localStorage.getItem('kd_token')}catch(e){return null} },
                set:function(t){ try{ t?localStorage.setItem('kd_token',t):localStorage.removeItem('kd_token') }catch(e){} } };
  function show(v){ ['soon','auth','reset','me'].forEach(function(k){ $('v-'+k).hidden = k!==v; }); }
  function call(path, body){
    var t = store.get(), h = {'Content-Type':'application/json'};
    if (t) h.Authorization = 'Bearer ' + t;
    return fetch(API + path, body ? {method:'POST', headers:h, body:JSON.stringify(body)} : {headers:h})
      .then(function(r){ return r.json().catch(function(){return {}}).then(function(j){ j._status=r.status; return j; }); })
      .catch(function(){ return {_status:0, error:"Can't Reach The Server. Check Your Connection."}; });
  }
  function busy(form, on){ var b=form.querySelector('.btn'); b.disabled=on; }
  function say(id, text, ok){ $(id).textContent = text||''; $(id).className = 'msg' + (ok?' ok':''); }

  var tsId = null;
  function tsToken(){ try { return TURNSTILE_SITEKEY && window.turnstile && tsId !== null ? turnstile.getResponse(tsId) : ''; } catch(e){ return ''; } }
  function tsReset(){ try { if (tsId !== null) turnstile.reset(tsId); } catch(e){} }
  function tsRender(){
    if (!TURNSTILE_SITEKEY || tsId !== null) return;
    if (!window.turnstile) { setTimeout(tsRender, 300); return; }
    tsId = turnstile.render('#ts', { sitekey: TURNSTILE_SITEKEY, theme: 'dark' });
  }
  var hm = location.hash.match(/hub=([A-Z0-9]{4}-[A-Z0-9]{4})/), hubCode = hm && hm[1];
  var om = location.hash.match(/oauth=([0-9a-f]{64})|oautherr=([^&]*)/), oauthTok = om && om[1], oauthErr = om && om[2] && decodeURIComponent(om[2]);
  var lm = location.hash.match(/(reset|verify)=([0-9a-f]{64})/), linkKind = lm && lm[1], linkToken = lm && lm[2];
  var mode = 'login';
  function setMode(m){
    mode = m;
    $('t-login').className = m==='login'?'on':''; $('t-signup').className = m==='signup'?'on':'';
    $('t-login').setAttribute('aria-selected', m==='login'); $('t-signup').setAttribute('aria-selected', m==='signup');
    $('auth-title').textContent = m==='login' ? 'Welcome Back' : 'Make Your Account';
    $('b-auth').textContent = m==='login' ? 'Log In' : 'Create Account';
    $('a-pw').autocomplete = m==='login' ? 'current-password' : 'new-password';
    $('signup-note').hidden = m!=='signup';
    say('m-auth','');
  }
  $('t-login').onclick = function(){ setMode('login'); };
  $('t-signup').onclick = function(){ setMode('signup'); };

  $('f-auth').onsubmit = function(e){
    e.preventDefault();
    var email = $('a-email').value.trim(), pw = $('a-pw').value;
    if (!email || !pw) return say('m-auth','Fill In Both Boxes.');
    if (mode==='signup' && pw.length < 10) return say('m-auth','Password Needs At Least 10 Characters.');
    busy(this,true); var f=this;
    call('/'+mode, {email:email, password:pw, code:$('a-code').value.trim(), turnstile:tsToken()}).then(function(j){
      busy(f,false); tsReset();
      if (j.mfa) { $('code-box').hidden = false; $('a-code').value=''; $('a-code').focus(); }
      if (j.token){ store.set(j.token); $('a-pw').value=''; $('a-code').value=''; $('code-box').hidden=true; loadMe(); } else say('m-auth', j.error || 'Something Went Wrong.');
    });
  };
  $('b-forgot').onclick = function(){
    var email = $('a-email').value.trim();
    if (!email) { $('a-email').focus(); return say('m-auth','Type Your Email Above First, Then Hit Forgot.'); }
    call('/forgot', {email:email, turnstile:tsToken()}).then(function(j){ tsReset();
      if (j._status===200) say('m-auth','If That Email Has An Account, A Reset Link Is On The Way.', true);
      else say('m-auth', j.error || 'Something Went Wrong.');
    });
  };
  $('f-reset').onsubmit = function(e){
    e.preventDefault();
    var f=this; busy(f,true);
    call('/'+linkKind, {token:linkToken, password:$('r-pw').value}).then(function(j){
      busy(f,false);
      if (j.token){ store.set(j.token); loadMe(); } else say('m-reset', j.error || 'Something Went Wrong.');
    });
  };
  $('f-pw').onsubmit = function(e){
    e.preventDefault(); var f=this; busy(f,true);
    call('/password', {current:$('p-cur').value, password:$('p-new').value}).then(function(j){
      busy(f,false);
      if (j.token){ store.set(j.token); f.reset(); say('m-pw','Password Updated.', true); } else say('m-pw', j.error || 'Something Went Wrong.');
    });
  };
  $('b-logout').onclick = function(){ call('/logout',{}).then(function(){ store.set(null); try{localStorage.removeItem('kd_uid');localStorage.removeItem('kd_email');}catch(e){} setMode('login'); show('auth'); }); };

  function loadMe(){
    if (!store.get()) { show('auth'); return; }
    call('/me').then(function(j){
      if (j._status===401) { store.set(null); try{localStorage.removeItem('kd_uid');localStorage.removeItem('kd_email');}catch(e){} show('auth'); return; }
      if (!j.email) { show('auth'); say('m-auth', j.error || 'Something Went Wrong.'); return; }
      $('who').textContent = 'Logged In As ' + j.email;
      $('unverified').hidden = j.verified;
      $('b-resend').hidden = !j.mail;
      try { localStorage.setItem('kd_uid', j.id); localStorage.setItem('kd_email', j.email); } catch(e){}
      var seen = {}, grid = $('owned'); grid.textContent = '';
      (j.purchases||[]).forEach(function(p){
        var info = PRODUCTS[p.product]; if (!info || seen[p.product]) return; seen[p.product]=1;
        var c = document.createElement('div'); c.className='card own';
        var img = document.createElement('img'); img.src=info.img; img.alt=''; img.loading='lazy';
        var b = document.createElement('div'); b.className='body';
        var h = document.createElement('h3'); h.textContent = info.name;
        var d = document.createElement('p'); d.textContent = 'Owned Since ' + new Date(p.created*1000).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
        b.appendChild(h); b.appendChild(d);
        if (p.status !== 'active') { var off=document.createElement('div'); off.className='off'; off.textContent='This Key Was Refunded Or Disabled.'; b.appendChild(off); }
        else {
          var k=document.createElement('div'); k.className='key';
          var code=document.createElement('code'); code.textContent=p.license_key;
          var cp=document.createElement('button'); cp.type='button'; cp.className='btn ghost'; cp.textContent='Copy';
          cp.onclick=function(){ (navigator.clipboard?navigator.clipboard.writeText(p.license_key):Promise.reject()).then(function(){cp.textContent='Copied';},function(){
            var r=document.createRange(); r.selectNodeContents(code); var sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); cp.textContent='Ctrl+C';}); };
          k.appendChild(code); k.appendChild(cp); b.appendChild(k);
          var use=document.createElement('div'); use.className='use';
          var n=document.createElement('span'); n.textContent='Used On '+p.used+' Of '+p.limit+' Computers';
          use.appendChild(n);
          if (p.used > 0) {
            var fr=document.createElement('button'); fr.type='button'; fr.className='link'; fr.textContent='Free Up Computers';
            fr.onclick=function(){
              if (!confirm('Sign This Key Out Of Every Computer? You Can Activate It Again On The Ones You Use.')) return;
              call('/free-computers',{license_key:p.license_key}).then(function(r){ if (r.ok) loadMe(); else n.textContent = r.error || 'Something Went Wrong.'; });
            };
            use.appendChild(fr);
          }
          b.appendChild(use);
        }
        c.appendChild(img); c.appendChild(b); grid.appendChild(c);
      });
      var allCode = (j.purchases||[]).some(function(p){ return p.product==='all' && p.status==='active'; });
      if (j.owner || allCode) Object.keys(PRODUCTS).forEach(function(k){ // owner / All Plugins code owns everything: the Hub unlocks it all when signed in
        if (seen[k] || k==='all') return; var info = PRODUCTS[k];
        var c = document.createElement('div'); c.className='card own';
        var img = document.createElement('img'); img.src=info.img; img.alt=''; img.loading='lazy';
        var b = document.createElement('div'); b.className='body';
        var h = document.createElement('h3'); h.textContent = info.name;
        var d = document.createElement('p'); d.textContent = (j.owner ? 'Unlocked (Owner).' : 'Unlocked By Your All Plugins Code.') + ' Sign In To The Hub With This Account To Use It, No Key Needed.';
        b.appendChild(h); b.appendChild(d); c.appendChild(img); c.appendChild(b); grid.appendChild(c);
      });
      grid.hidden = !grid.children.length; $('none').hidden = !!grid.children.length;
      $('hub-link').hidden = !hubCode; if (hubCode) $('hub-code').textContent = hubCode;
      $('admin').hidden = !j.owner;
      if (j.owner) ownerPanel(j);
      show('me');
    });
  }

  // ---- Owner panel (the server refuses all of this unless the account is the owner AND logged in with 2FA) ----
  var PNAME = {youkai808:'Youkai808', melodyveil:'Melody Veil', all:'All Plugins'};
  function ownerPanel(me){
    $('adm-2fa').hidden = me.mfa; $('adm-main').hidden = !me.mfa;
    if (!me.mfa) {
      if (me.has2fa) { $('adm-2fa').hidden = true; $('adm-main').hidden = false; $('adm-stats').textContent = 'Log Out And Back In With Your 2FA Code To Use This.'; return; }
      call('/admin/2fa/start',{}).then(function(j){
        $('adm-secret').textContent = j.secret || j.error || 'Something Went Wrong.';
        if (j.uri && window.qrcode) { var q = qrcode(0, 'M'); q.addData(j.uri); q.make(); $('adm-qr').innerHTML = q.createSvgTag({cellSize: 4, margin: 0}); } // uri comes from our server, svg is built by the lib
      });
      return;
    }
    adminList('');
  }
  function td(tr, text){ var c=document.createElement('td'); c.textContent=text; tr.appendChild(c); return c; }
  function adminList(q){
    call('/admin/list?q=' + encodeURIComponent(q)).then(function(j){
      if (!j.purchases) { $('adm-stats').textContent = j.error || 'Something Went Wrong.'; return; }
      var s=j.stats, st=$('adm-stats'); st.textContent='';
      [['Accounts',s.users],['Sales',s.sales],['Free Keys',s.comps],['Turned Off',s.disabled]].forEach(function(x){
        var d=document.createElement('span'), b=document.createElement('b'); b.textContent=x[1]; d.appendChild(b); d.appendChild(document.createTextNode(' '+x[0])); st.appendChild(d); });
      var body=$('adm-rows'); body.textContent='';
      j.purchases.forEach(function(p){
        var tr=document.createElement('tr'); if (p.status!=='active') tr.className='dis';
        td(tr,p.email); td(tr,(PNAME[p.product]||p.product)+(p.txn_id.indexOf('comp_')===0?' (Free)':''));
        var kc=td(tr,''), code=document.createElement('code'); code.textContent=p.license_key; kc.appendChild(code);
        td(tr,p.used+'/3'); td(tr,new Date(p.created*1000).toLocaleDateString());
        var bt=document.createElement('button'); bt.type='button'; bt.className='link'; bt.style.margin='0';
        bt.textContent = p.status==='active' ? 'Turn Off' : 'Turn On';
        bt.onclick=function(){
          var on = p.status!=='active';
          if (!on && !confirm('Turn Off ' + p.license_key + '? It Stops Working On Every Computer.')) return;
          call('/admin/status',{license_key:p.license_key, active:on}).then(function(r){ if (r.ok) adminList($('q').value.trim()); else alert(r.error||'Something Went Wrong.'); });
        };
        td(tr,'').appendChild(bt); body.appendChild(tr);
      });
    });
  }
  $('f-2fa').onsubmit = function(e){
    e.preventDefault(); var f=this; busy(f,true);
    call('/admin/2fa/confirm',{code:$('adm-code').value.trim()}).then(function(j){
      busy(f,false);
      if (j.token){ store.set(j.token); loadMe(); } else say('m-2fa', j.error || 'Something Went Wrong.');
    });
  };
  $('f-grant').onsubmit = function(e){
    e.preventDefault(); var f=this; busy(f,true);
    call('/admin/grant',{email:$('g-email').value.trim(), product:$('g-prod').value}).then(function(j){
      busy(f,false);
      if (j.license_key){ say('m-grant','Key Made: ' + j.license_key + ($('g-email').value.trim() ? ' (Shows Up In Their Account Once They Confirm Their Email)' : ' (Send It To Them. Works In The Hub Or Redeem On Here)'), true); $('g-email').value=''; adminList(''); }
      else say('m-grant', j.error || 'Something Went Wrong.');
    });
  };
  $('f-redeem').onsubmit = function(e){
    e.preventDefault(); var f=this; busy(f,true);
    call('/redeem',{code:$('rd-code').value}).then(function(j){
      busy(f,false);
      if (j.ok){ $('rd-code').value=''; loadMe(); say('m-redeem','Added To Your Account.', true); } else say('m-redeem', j.error || 'Something Went Wrong.');
    });
  };
  $('f-find').onsubmit = function(e){ e.preventDefault(); adminList($('q').value.trim()); };

  $('b-hub').onclick = function(){
    var b=this; b.disabled=true;
    call('/hub/approve',{user_code:hubCode}).then(function(j){
      b.disabled=false;
      if (j.ok){ hubCode=null; $('b-hub').hidden=$('b-hub-no').hidden=true; say('m-hub','Connected. Go Back To The Hub.', true); }
      else say('m-hub', j.error || 'Something Went Wrong.');
    });
  };
  $('b-hub-no').onclick = function(){ hubCode=null; $('hub-link').hidden=true; };

  $('b-resend').onclick = function(){
    var b=this; b.disabled=true;
    call('/resend-verify',{}).then(function(j){ b.disabled=false; $('m-verify').textContent = j.ok ? 'Sent. Check Your Inbox (And Spam).' : (j.error || 'Something Went Wrong.'); });
  };

  if (top !== self) { top.location = self.location; return; } // no clickjacking in iframes
  if (!API) { show('soon'); return; }
  tsRender();
  if (hubCode || om) history.replaceState(null,'',location.pathname);
  var PROV = {google:'Google', github:'GitHub', discord:'Discord', microsoft:'Microsoft'};
  call('/oauth/providers').then(function(j){
    var box=$('social-btns'); (j.providers||[]).forEach(function(p){
      var a=document.createElement('a'); a.className='btn ghost'; a.href=API+'/oauth/'+p+'/start'; a.textContent='Continue With '+(PROV[p]||p); box.appendChild(a); });
    $('social').hidden = !box.children.length;
  });
  if (oauthErr) { show('auth'); say('m-auth', oauthErr); return; }
  if (oauthTok) { call('/oauth/finish',{token:oauthTok}).then(function(j){ if (j.token){ store.set(j.token); loadMe(); } else { show('auth'); say('m-auth', j.error||'Something Went Wrong.'); } }); return; }
  if (linkToken) {
    history.replaceState(null,'',location.pathname); // keep the one-time token out of history
    if (linkKind==='verify') { $('reset-title').textContent='Confirm Your Email'; $('reset-sub').textContent='Set Your Password To Finish. This Logs Out Any Other Device On This Account.'; }
    show('reset'); return;
  }
  loadMe();
})();
