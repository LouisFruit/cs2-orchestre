(function () {
  "use strict";
  const cfg = window.CS2_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const $ = (id) => document.getElementById(id);
  const TITRES = { collecte: "Collecte", direct: "En direct", matchs: "Matchs", analyse: "Analyse", paris: "Paris", reglages: "Réglages", alertes: "Alertes", notif: "Réglage des alertes" };
  let pageCourante = "collecte";
  let minuteur = null;
  let matchsCache = [];
  let derniereMaj = 0;
  let directCache = null;
  let ficheDirectId = null;

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
    if (location.hash === "#alertes") pageCourante = "alertes";
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
    minuteur = setInterval(() => {
      if (document.hidden) return;
      if ((pageCourante === "matchs" && aDuDirect()) || Date.now() - derniereMaj >= cfg.RAFRAICHIR_SECONDES * 1000 - 500) rafraichir();
    }, 10000);
  }
  function arreterMinuteur() { if (minuteur) { clearInterval(minuteur); minuteur = null; } }
  $("btn-rafraichir").addEventListener("click", rafraichir);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("vue-app").classList.contains("cache")) rafraichir(); });

  async function rafraichir() {
    try {
      derniereMaj = Date.now();
      majPastille();
      if (pageCourante === "collecte") await chargerCollecte();
      else if (pageCourante === "matchs") await chargerMatchs();
      else if (pageCourante === "reglages") await chargerReglages();
      else if (pageCourante === "alertes") await chargerAlertes();
      else if (pageCourante === "notif") await chargerReglageNotif();
      $("maj").textContent = "maj " + heureSeule(new Date().toISOString());
    } catch (err) {
      $("maj").textContent = "erreur de lecture";
      console.error(err);
    }
  }

  /* ---------- écran Collecte ---------- */
  // Noms affichés des trois sources (la base garde ses noms internes)
  const NOMS_SOURCES = { "HLTV (direct)": "HLTV", "bo3.gg": "BO3GG", "OddsPapi": "ODDSPAPI" };
  const ROLES_SOURCES = {
    "HLTV (direct)": "Le déroulé du match en direct : rounds, kills, bombe.",
    "bo3.gg": "Les matchs en différé : résultats, cartes, rounds, stats des joueurs.",
    "OddsPapi": "Les cotes en différé : historique des prix, récupéré après le match."
  };
  function nomSource(n) { return NOMS_SOURCES[n] || n; }
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

    const ordre = ["HLTV (direct)", "bo3.gg", "OddsPapi"];
    data.sort((a, b) => ordre.indexOf(a.source) - ordre.indexOf(b.source));

    let nbRouge = 0, nbRetard = 0;
    data.forEach((s) => {
      if (s.statut === "silencieux") nbRouge++;
      if (s.statut === "en_retard") nbRetard++;
      const ligne = el("div", "source cliquable");
      ligne.setAttribute("role", "button");
      ligne.tabIndex = 0;
      ligne.addEventListener("click", () => ouvrirSource(s));
      ligne.appendChild(el("span", "voyant " + s.statut));
      const bloc = el("div");
      bloc.appendChild(el("div", "nom", nomSource(s.source)));
      if (ROLES_SOURCES[s.source]) bloc.appendChild(el("div", "role-source", ROLES_SOURCES[s.source]));
      bloc.appendChild(el("div", "detail",
        "Dernière donnée : " + (s.derniere ? heurePar(s.derniere) + " (il y a " + dureeLisible(s.retard_min) + ")" : "aucune")));
      if (s.seuil_min !== null && s.seuil_min !== undefined)
        bloc.appendChild(el("div", "detail", "Seuil : " + dureeLisible(s.seuil_min) + (s.seuil_nuit_min ? " (" + dureeLisible(s.seuil_nuit_min) + " la nuit)" : "")));
      ligne.appendChild(bloc);
      ligne.appendChild(el("span", "statut " + s.statut, LIBELLES_STATUT[s.statut] || s.statut));
      ligne.appendChild(el("span", "fleche", "›"));
      liste.appendChild(ligne);
    });

    const b = $("bandeau-global");
    if (nbRouge > 0) { b.className = "bandeau rouge"; b.textContent = nbRouge + " source(s) silencieuse(s)"; }
    else if (nbRetard > 0) { b.className = "bandeau alerte"; b.textContent = nbRetard + " source(s) en retard"; }
    else { b.className = "bandeau ok"; b.textContent = "Toutes les sources sont à jour"; }
  }

  /* ---------- détail d'une source : tout ce qu'elle collecte ---------- */
  function nombre(n) { return n === null || n === undefined ? "—" : Number(n).toLocaleString("fr-FR"); }

  async function ouvrirSource(src) {
    ficheDirectId = null;
    $("fiche-titre").textContent = nomSource(src.source);
    $("fiche-sous").textContent = ROLES_SOURCES[src.source] || "Ce que cette source collecte";
    vider($("fiche-badges"));
    const zone = $("fiche-detail");
    vider(zone);
    zone.appendChild(el("p", "discret petit", "Chargement…"));
    $("fiche").classList.remove("cache");
    try {
      const [d, l] = await Promise.all([
        sb.from("app_source_detail").select("*").eq("source", src.source).order("ordre", { ascending: true }),
        sb.from("app_source_derniers").select("*").eq("source", src.source).order("t", { ascending: false })
      ]);
      if (d.error) throw d.error;
      if (l.error) throw l.error;
      vider(zone);
      const etat = el("div", "carte");
      etat.appendChild(el("span", "statut " + src.statut, LIBELLES_STATUT[src.statut] || src.statut));
      etat.appendChild(el("p", "discret petit", "Dernière donnée : " + (src.derniere ? heurePar(src.derniere) + " (il y a " + dureeLisible(src.retard_min) + ")" : "aucune")));
      zone.appendChild(etat);
      (d.data || []).forEach((f) => {
        const c = el("div", "carte");
        c.appendChild(el("strong", null, f.famille));
        c.appendChild(el("p", "discret petit", f.description));
        let t = "Total : " + nombre(f.total);
        if (f.dernieres_24h !== null && f.dernieres_24h !== undefined) t += " · 24 h : " + nombre(f.dernieres_24h);
        c.appendChild(el("p", "petit", t));
        if (f.derniere) c.appendChild(el("p", "discret petit", "Dernier ajout : " + heurePar(f.derniere)));
        zone.appendChild(c);
      });
      const liste = el("div", "carte");
      liste.appendChild(el("strong", null, "Derniers éléments reçus"));
      if (!(l.data || []).length) liste.appendChild(el("p", "discret petit", "Rien pour le moment."));
      (l.data || []).forEach((x) => {
        liste.appendChild(el("p", "petit", x.libelle));
        liste.appendChild(el("p", "discret petit", (x.detail ? x.detail + " · " : "") + heurePar(x.t)));
      });
      zone.appendChild(liste);
    } catch (err) {
      vider(zone);
      zone.appendChild(el("p", "erreur", "Lecture impossible : " + (err.message || err)));
    }
  }

  /* ---------- écran Matchs ---------- */
  const SOURCES_STATUT = { bo3: "BO3GG", hltv: "HLTV", oddspapi: "ODDSPAPI", heure: "l'heure de début" };
  const LIBELLES_MATCH = { en_cours: "en cours", a_venir: "à venir", termine: "terminé", inconnu: "inconnu" };
  const GROUPES = [
    { cle: "en_cours", titre: "En cours", ouvert: true },
    { cle: "a_venir", titre: "À venir", ouvert: true },
    { cle: "inconnu", titre: "Statut inconnu", ouvert: true },
    { cle: "termine", titre: "Terminés", ouvert: false }
  ];

  function jourParis(dateIso) {
    return new Date(dateIso).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ
  }
  function ecartJours(dateIso) {
    const a = jourParis(dateIso).split("-").map(Number);
    const b = jourParis(new Date().toISOString()).split("-").map(Number);
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
  }
  function heureAvecJour(dateIso) {
    if (!dateIso) return "—";
    const e = ecartJours(dateIso), h = heureSeule(dateIso);
    if (e === 0) return h;
    if (e === -1) return "hier " + h;
    if (e === 1) return "demain " + h;
    return new Date(dateIso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit" }) + " " + h;
  }

  // Rang d'un match pour le regroupement : direct / a_venir / termine / inconnu
  function categorieMatch(m, lm) {
    const etat = lm ? etatSerie(lm) : (m.statut_match === "en_cours" ? "en_jeu" : "inactif");
    if (etat === "en_jeu" || etat === "entre_cartes") return "direct";
    if (etat === "termine") return "termine";
    const st = m.statut_match || "inconnu";
    if (st === "en_cours") return "direct";
    return st; // a_venir | termine | inconnu
  }
  function liveDe(m) {
    if (!directCache || !m.hltv_match_id) return null;
    return (directCache.matchs || []).find((x) => x.hltv_match_id === m.hltv_match_id) || null;
  }
  function aDuDirect() {
    return !!(directCache && (directCache.matchs || []).some((x) => { const e = etatSerie(x); return e === "en_jeu" || e === "entre_cartes"; }));
  }

  async function chargerMatchs() {
    const [jour] = await Promise.all([
      sb.from("app_matchs").select("*").order("start_time", { ascending: true }),
      chargerDonneesDirect()
    ]);
    if (jour.error) throw jour.error;

    matchsCache = jour.data || [];
    const liste = $("liste-matchs");
    vider(liste);
    if (matchsCache.length === 0) {
      liste.appendChild(el("div", "carte discret", "Aucun match entre hier et après-demain."));
    }

    const groupes = { direct: [], a_venir: [], termine: [], inconnu: [] };
    matchsCache.forEach((m) => {
      const lm = liveDe(m);
      const cat = categorieMatch(m, lm);
      (groupes[cat] || groupes.inconnu).push({ m, lm });
    });
    groupes.direct.sort((x, y) => String((y.lm && y.lm.dernier_round_le) || "").localeCompare(String((x.lm && x.lm.dernier_round_le) || "")));
    groupes.termine.reverse(); // les plus récents d'abord

    // 1. En direct (toujours affiché)
    liste.appendChild(el("h3", "groupe-titre", "En direct (" + groupes.direct.length + ")"));
    if (!groupes.direct.length) liste.appendChild(el("p", "discret petit", "Aucun match en direct pour le moment."));
    groupes.direct.forEach(({ m, lm }) => liste.appendChild(lm ? carteDirect(lm) : carteMatch(m)));

    // 2. À venir
    if (groupes.a_venir.length) {
      liste.appendChild(el("h3", "groupe-titre", "À venir (" + groupes.a_venir.length + ")"));
      groupes.a_venir.forEach(({ m }) => liste.appendChild(carteMatch(m)));
    }
    // 3. Terminés (repliés)
    if (groupes.termine.length) {
      const d = el("details", "carte");
      d.appendChild(el("summary", null, "Terminés (" + groupes.termine.length + ")"));
      groupes.termine.forEach(({ m }) => d.appendChild(carteMatch(m)));
      liste.appendChild(d);
    }
    // 4. Sans confirmation (repliés)
    if (groupes.inconnu.length) {
      const d = el("details", "carte");
      d.appendChild(el("summary", null, "Sans confirmation (" + groupes.inconnu.length + ")"));
      d.appendChild(el("p", "discret petit", "Heure de début passée, mais aucune source ne confirme que le match a eu lieu (pas de rounds HLTV, pas de résultat BO3GG ni ODDSPAPI)."));
      groupes.inconnu.forEach(({ m }) => d.appendChild(carteMatch(m)));
      liste.appendChild(d);
    }
  }

  function carteMatch(m) {
    const bouton = el("button", "match");
    bouton.type = "button";
    bouton.appendChild(el("div", "equipes", (m.team1 || "?") + "  –  " + (m.team2 || "?")));
    const l2 = el("div", "ligne2");
    l2.appendChild(el("span", null, m.league || "ligue inconnue"));
    l2.appendChild(el("span", null, heureAvecJour(m.start_time)));
    bouton.appendChild(l2);
    bouton.appendChild(badgesLiaison(m));
    bouton.addEventListener("click", () => ouvrirFiche(m));
    return bouton;
  }

  function badgesLiaison(m) {
    const b = el("div", "badges");
    if (m.statut_match === "en_cours") b.appendChild(el("span", "badge live", "● En cours"));
    if (m.tier) b.appendChild(el("span", "badge", "Tier " + String(m.tier).toUpperCase()));
    b.appendChild(el("span", "badge " + (m.lie_bo3 ? "ok" : "non"), m.lie_bo3 ? "BO3GG" : "BO3GG : non"));
    b.appendChild(el("span", "badge " + (m.lie_hltv ? "ok" : "non"), m.lie_hltv ? "HLTV" : "HLTV : non"));
    b.appendChild(el("span", "badge " + (m.lie_oddspapi ? "ok" : "non"), m.lie_oddspapi ? "ODDSPAPI" : "ODDSPAPI : non"));
    return b;
  }


  /* ---------- écran En direct ---------- */
  function classeFraicheur(sec, vert, orange) {
    if (sec === null || sec === undefined) return "silencieux";
    return sec <= vert ? "ok" : (sec <= orange ? "en_retard" : "silencieux");
  }
  function ageLisible(sec) {
    if (sec === null || sec === undefined) return "—";
    sec = Math.round(Number(sec));
    if (sec < 60) return sec + " s";
    return dureeLisible(sec / 60);
  }
  function nomPeriode(p) { return Number(p) === 0 ? "Match" : "Carte " + p; }
  function pct(x) { return x === null || x === undefined ? "—" : Number(x).toFixed(1) + " %"; }
  const TYPES_VICTOIRE = { Terrorists_Win: "élimination des CT", CTs_Win: "élimination des T", Target_Bombed: "bombe explosée", Bomb_Defused: "bombe désamorcée", Target_Saved: "temps écoulé" };
  // Pool actuel de 7 cartes (vérifié sur les vetos récents). À mettre à jour si HLTV change de pool.
  const POOL_CARTES = ["Ancient", "Anubis", "Cache", "Dust2", "Inferno", "Mirage", "Nuke"];
  const VERBES_VETO = { removed: "a banni", picked: "a choisi" };
  const ACTION_RESTANTE = "left_over";

  async function chargerDonneesDirect() {
    const res = await sb.from("app_direct_match").select("*");
    if (res.error) throw res.error;
    const matchs = res.data || [];
    let rounds = [], vetos = [], series = [];
    if (matchs.length) {
      const [r, v, se] = await Promise.all([
        sb.from("app_direct_rounds").select("*").order("t", { ascending: true }),
        sb.from("app_direct_veto").select("*"),
        sb.from("app_live_serie").select("*")
      ]);
      if (r.error) throw r.error; if (v.error) throw v.error; if (se.error) throw se.error;
      rounds = r.data || []; vetos = v.data || []; series = se.data || [];
    }
    directCache = { matchs, rounds, vetos, series };
    if (ficheDirectId !== null && !$("fiche").classList.contains("cache")) {
      const m = matchs.find((x) => x.maitre_id === ficheDirectId);
      if (m) remplirDetailDirect(m);
    }
  }

  function serieDe(m) { return (directCache.series || []).find((x) => x.hltv_match_id === m.hltv_match_id) || null; }
  // État réel du match : jeu en cours / entre deux cartes / terminé
  function etatSerie(m) {
    const se = serieDe(m);
    if (se && se.serie_terminee) return "termine";
    const recent = m.age_round_s !== null && m.age_round_s !== undefined && m.age_round_s < 1800;
    if (se && se.entre_cartes && recent) return "entre_cartes";
    if (recent) return "en_jeu";
    return "inactif";
  }
  function scoreCartes(m) {
    const se = serieDe(m);
    if (!se) return null;
    const noms = [];
    [m.ct_team, m.t_team].concat(Object.keys(se.victoires || {})).forEach((n) => { if (n && noms.indexOf(n) === -1) noms.push(n); });
    noms.sort((a, b) => a.localeCompare(b));
    if (!noms.length) return null;
    return noms.map((n) => n + " " + ((se.victoires || {})[n] || 0)).join(" – ");
  }

  function carteDirect(m) {
    const b = el("button", "match");
    b.type = "button";
    const haut = el("div", "ligne2");
    haut.appendChild(el("span", "equipes", (m.team1 || "?") + "  –  " + (m.team2 || "?")));
    const etat = etatSerie(m);
    if (etat === "en_jeu") haut.appendChild(el("span", "badge live", "● En jeu"));
    else if (etat === "entre_cartes") haut.appendChild(el("span", "badge pause", "⏸ Entre deux cartes"));
    else if (etat === "termine") haut.appendChild(el("span", "badge", "Terminé"));
    b.appendChild(haut);
    if (m.dernier_round_fini !== null && m.dernier_round_fini !== undefined) {
      const sc = el("div", "score-live");
      sc.appendChild(el("span", "cote-equipe", (m.ct_team || "?") + " (CT)"));
      sc.appendChild(el("span", "gros-score", m.score_ct + " – " + m.score_t));
      sc.appendChild(el("span", "cote-equipe", (m.t_team || "?") + " (T)"));
      b.appendChild(sc);
      const se = serieDe(m);
      let infos = (m.carte || "carte ?") + " · carte " + m.carte_no + " · round " + m.dernier_round_fini + " terminé";
      if (etat === "entre_cartes") infos = "Carte " + m.carte_no + " terminée" + (se && se.prochaine_carte ? " · prochaine : " + se.prochaine_carte : "");
      else if (etat === "termine") infos = "Série terminée · dernière carte : " + (m.carte || "?");
      b.appendChild(el("div", "discret petit centre", infos));
      const sc2 = scoreCartes(m);
      if (sc2) b.appendChild(el("div", "discret petit centre", "Cartes gagnées : " + sc2 + (se && se.bo ? "  (BO" + se.bo + ")" : "")));
    } else {
      b.appendChild(el("div", "discret petit", "Pas encore de round lu."));
    }
    const f = el("div", "fraicheur");
    f.appendChild(el("span", "voyant " + classeFraicheur(m.age_round_s, 90, 300)));
    f.appendChild(el("span", "discret petit", "dernier round il y a " + ageLisible(m.age_round_s) + " (HLTV a 35–60 s de retard)"));
    b.appendChild(f);
    b.addEventListener("click", () => ouvrirDirect(m));
    return b;
  }

  function ouvrirDirect(m) {
    ficheDirectId = m.maitre_id;
    $("fiche-titre").textContent = (m.team1 || "?") + " – " + (m.team2 || "?");
    $("fiche-sous").textContent = "En direct · données HLTV";
    vider($("fiche-badges"));
    remplirDetailDirect(m);
    $("fiche").classList.remove("cache");
  }

  function remplirDetailDirect(m) {
    const zone = $("fiche-detail");
    vider(zone);
    const rounds = directCache.rounds.filter((r) => r.hltv_match_id === m.hltv_match_id);
        const veto = directCache.vetos.find((v) => v.hltv_match_id === m.hltv_match_id);

    // Score
    const sc = el("div", "carte");
    sc.appendChild(el("strong", null, "Score"));
    if (m.dernier_round_fini !== null && m.dernier_round_fini !== undefined) {
      sc.appendChild(el("p", null, (m.ct_team || "?") + " (CT) " + m.score_ct + " – " + m.score_t + " " + (m.t_team || "?") + " (T)"));
      sc.appendChild(el("p", "discret petit", (m.carte || "carte ?") + " · carte " + m.carte_no + " · round " + m.dernier_round_fini + " terminé à " + heureSeule(m.dernier_round_le)));
    } else sc.appendChild(el("p", "discret petit", "Pas encore de round lu."));
    const se = serieDe(m);
    const etat = etatSerie(m);
    const libEtat = { en_jeu: "En jeu", entre_cartes: "Entre deux cartes", termine: "Série terminée", inactif: "Aucune activité récente" }[etat];
    sc.appendChild(el("p", null, "Statut : " + libEtat + (se && se.bo ? " · BO" + se.bo : "")));
    const scc = scoreCartes(m);
    if (scc) sc.appendChild(el("p", "discret petit", "Cartes gagnées : " + scc));
    if (etat === "entre_cartes" && se && se.prochaine_carte) sc.appendChild(el("p", "petit", "Prochaine carte : " + se.prochaine_carte));
    zone.appendChild(sc);

    // Frise des rounds (une ligne par carte)
    const fr = el("div", "carte");
    fr.appendChild(el("strong", null, "Rounds"));
    const cartes = {};
    rounds.forEach((r) => { (cartes[r.carte_no] = cartes[r.carte_no] || []).push(r); });
    const nums = Object.keys(cartes).sort((a, b) => a - b);
    if (!nums.length) fr.appendChild(el("p", "discret petit", "Aucun round enregistré."));
    nums.forEach((n) => {
      const liste = cartes[n];
      fr.appendChild(el("p", "discret petit", "Carte " + n + " · " + (liste[0].carte || "?")));
      const f = el("div", "frise");
      liste.forEach((r) => {
        const c = el("span", "round " + (r.winner_side === "CT" || r.winner_side === "ct" ? "ct" : "t"), r.pistol ? "P" : "");
        f.appendChild(c);
      });
      fr.appendChild(f);
    });
    fr.appendChild(el("p", "discret petit", "Bleu = victoire CT, orange = victoire T, P = pistol round."));
    const derniers = rounds.slice(-5).reverse();
    derniers.forEach((r) => {
      let t = "Carte " + r.carte_no + " · R" + r.round_no + " · " + (r.winner_team || "?") + " (" + (r.winner_side === "CT" ? "CT" : (r.winner_side ? "T" : "?")) + ")";
      if (r.win_type) t += " · " + (TYPES_VICTOIRE[r.win_type] || r.win_type);
      if (r.bomb_site) t += " · site " + r.bomb_site;
      fr.appendChild(el("p", "petit", t));
    });
    zone.appendChild(fr);

    // Cotes : OddsPapi n'a pas de direct, l'historique arrive après le match
    const co = el("div", "carte");
    co.appendChild(el("strong", null, "Cotes"));
    co.appendChild(el("p", "discret petit", "Pas de cotes en direct : l'historique des cotes (ODDSPAPI) est récupéré après la fin du match."));
    zone.appendChild(co);

    // Picks et bans
    const vt = el("div", "carte");
    vt.appendChild(el("strong", null, "Picks et bans"));
    const liste = veto && Array.isArray(veto.veto) ? veto.veto.slice().sort((a, b) => a.n - b.n) : [];
    if (!liste.length) vt.appendChild(el("p", "discret petit", "Pas encore de veto lu sur HLTV."));
    liste.forEach((v) => {
      if (v.action === ACTION_RESTANTE) vt.appendChild(el("p", "petit", v.n + ". " + (v.carte || "?") + " : carte restante (décisive)"));
      else vt.appendChild(el("p", "petit", v.n + ". " + (v.equipe || "?") + " " + (VERBES_VETO[v.action] || v.action || "") + " " + (v.carte || "?")));
    });
    // Carte restante = décisive (déduite : pool de 7 moins les 6 cartes du veto)
    if (liste.length === 6 && !liste.some((v) => v.action === ACTION_RESTANTE)) {
      const vues = liste.map((v) => String(v.carte || "").toLowerCase());
      const reste = POOL_CARTES.filter((c) => vues.indexOf(c.toLowerCase()) === -1);
      const toutesConnues = vues.every((c) => POOL_CARTES.some((p) => p.toLowerCase() === c));
      if (reste.length === 1 && toutesConnues) {
        vt.appendChild(el("p", "petit", "7. " + reste[0] + " : carte restante (décisive), déduite faute de lecture HLTV"));
      }
    }
    zone.appendChild(vt);
  }



  /* ---------- Alertes (cloche + page) ---------- */
  const NIVEAUX = { critique: "Critique", important: "Important", info: "Info" };
  let filtreAlertes = "tous";
  let alertesCache = [];

  async function majPastille() {
    try {
      const r = await sb.from("app_notifications").select("niveau").is("lu_le", null).limit(200);
      if (r.error) return;
      const pannes = (r.data || []).filter((x) => x.niveau !== "info");
      const n = pannes.length;
      const p = $("pastille-alertes");
      p.textContent = n >= 100 ? "99+" : String(n);
      p.classList.toggle("cache", n === 0);
      p.classList.toggle("critique", pannes.some((x) => x.niveau === "critique"));
    } catch (e) { /* la cloche est facultative */ }
  }

  $("btn-alertes").addEventListener("click", () => aller("alertes"));

  async function chargerAlertes() {
    const r = await sb.from("app_notifications").select("*").order("t", { ascending: false }).limit(100);
    if (r.error) throw r.error;
    alertesCache = r.data || [];
    dessinerAlertes();
  }

  function dessinerAlertes() {
    // filtres
    const f = $("filtres-alertes");
    vider(f);
    const nbInfos = alertesCache.filter((a) => a.niveau === "info" && !a.lu_le).length;
    [["tous", "Pannes"], ["critique", "Critiques"], ["important", "Importantes"], ["info", "Infos" + (nbInfos ? " (" + nbInfos + ")" : "")]].forEach(([id, nom]) => {
      const b = el("button", "filtre" + (filtreAlertes === id ? " actif" : ""), nom);
      b.type = "button";
      b.addEventListener("click", () => { filtreAlertes = id; dessinerAlertes(); });
      f.appendChild(b);
    });
    // liste
    const zone = $("liste-alertes");
    vider(zone);
    const liste = alertesCache.filter((a) => filtreAlertes === "tous" ? a.niveau !== "info" : a.niveau === filtreAlertes);
    if (!liste.length) {
      zone.appendChild(el("p", "discret", alertesCache.length ? "Aucune alerte dans ce filtre." : "Aucune alerte pour le moment."));
      return;
    }
    liste.forEach((a) => {
      const carte = el("button", "alerte niv-" + a.niveau + (a.lu_le ? "" : " nonlue") + (a.resolu_le ? " resolue" : ""));
      carte.type = "button";
      const t = el("div", "alerte-titre");
      if (!a.lu_le) t.appendChild(el("span", "point-nonlu"));
      t.appendChild(document.createTextNode(a.titre));
      carte.appendChild(t);
      if (a.corps) carte.appendChild(el("div", "alerte-corps", a.corps));
      const m = el("div", "alerte-meta");
      m.appendChild(el("span", null, heureAvecJour(a.t) + (a.source ? " · " + a.source : "")));
      carte.appendChild(m);
      const b = el("div", "badges");
      b.appendChild(el("span", "badge niv-" + a.niveau, NIVEAUX[a.niveau] || a.niveau));
      if (a.resolu_le) b.appendChild(el("span", "badge ok", "résolue à " + heureSeule(a.resolu_le)));
      if (a.repetitions > 0) b.appendChild(el("span", "badge", "répétée " + a.repetitions + " fois"));
      carte.appendChild(b);
      carte.addEventListener("click", async () => {
        if (a.lu_le) return;
        const r = await sb.from("app_notifications").update({ lu_le: new Date().toISOString() }).eq("id", a.id);
        if (!r.error) { await chargerAlertes(); majPastille(); }
      });
      zone.appendChild(carte);
    });
  }

  $("btn-tout-lu").addEventListener("click", async () => {
    const r = await sb.from("app_notifications").update({ lu_le: new Date().toISOString() }).is("lu_le", null);
    if (!r.error) { await chargerAlertes(); majPastille(); }
  });



  /* ---------- Réglage des notifications ---------- */
  const GROUPES_NOTIF = [["critique", "Critiques"], ["important", "Importantes"], ["info", "Infos"]];
  const MODES_NOTIF = [["auto", "Auto"], ["push", "Push"], ["lecture", "Lecture"]];
  let reglageNotifCache = [];
  // Alertes de sources abandonnées (PS3838 fermé le 14/10) : on ne les affiche plus
  const FAMILLES_MORTES = /^(ps3838_|lecteur_|bulletin_)/;

  $("btn-reglage-notif").addEventListener("click", () => aller("notif"));
  $("btn-notif-retour").addEventListener("click", () => aller("alertes"));

  function enPush(r) {
    if (r.protege) return true;
    if (r.mode === "push") return true;
    if (r.mode === "lecture") return false;
    return r.niveau_defaut === "critique" || r.niveau_defaut === "important"; // auto
  }

  async function chargerReglageNotif() {
    const r = await sb.from("notif_reglages").select("*").order("libelle", { ascending: true });
    if (r.error) throw r.error;
    reglageNotifCache = (r.data || []).filter((x) => !FAMILLES_MORTES.test(x.famille));
    dessinerReglageNotif();
  }

  function dessinerReglageNotif() {
    const zone = $("liste-notif");
    vider(zone);
    GROUPES_NOTIF.forEach(([niveau, titre]) => {
      const lignes = reglageNotifCache.filter((x) => x.niveau_defaut === niveau);
      if (!lignes.length) return;
      zone.appendChild(el("h3", "groupe-titre", titre + " (" + lignes.length + ")"));
      lignes.forEach((x) => zone.appendChild(ligneNotif(x)));
    });
    if (!reglageNotifCache.length) zone.appendChild(el("p", "discret", "Aucun type d'alerte enregistré."));
  }

  function ligneNotif(x) {
    const carte = el("div", "carte reglage-notif");
    carte.appendChild(el("div", "nom-notif", x.libelle || x.famille));
    const push = enPush(x);
    carte.appendChild(el("div", "etat-notif " + (push ? "push" : "lecture"),
      push ? "🔔 En push sur l'iPhone" : "📋 Dans la liste seulement"));
    if (x.protege) {
      const l = el("label", "verrou");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = true; cb.disabled = true;
      l.appendChild(cb);
      l.appendChild(el("span", null, "🔒 Toujours en push (alerte de panne)"));
      carte.appendChild(l);
      return carte;
    }
    const seg = el("div", "segment");
    MODES_NOTIF.forEach(([id, nom]) => {
      const b = el("button", id === x.mode ? "actif" : "", nom);
      b.type = "button";
      b.addEventListener("click", () => changerModeNotif(x, id));
      seg.appendChild(b);
    });
    carte.appendChild(seg);
    return carte;
  }

  async function changerModeNotif(x, mode) {
    if (x.protege || x.mode === mode) return;
    const msg = $("msg-notif");
    msg.textContent = "";
    const r = await sb.from("notif_reglages").update({ mode: mode, maj_le: new Date().toISOString() }).eq("famille", x.famille);
    if (r.error) { msg.textContent = "Échec de l'enregistrement : " + r.error.message; return; }
    try { await chargerReglageNotif(); } catch (e) { msg.textContent = "Enregistré, mais impossible de relire la liste."; }
  }

  /* ---------- Notifications push (cet appareil) ---------- */
  function pushPris() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
  function iosNonInstallee() {
    return /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone &&
      !(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }
  function cleVersOctets(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const brut = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(brut.length);
    for (let i = 0; i < brut.length; i++) out[i] = brut.charCodeAt(i);
    return out;
  }
  async function monAbonnement() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function majEtatPush() {
    const texte = $("texte-push");
    const bA = $("btn-push-activer"), bT = $("btn-push-test"), bD = $("btn-push-desactiver");
    [bA, bT, bD].forEach((b) => b.classList.add("cache"));
    try {
      if (!pushPris()) {
        texte.textContent = iosNonInstallee()
          ? "Ouvre l'appli depuis son icône de l'écran d'accueil pour pouvoir activer les notifications."
          : "Ce navigateur ne gère pas les notifications.";
        return;
      }
      if (Notification.permission === "denied") {
        texte.textContent = "Notifications bloquées. Réactive-les dans Réglages de l'iPhone > Notifications > Sy(m)phon-e.";
        return;
      }
      const sub = await monAbonnement();
      if (sub && Notification.permission === "granted") {
        texte.textContent = "Activées sur cet appareil.";
        bT.classList.remove("cache"); bD.classList.remove("cache");
      } else {
        texte.textContent = "Désactivées sur cet appareil.";
        bA.classList.remove("cache");
      }
    } catch (e) { texte.textContent = "État des notifications indisponible."; }
  }

  $("btn-push-activer").addEventListener("click", async () => {
    const msg = $("msg-push");
    msg.textContent = "";
    try {
      const perm = await Notification.requestPermission(); // doit rester le premier appel (geste de l'utilisateur)
      if (perm !== "granted") { msg.textContent = "Autorisation refusée."; await majEtatPush(); return; }
      const r = await sb.functions.invoke("envoyer-push", { body: { action: "cle" } });
      if (r.error || !r.data || !r.data.publicKey) throw new Error("clé d'envoi indisponible");
      const reg = await navigator.serviceWorker.ready;
      const ancien = await reg.pushManager.getSubscription();
      if (ancien) await ancien.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cleVersOctets(r.data.publicKey) });
      const j = sub.toJSON();
      const ins = await sb.from("app_push_abonnements").upsert(
        { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, agent: navigator.userAgent.slice(0, 200) },
        { onConflict: "endpoint" });
      if (ins.error) throw ins.error;
      msg.textContent = "";
    } catch (err) { msg.textContent = "Échec : " + (err.message || err); }
    await majEtatPush();
  });

  $("btn-push-desactiver").addEventListener("click", async () => {
    const msg = $("msg-push");
    msg.textContent = "";
    try {
      const sub = await monAbonnement();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await sb.from("app_push_abonnements").delete().eq("endpoint", endpoint);
      }
    } catch (err) { msg.textContent = "Échec : " + (err.message || err); }
    await majEtatPush();
  });

  $("btn-push-test").addEventListener("click", async () => {
    const msg = $("msg-push");
    msg.textContent = "";
    const r = await sb.rpc("notifier", {
      p_niveau: "important", p_source: "appli", p_cle: "test_push_" + Date.now(),
      p_titre: "Test de notification", p_corps: "Si tu lis ceci sur ton iPhone, les notifications marchent.", p_delai_min: 0
    });
    msg.textContent = r.error ? "Échec de l'envoi du test : " + r.error.message : "Test envoyé : la notification arrive dans quelques secondes.";
    majPastille();
  });

  /* ---------- écran Réglages ---------- */
  const MODES = [
    { id: "lecture_seule", nom: "Lecture seule", desc: "Le robot observe et ne place aucun pari." },
    { id: "fictif", nom: "Paris fictifs", desc: "Le robot note des paris pour de faux, avec le capital fictif." },
    { id: "reel", nom: "Réel", desc: "Argent réel chez le bookmaker choisi. Demande ta confirmation." }
  ];
  const LIBELLES_CHAMP = { mode: "Mode", mise_max_pari: "Mise max par pari", mise_max_jour: "Mise max par jour",
    perte_max_jour: "Perte max par jour", arret_urgence: "Arrêt d'urgence" };
  let reglages = null;
  let gardeFousModifies = false;

  function nomMode(id) { const m = MODES.find((x) => x.id === id); return m ? m.nom : id; }
  function valeurJournal(champ, v) {
    if (v === null || v === undefined) return "—";
    if (champ === "mode") return nomMode(v);
    if (champ === "arret_urgence") return v === "true" ? "activé" : "levé";
    return Number(v).toString().replace(".", ",") + " €";
  }
  function lireMontant(texte) {
    const t = String(texte).trim().replace(",", ".");
    if (t === "" || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Number(t);
  }
  function aucunChampActif() {
    const a = document.activeElement;
    return !a || !$("form-garde-fous").contains(a);
  }

  // Fenêtre de confirmation. motAttendu (facultatif) : l'utilisateur doit le taper.
  function confirmer(titre, texte, motAttendu, libelleOui) {
    return new Promise((resolve) => {
      $("confirm-titre").textContent = titre;
      $("confirm-texte").textContent = texte;
      $("confirm-msg").textContent = "";
      $("confirm-oui").textContent = libelleOui || "Confirmer";
      const champ = $("confirm-champ");
      champ.value = "";
      champ.classList.toggle("cache", !motAttendu);
      champ.placeholder = motAttendu ? "Tape " + motAttendu : "";
      $("confirm").classList.remove("cache");
      const norm = (x) => String(x).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      function fin(v) {
        $("confirm").classList.add("cache");
        $("confirm-oui").onclick = null; $("confirm-non").onclick = null;
        resolve(v);
      }
      $("confirm-non").onclick = () => fin(false);
      $("confirm-oui").onclick = () => {
        if (motAttendu && norm(champ.value) !== norm(motAttendu)) {
          $("confirm-msg").textContent = "Le mot ne correspond pas.";
          return;
        }
        fin(true);
      };
    });
  }

  async function chargerReglages() {
    const r = await sb.from("app_reglages").select("*").eq("id", 1).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) throw new Error("réglages introuvables");
    reglages = r.data;
    dessinerReglages();
    majEtatPush();
    const j = await sb.from("app_reglages_journal").select("*").order("t", { ascending: false }).limit(30);
    if (j.error) throw j.error;
    dessinerJournal(j.data || []);
  }

  function dessinerReglages() {
    const g = reglages;
    // Bandeau
    const b = $("bandeau-mode");
    b.className = "bandeau " + (g.arret_urgence ? "rouge" : (g.mode === "reel" ? "rouge" : (g.mode === "fictif" ? "alerte" : "ok")));
    b.textContent = g.arret_urgence ? "ARRÊT D'URGENCE ACTIF — le robot ne doit rien placer"
      : "Mode actuel : " + nomMode(g.mode);

    // Choix du mode
    const zone = $("choix-mode");
    vider(zone);
    MODES.forEach((m) => {
      const bt = el("button", m.id === "reel" ? "reel" : "");
      bt.type = "button";
      if (g.mode === m.id) bt.classList.add("actif");
      bt.appendChild(el("strong", null, m.nom + (g.mode === m.id ? "  ✓" : "")));
      bt.appendChild(el("span", "desc", m.desc));
      bt.addEventListener("click", () => changerMode(m.id));
      zone.appendChild(bt);
    });

    // Garde-fous (on ne réécrit pas les champs pendant la saisie)
    if (!gardeFousModifies && aucunChampActif()) {
      $("champ-mise-pari").value = String(Number(g.mise_max_pari)).replace(".", ",");
      $("champ-mise-jour").value = String(Number(g.mise_max_jour)).replace(".", ",");
      $("champ-perte-jour").value = String(Number(g.perte_max_jour)).replace(".", ",");
    }

    // Arrêt d'urgence
    const u = $("btn-urgence");
    u.classList.toggle("lever", !!g.arret_urgence);
    u.textContent = g.arret_urgence ? "Lever l'arrêt d'urgence" : "ARRÊT D'URGENCE";
    $("texte-urgence").textContent = g.arret_urgence
      ? "Actif depuis " + heurePar(g.modifie_le) + ". Le robot doit rester à l'arrêt tant qu'il n'est pas levé."
      : "Un appui coupe tout immédiatement, sans confirmation. Le mode et les garde-fous ne changent pas.";
  }

  function dessinerJournal(lignes) {
    const zone = $("journal-reglages");
    vider(zone);
    if (!lignes.length) { zone.appendChild(el("p", "discret petit", "Aucun changement enregistré.")); return; }
    lignes.forEach((l) => {
      const d = el("div", "ligne-journal");
      d.appendChild(el("div", null, (LIBELLES_CHAMP[l.champ] || l.champ) + " : " + valeurJournal(l.champ, l.ancienne) + " → " + valeurJournal(l.champ, l.nouvelle)));
      d.appendChild(el("div", "discret petit", heurePar(l.t)));
      zone.appendChild(d);
    });
  }

  async function enregistrer(champs) {
    const r = await sb.from("app_reglages").update(champs).eq("id", 1);
    if (r.error) throw r.error;
    await chargerReglages();
  }

  async function changerMode(id) {
    const msg = $("msg-mode");
    msg.textContent = "";
    if (!reglages || id === reglages.mode) return;
    try {
      if (id === "reel") {
        const g = reglages;
        if (g.arret_urgence) { msg.textContent = "Impossible : lève d'abord l'arrêt d'urgence."; return; }
        if (!(Number(g.mise_max_pari) > 0 && Number(g.mise_max_jour) > 0 && Number(g.perte_max_jour) > 0)) {
          msg.textContent = "Impossible : règle d'abord les trois garde-fous au-dessus de 0.";
          return;
        }
        const ok = await confirmer("Passer en mode RÉEL ?",
          "Le robot pourra engager de l'argent réel, dans la limite de " + g.mise_max_pari + " € par pari, " +
          g.mise_max_jour + " € par jour et " + g.perte_max_jour + " € de perte par jour.", "RÉEL", "Passer en réel");
        if (!ok) return;
      } else if (id === "fictif") {
        const ok = await confirmer("Passer en paris fictifs ?", "Le robot notera des paris pour de faux, avec le capital fictif. Aucun argent réel.", null, "Passer en fictif");
        if (!ok) return;
      }
      await enregistrer({ mode: id });
    } catch (err) { msg.textContent = "Échec de l'enregistrement : " + (err.message || err); }
  }

  ["champ-mise-pari", "champ-mise-jour", "champ-perte-jour"].forEach((id) =>
    $(id).addEventListener("input", () => { gardeFousModifies = true; }));

  $("form-garde-fous").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("msg-garde-fous");
    msg.textContent = "";
    const pari = lireMontant($("champ-mise-pari").value);
    const jour = lireMontant($("champ-mise-jour").value);
    const perte = lireMontant($("champ-perte-jour").value);
    if (pari === null || jour === null || perte === null) { msg.textContent = "Entre des montants valides (ex. 5 ou 12,50)."; return; }
    if (pari > jour) { msg.textContent = "La mise par pari ne peut pas dépasser la mise par jour."; return; }
    try {
      await enregistrer({ mise_max_pari: pari, mise_max_jour: jour, perte_max_jour: perte });
      gardeFousModifies = false;
      await chargerReglages();
      msg.textContent = "";
    } catch (err) { msg.textContent = "Échec de l'enregistrement : " + (err.message || err); }
  });

  $("btn-urgence").addEventListener("click", async () => {
    if (!reglages) return;
    const msg = $("msg-mode");
    msg.textContent = "";
    try {
      if (reglages.arret_urgence) {
        const ok = await confirmer("Lever l'arrêt d'urgence ?", "Le robot pourra reprendre selon le mode et les garde-fous en place (mode actuel : " + nomMode(reglages.mode) + ").", null, "Lever l'arrêt");
        if (!ok) return;
        await enregistrer({ arret_urgence: false });
      } else {
        await enregistrer({ arret_urgence: true });
      }
    } catch (err) { msg.textContent = "Échec de l'enregistrement : " + (err.message || err); }
  });

  /* ---------- fiche d'un match ---------- */
  function ouvrirFiche(m) {
    $("fiche-titre").textContent = (m.team1 || "?") + " – " + (m.team2 || "?");
    $("fiche-sous").textContent = (m.league || "ligue inconnue") + " · " + heurePar(m.start_time);
    ficheDirectId = null;
    vider($("fiche-detail"));
    const zone = $("fiche-badges");
    vider(zone);
    zone.appendChild(badgesLiaison(m));

    const lignes = el("div", "fiche-lignes");
    const statut = m.statut_match || "inconnu";
    let txt = "Statut du match : " + (LIBELLES_MATCH[statut] || statut);
    if (m.statut_source) txt += " (source " + (SOURCES_STATUT[m.statut_source] || m.statut_source) + ")";
    lignes.appendChild(el("p", "discret petit", txt));
    if (m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined)
      lignes.appendChild(el("p", null, "Résultat (BO3GG) : " + (m.team1 || "?") + " " + m.score1 + " – " + m.score2 + " " + (m.team2 || "?")));
    if (m.statut_match === "termine" && m.op_historique)
      lignes.appendChild(el("p", "discret petit", "L'historique des cotes (ODDSPAPI) est disponible pour ce match."));
    zone.appendChild(lignes);
    const lm = liveDe(m);
    if (lm) {
      const bt = el("button", "bouton secondaire", "Voir rounds et picks / bans");
      bt.type = "button";
      bt.addEventListener("click", () => ouvrirDirect(lm));
      zone.appendChild(bt);
    }
    $("fiche").classList.remove("cache");
  }
  function fermerFiche() { ficheDirectId = null; $("fiche").classList.add("cache"); }
  $("fiche-fermer").addEventListener("click", fermerFiche);
  $("fiche").addEventListener("click", (e) => { if (e.target === $("fiche")) fermerFiche(); });

  /* ---------- démarrage ---------- */
  (async function init() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) montrerApp(); else montrerConnexion();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.aller === "alertes" && !$("vue-app").classList.contains("cache")) aller("alertes");
      });
    }
    sb.auth.onAuthStateChange((evenement) => { if (evenement === "SIGNED_OUT") montrerConnexion(); });
  })();
})();
