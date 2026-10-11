(function () {
  "use strict";
  const cfg = window.CS2_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const $ = (id) => document.getElementById(id);
  const TITRES = { collecte: "Collecte", matchs: "Matchs", analyse: "Analyse", paris: "Paris", reglages: "Réglages" };
  let pageCourante = "collecte";
  let minuteur = null;
  let matchsCache = [];

  /* ---------- petits utilitaires (pas d'innerHTML : tout passe par textContent) ---------- */
  function el(tag, classe, texte) {
    const n = document.createElement(tag);
    if (classe) n.className = classe;
    if (texte !== undefined && texte !== null) n.textContent = texte;
    return n;
  }
  function vider(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function heurePar(dateIso) {
    if (!dateIso) return "—";
    return new Date(dateIso).toLocaleString("fr-FR", {
      timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    });
  }
  function heureSeule(dateIso) {
    if (!dateIso) return "—";
    return new Date(dateIso).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
  }
  function dureeLisible(min) {
    if (min === null || min === undefined) return "jamais";
    min = Math.round(Number(min));
    if (min < 1) return "à l'instant";
    if (min < 60) return min + " min";
    const h = Math.floor(min / 60), m = min % 60;
    if (h < 48) return h + " h" + (m ? " " + String(m).padStart(2, "0") : "");
    return Math.floor(h / 24) + " j";
  }

  /* ---------- connexion ---------- */
  function montrerConnexion() {
    $("vue-app").classList.add("cache");
    $("vue-connexion").classList.remove("cache");
    arreterMinuteur();
  }
  function montrerApp() {
    $("vue-connexion").classList.add("cache");
    $("vue-app").classList.remove("cache");
    aller(pageCourante);
    demarrerMinuteur();
  }

  $("form-connexion").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("msg-connexion").textContent = "";
    const { error } = await sb.auth.signInWithPassword({
      email: $("champ-email").value.trim(),
      password: $("champ-mdp").value
    });
    if (error) { $("msg-connexion").textContent = "Connexion refusée : vérifie l'e-mail et le mot de passe."; return; }
    $("champ-mdp").value = "";
    montrerApp();
  });

  $("btn-deconnexion").addEventListener("click", async () => {
    await sb.auth.signOut();
    montrerConnexion();
  });

  /* ---------- navigation ---------- */
  document.querySelectorAll(".onglets button").forEach((b) =>
    b.addEventListener("click", () => aller(b.dataset.page)));

  function aller(page) {
    pageCourante = page;
    document.querySelectorAll(".page").forEach((p) => p.classList.add("cache"));
    $("page-" + page).classList.remove("cache");
    document.querySelectorAll(".onglets button").forEach((b) =>
      b.classList.toggle("actif", b.dataset.page === page));
    $("titre-page").textContent = TITRES[page];
    rafraichir();
  }

  /* ---------- rafraîchissement ---------- */
  function demarrerMinuteur() {
    arreterMinuteur();
    minuteur = setInterval(() => { if (!document.hidden) rafraichir(); }, cfg.RAFRAICHIR_SECONDES * 1000);
  }
  function arreterMinuteur() { if (minuteur) { clearInterval(minuteur); minuteur = null; } }
  $("btn-rafraichir").addEventListener("click", rafraichir);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("vue-app").classList.contains("cache")) rafraichir(); });

  async function rafraichir() {
    try {
      if (pageCourante === "collecte") await chargerCollecte();
      else if (pageCourante === "matchs") await chargerMatchs();
      $("maj").textContent = "maj " + heureSeule(new Date().toISOString());
    } catch (err) {
      $("maj").textContent = "erreur de lecture";
      console.error(err);
    }
  }

  /* ---------- écran Collecte ---------- */
  const LIBELLES_STATUT = { ok: "OK", en_retard: "En retard", silencieux: "Silencieux", en_veille: "En veille" };

  async function chargerCollecte() {
    const { data, error } = await sb.from("app_etat_collecte").select("*");
    if (error) throw error;
    const liste = $("liste-collecte");
    vider(liste);

    if (!data || data.length === 0) {
      $("bandeau-global").className = "bandeau rouge";
      $("bandeau-global").textContent = "Aucune donnée : ce compte n'est pas reconnu comme propriétaire.";
      return;
    }

    const ordre = ["PS3838 liste", "PS3838 bulletin", "HLTV rounds", "HLTV probabilité", "bo3.gg", "OddsPapi", "Cito (secours)"];
    data.sort((a, b) => ordre.indexOf(a.source) - ordre.indexOf(b.source));

    let nbRouge = 0, nbRetard = 0;
    data.forEach((s) => {
      if (s.statut === "silencieux") nbRouge++;
      if (s.statut === "en_retard") nbRetard++;
      const ligne = el("div", "source");
      ligne.appendChild(el("span", "voyant " + s.statut));
      const bloc = el("div");
      bloc.appendChild(el("div", "nom", s.source));
      bloc.appendChild(el("div", "detail",
        "Dernière donnée : " + (s.derniere ? heurePar(s.derniere) + " (il y a " + dureeLisible(s.retard_min) + ")" : "aucune")));
      ligne.appendChild(bloc);
      ligne.appendChild(el("span", "statut " + s.statut, LIBELLES_STATUT[s.statut] || s.statut));
      liste.appendChild(ligne);
    });

    const b = $("bandeau-global");
    if (nbRouge > 0) { b.className = "bandeau rouge"; b.textContent = nbRouge + " source(s) silencieuse(s)"; }
    else if (nbRetard > 0) { b.className = "bandeau alerte"; b.textContent = nbRetard + " source(s) en retard"; }
    else { b.className = "bandeau ok"; b.textContent = "Toutes les sources sont à jour"; }
  }

  /* ---------- écran Matchs ---------- */
  async function chargerMatchs() {
    const [jour, nonLies] = await Promise.all([
      sb.from("app_matchs_du_jour").select("*").order("start_time", { ascending: true }),
      sb.from("app_matchs_non_lies").select("*").order("start_time", { ascending: false }).limit(60)
    ]);
    if (jour.error) throw jour.error;
    if (nonLies.error) throw nonLies.error;

    matchsCache = jour.data || [];
    const liste = $("liste-matchs");
    vider(liste);
    if (matchsCache.length === 0) {
      liste.appendChild(el("div", "carte discret", "Aucun match aujourd'hui dans PS3838."));
    }
    matchsCache.forEach((m, i) => {
      const bouton = el("button", "match");
      bouton.type = "button";
      bouton.appendChild(el("div", "equipes", (m.team1 || "?") + "  –  " + (m.team2 || "?")));
      const l2 = el("div", "ligne2");
      l2.appendChild(el("span", null, m.league || "ligue inconnue"));
      l2.appendChild(el("span", null, heureSeule(m.start_time)));
      bouton.appendChild(l2);
      bouton.appendChild(badgesLiaison(m));
      bouton.addEventListener("click", () => ouvrirFiche(m));
      liste.appendChild(bouton);
    });

    $("nb-non-lies").textContent = String((nonLies.data || []).length);
    const zone = $("liste-non-lies");
    vider(zone);
    (nonLies.data || []).forEach((m) => {
      const l = el("div", "ligne-non-lie");
      l.appendChild(el("div", null, (m.team1 || "?") + " – " + (m.team2 || "?")));
      l.appendChild(el("div", "discret petit",
        (m.league || "ligue inconnue") + " · " + heurePar(m.start_time) + " · " + libelleCouverture(m.couverture_bo3)));
      zone.appendChild(l);
    });
  }

  function libelleCouverture(c) {
    return ({ hors_couverture: "hors couverture bo3.gg", a_verifier: "à vérifier", trou_a_corriger: "trou à corriger", liee: "liée", inconnue: "non évalué" })[c] || c || "non évalué";
  }

  function badgesLiaison(m) {
    const b = el("div", "badges");
    b.appendChild(el("span", "badge " + (m.lie_bo3 ? "ok" : "non"), m.lie_bo3 ? "bo3.gg lié" : "bo3.gg non lié"));
    b.appendChild(el("span", "badge " + (m.lie_hltv ? "ok" : "non"), m.lie_hltv ? "HLTV lié" : "HLTV non lié"));
    return b;
  }

  /* ---------- fiche d'un match ---------- */
  function ouvrirFiche(m) {
    $("fiche-titre").textContent = (m.team1 || "?") + " – " + (m.team2 || "?");
    $("fiche-sous").textContent = (m.league || "ligue inconnue") + " · " + heurePar(m.start_time);
    const zone = $("fiche-badges");
    vider(zone);
    zone.appendChild(badgesLiaison(m));
    if (!m.lie_bo3) zone.appendChild(el("p", "discret petit", "Couverture bo3.gg : " + libelleCouverture(m.couverture_bo3)));
    $("fiche").classList.remove("cache");
  }
  $("fiche-fermer").addEventListener("click", () => $("fiche").classList.add("cache"));
  $("fiche").addEventListener("click", (e) => { if (e.target === $("fiche")) $("fiche").classList.add("cache"); });

  /* ---------- démarrage ---------- */
  (async function init() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) montrerApp(); else montrerConnexion();
    sb.auth.onAuthStateChange((evenement) => { if (evenement === "SIGNED_OUT") montrerConnexion(); });
  })();
})();
