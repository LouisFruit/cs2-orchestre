(function () {
  "use strict";
  const cfg = window.CS2_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const $ = (id) => document.getElementById(id);
  const TITRES = { collecte: "Collecte", direct: "En direct", matchs: "Matchs", analyse: "Analyse", paris: "Paris", reglages: "Réglages", alertes: "Alertes" };
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
      if (pageCourante === "direct" || Date.now() - derniereMaj >= cfg.RAFRAICHIR_SECONDES * 1000 - 500) rafraichir();
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
      else if (pageCourante === "direct") await chargerDirect();
      else if (pageCourante === "matchs") await chargerMatchs();
      else if (pageCourante === "reglages") await chargerReglages();
      else if (pageCourante === "alertes") await chargerAlertes();
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
  const SOURCES_STATUT = { bo3: "bo3.gg", hltv: "HLTV", ps3838: "PS3838" };
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

    GROUPES.forEach((g) => {
      const items = matchsCache.filter((m) => (m.statut_match || "inconnu") === g.cle);
      if (items.length === 0) return;
      if (g.cle === "termine") items.reverse(); // les plus récents d'abord
      if (g.ouvert) {
        liste.appendChild(el("h3", "groupe-titre", g.titre + " (" + items.length + ")"));
        items.forEach((m) => liste.appendChild(carteMatch(m)));
      } else {
        const d = el("details", "carte");
        d.appendChild(el("summary", null, g.titre + " (" + items.length + ")"));
        items.forEach((m) => d.appendChild(carteMatch(m)));
        liste.appendChild(d);
      }
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

  function libelleCouverture(c) {
    return ({ hors_couverture: "hors couverture bo3.gg", a_verifier: "à vérifier", trou_a_corriger: "trou à corriger", liee: "liée", inconnue: "non évalué" })[c] || c || "non évalué";
  }

  // Libellé HLTV selon le statut écrit par l'orchestre (repli sur l'ancien indicateur si absent)
  function etatHltv(m) {
    const s = m.hltv_statut;
    if (!s) return m.lie_hltv ? { t: "HLTV lié", c: "ok" } : { t: "HLTV non lié", c: "non" };
    if (s === "lie") return { t: "HLTV lié", c: "ok" };
    if (s === "page_ouverte") return { t: "HLTV page ouverte", c: "ok" };
    if (s === "absent") return { t: "Absent de HLTV", c: "non" };
    const notes = {
      ambigu: "HLTV : plusieurs candidats",
      academy_refuse: "HLTV : équipe Academy refusée",
      heure_differente: "HLTV : heure différente",
      pas_trouve: "Pas encore trouvé sur HLTV"
    };
    return { t: notes[m.hltv_note] || "HLTV à vérifier", c: "non" };
  }

  function badgesLiaison(m) {
    const b = el("div", "badges");
    if (m.statut_match === "en_cours") b.appendChild(el("span", "badge live", "● En cours"));
    b.appendChild(el("span", "badge " + (m.lie_bo3 ? "ok" : "non"), m.lie_bo3 ? "bo3.gg lié" : "bo3.gg non lié"));
    const h = etatHltv(m);
    b.appendChild(el("span", "badge " + h.c, h.t));
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

  async function chargerDirect() {
    const res = await sb.from("app_live_match").select("*");
    if (res.error) throw res.error;
    const matchs = res.data || [];
    let rounds = [], cotes = [], vetos = [];
    if (matchs.length) {
      const [r, c, v] = await Promise.all([
        sb.from("app_live_rounds").select("*").order("t", { ascending: true }),
        sb.from("app_live_cotes").select("*"),
        sb.from("app_live_veto").select("*")
      ]);
      if (r.error) throw r.error; if (c.error) throw c.error; if (v.error) throw v.error;
      rounds = r.data || []; cotes = c.data || []; vetos = v.data || [];
    }
    directCache = { matchs, rounds, cotes, vetos };
    dessinerDirect();
    if (ficheDirectId !== null && !$("fiche").classList.contains("cache")) {
      const m = matchs.find((x) => x.fiche_id === ficheDirectId);
      if (m) remplirDetailDirect(m);
    }
  }

  function dessinerDirect() {
    const zone = $("liste-direct");
    vider(zone);
    const matchs = directCache.matchs.slice().sort((a, b) =>
      String(b.dernier_round_le || "").localeCompare(String(a.dernier_round_le || "")));
    const enCours = matchs.filter((m) => m.statut_match === "en_cours");
    const autres = matchs.filter((m) => m.statut_match !== "en_cours");
    if (!matchs.length) {
      const c = el("div", "carte");
      c.appendChild(el("p", null, "Aucun match en direct pour le moment."));
      c.appendChild(el("p", "discret petit", "Cette page se remplit dès qu'un match suivi sur HLTV démarre. Elle se rafraîchit toute seule toutes les 10 secondes."));
      zone.appendChild(c);
      return;
    }
    zone.appendChild(el("h3", "groupe-titre", "En cours (" + enCours.length + ")"));
    if (!enCours.length) zone.appendChild(el("p", "discret petit", "Aucun match n'est marqué « en cours »."));
    enCours.forEach((m) => zone.appendChild(carteDirect(m)));
    if (autres.length) {
      zone.appendChild(el("h3", "groupe-titre", "Récemment actifs (" + autres.length + ")"));
      autres.forEach((m) => zone.appendChild(carteDirect(m)));
    }
  }

  function carteDirect(m) {
    const b = el("button", "match");
    b.type = "button";
    const haut = el("div", "ligne2");
    haut.appendChild(el("span", "equipes", (m.team1 || "?") + "  –  " + (m.team2 || "?")));
    if (m.statut_match === "en_cours") haut.appendChild(el("span", "badge live", "● En cours"));
    b.appendChild(haut);
    if (m.dernier_round_fini !== null && m.dernier_round_fini !== undefined) {
      const sc = el("div", "score-live");
      sc.appendChild(el("span", "cote-equipe", (m.ct_team || "?") + " (CT)"));
      sc.appendChild(el("span", "gros-score", m.score_ct + " – " + m.score_t));
      sc.appendChild(el("span", "cote-equipe", (m.t_team || "?") + " (T)"));
      b.appendChild(sc);
      b.appendChild(el("div", "discret petit centre",
        (m.carte || "carte ?") + " · carte " + m.carte_no + " · round " + m.dernier_round_fini + " terminé"));
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
    ficheDirectId = m.fiche_id;
    $("fiche-titre").textContent = (m.team1 || "?") + " – " + (m.team2 || "?");
    $("fiche-sous").textContent = "En direct · données HLTV et PS3838";
    vider($("fiche-badges"));
    remplirDetailDirect(m);
    $("fiche").classList.remove("cache");
  }

  function remplirDetailDirect(m) {
    const zone = $("fiche-detail");
    vider(zone);
    const rounds = directCache.rounds.filter((r) => r.hltv_match_id === m.hltv_match_id);
    const cotes = directCache.cotes.filter((c) => c.fiche_id === m.fiche_id);
    const veto = directCache.vetos.find((v) => v.hltv_match_id === m.hltv_match_id);

    // Score
    const sc = el("div", "carte");
    sc.appendChild(el("strong", null, "Score"));
    if (m.dernier_round_fini !== null && m.dernier_round_fini !== undefined) {
      sc.appendChild(el("p", null, (m.ct_team || "?") + " (CT) " + m.score_ct + " – " + m.score_t + " " + (m.t_team || "?") + " (T)"));
      sc.appendChild(el("p", "discret petit", (m.carte || "carte ?") + " · carte " + m.carte_no + " · round " + m.dernier_round_fini + " terminé à " + heureSeule(m.dernier_round_le)));
    } else sc.appendChild(el("p", "discret petit", "Pas encore de round lu."));
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

    // Cotes
    const co = el("div", "carte");
    co.appendChild(el("strong", null, "Cotes PS3838 (30 dernières minutes)"));
    if (!cotes.length) co.appendChild(el("p", "discret petit", "Aucune cote reçue récemment."));
    else {
      const plusRecent = Math.min.apply(null, cotes.map((c) => c.age_s));
      const f = el("div", "fraicheur");
      f.appendChild(el("span", "voyant " + classeFraicheur(plusRecent, 30, 120)));
      f.appendChild(el("span", "discret petit", "dernière cote il y a " + ageLisible(plusRecent)));
      co.appendChild(f);
      const parMarche = {};
      cotes.forEach((c) => { const k = c.market + " · " + nomPeriode(c.period); (parMarche[k] = parMarche[k] || []).push(c); });
      Object.keys(parMarche).sort().forEach((k, i) => {
        const d = el("details");
        if (i === 0) d.open = true;
        d.appendChild(el("summary", null, k + " (" + parMarche[k].length + ")"));
        parMarche[k].sort((a, b) => Number(a.line || 0) - Number(b.line || 0)).slice(0, 40).forEach((c) => {
          let t = (c.line !== null && c.line !== undefined ? "ligne " + c.line + " : " : "");
          t += (c.c1 || "—") + " / " + (c.c2 || "—");
          if (c.cn) t += " / nul " + c.cn;
          t += " · " + ageLisible(c.age_s);
          d.appendChild(el("p", "petit", t));
        });
        co.appendChild(d);
      });
    }
    zone.appendChild(co);

    // Probabilité HLTV (comparaison seulement)
    const pr = el("div", "carte");
    pr.appendChild(el("strong", null, "Probabilité HLTV (pour comparaison)"));
    if (m.p_gauche === null || m.p_gauche === undefined) pr.appendChild(el("p", "discret petit", "Pas de probabilité lue."));
    else {
      pr.appendChild(el("p", null, (m.team_gauche || "?") + " " + pct(m.p_gauche) + " – " + pct(m.p_droite) + " " + (m.team_droite || "?")));
      pr.appendChild(el("p", "discret petit", "Lue à " + heureSeule(m.proba_le) + ". Information stockée uniquement pour comparer, jamais utilisée pour décider."));
    }
    zone.appendChild(pr);

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
      const r = await sb.from("app_notifications").select("niveau").is("lu_le", null).limit(100);
      if (r.error) return;
      const n = (r.data || []).length;
      const p = $("pastille-alertes");
      p.textContent = n >= 100 ? "99+" : String(n);
      p.classList.toggle("cache", n === 0);
      p.classList.toggle("critique", (r.data || []).some((x) => x.niveau === "critique"));
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
    [["tous", "Toutes"], ["critique", "Critiques"], ["important", "Importantes"], ["info", "Infos"]].forEach(([id, nom]) => {
      const b = el("button", "filtre" + (filtreAlertes === id ? " actif" : ""), nom);
      b.type = "button";
      b.addEventListener("click", () => { filtreAlertes = id; dessinerAlertes(); });
      f.appendChild(b);
    });
    // liste
    const zone = $("liste-alertes");
    vider(zone);
    const liste = alertesCache.filter((a) => filtreAlertes === "tous" || a.niveau === filtreAlertes);
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

  /* ---------- écran Réglages ---------- */
  const MODES = [
    { id: "lecture_seule", nom: "Lecture seule", desc: "Le robot observe et ne place aucun pari." },
    { id: "fictif", nom: "Paris fictifs", desc: "Le robot note des paris pour de faux, avec le capital fictif." },
    { id: "reel", nom: "Réel", desc: "Argent réel sur PS3838. Demande ta confirmation." }
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
          "Le robot pourra engager de l'argent réel sur PS3838, dans la limite de " + g.mise_max_pari + " € par pari, " +
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
    if (m.statut_maj_le) txt += ", mis à jour à " + heureSeule(m.statut_maj_le);
    lignes.appendChild(el("p", "discret petit", txt));
    if (m.hltv_verifie_le) lignes.appendChild(el("p", "discret petit", "Dernière vérification HLTV : " + heureSeule(m.hltv_verifie_le)));
    if (!m.lie_bo3) lignes.appendChild(el("p", "discret petit", "Couverture bo3.gg : " + libelleCouverture(m.couverture_bo3)));
    zone.appendChild(lignes);
    $("fiche").classList.remove("cache");
  }
  function fermerFiche() { ficheDirectId = null; $("fiche").classList.add("cache"); }
  $("fiche-fermer").addEventListener("click", fermerFiche);
  $("fiche").addEventListener("click", (e) => { if (e.target === $("fiche")) fermerFiche(); });

  /* ---------- démarrage ---------- */
  (async function init() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) montrerApp(); else montrerConnexion();
    sb.auth.onAuthStateChange((evenement) => { if (evenement === "SIGNED_OUT") montrerConnexion(); });
  })();
})();
