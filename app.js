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
      else if (pageCourante === "analyse") await chargerAnalyse();
      else if (pageCourante === "paris") await chargerParis();
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
    const estExport = (s) => /^Export /.test(s.source);
    const exportsLignes = data.filter(estExport);
    const sources = data.filter((s) => !estExport(s));
    sources.sort((a, b) => ordre.indexOf(a.source) - ordre.indexOf(b.source));

    let nbRouge = 0, nbRetard = 0;
    data.forEach((s) => {
      if (s.statut === "silencieux") nbRouge++;
      if (s.statut === "en_retard") nbRetard++;
    });
    sources.forEach((s) => {
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

    // Envois vers l'analyse (exports écrits sur le PC) : groupe à part
    if (exportsLignes.length) {
      const carteEx = el("div", "carte exports");
      carteEx.appendChild(el("strong", null, "Envois vers l'analyse"));
      carteEx.appendChild(el("p", "discret petit", "Les fichiers que la collecte prépare sur ton PC pour l'analyse."));
      exportsLignes.forEach((s) => {
        const l = el("div", "niveau");
        l.setAttribute("role", "button");
        l.tabIndex = 0;
        l.addEventListener("click", () => ouvrirExport(s));
        l.appendChild(el("span", "voyant " + s.statut));
        const corps = el("div", "corps");
        corps.appendChild(el("div", "nom", nomExport(s.source)));
        corps.appendChild(el("div", "detail discret petit",
          "Dernier envoi réussi : " + (s.derniere ? heurePar(s.derniere) + " (il y a " + dureeLisible(s.retard_min) + ")" : "aucun")));
        if (s.echec) corps.appendChild(el("div", "detail petit", "Le dernier passage a échoué."));
        if (s.seuil_min !== null && s.seuil_min !== undefined)
          corps.appendChild(el("div", "detail discret petit", "Seuil : " + dureeLisible(s.seuil_min) + (s.seuil_nuit_min ? " (" + dureeLisible(s.seuil_nuit_min) + " la nuit)" : "")));
        l.appendChild(corps);
        l.appendChild(el("span", "statut " + s.statut, LIBELLES_STATUT[s.statut] || s.statut));
        l.appendChild(el("span", "fleche", "›"));
        carteEx.appendChild(l);
      });
      liste.appendChild(carteEx);
    }

    const b = $("bandeau-global");
    if (nbRouge > 0) { b.className = "bandeau rouge"; b.textContent = nbRouge + " source(s) ou envoi(s) silencieux"; }
    else if (nbRetard > 0) { b.className = "bandeau alerte"; b.textContent = nbRetard + " source(s) ou envoi(s) en retard"; }
    else { b.className = "bandeau ok"; b.textContent = "Toutes les sources et tous les envois sont à jour"; }
    await chargerLiaison();
  }

  /* ---------- liaison des matchs entre les trois sources ---------- */
  function pourcent(a, b) { return b > 0 ? Math.round((100 * a) / b) : null; }
  function classePct(p) { return p === null ? "en_veille" : p >= 90 ? "ok" : p >= 60 ? "en_retard" : "silencieux"; }

  async function chargerLiaison() {
    const zone = $("carte-liaison");
    try {
      const [n, e] = await Promise.all([
        sb.from("app_liaison_niveaux").select("*").order("ordre", { ascending: true }),
        sb.from("app_liaison_etat").select("*")
      ]);
      if (n.error) throw n.error;
      if (e.error) throw e.error;
      vider(zone);
      const etat = (e.data || [])[0] || null;
      const carte = el("div", "carte liaison");
      const tete = el("div", "entete-liaison");
      const panne = etat && etat.statut === "panne";
      tete.appendChild(el("span", "voyant " + (panne ? "silencieux" : "ok")));
      tete.appendChild(el("strong", null, "Liaison des matchs"));
      tete.appendChild(el("span", "statut " + (panne ? "silencieux" : "ok"), panne ? "En panne" : "OK"));
      carte.appendChild(tete);
      carte.appendChild(el("p", "discret petit",
        "Un même match retrouvé dans BO3GG, ODDSPAPI et HLTV. Dernière mise à jour des liaisons : " +
        (etat && etat.derniere_maj ? heurePar(etat.derniere_maj) + " (il y a " + dureeLisible(etat.retard_min) + ")" : "jamais") + "."));
      if (panne) carte.appendChild(el("p", "petit", "La liaison automatique a échoué récemment (voir les alertes) : les nouveaux matchs ne sont plus reliés tant que ce n'est pas corrigé."));

      (n.data || []).forEach((r) => {
        const p = pourcent(r.relies_bo3_op, r.total);
        const classe = classePct(p);
        const ligne = el("div", "niveau");
        ligne.setAttribute("role", "button");
        ligne.tabIndex = 0;
        ligne.addEventListener("click", () => ouvrirLiaison(r));
        const corps = el("div", "corps");
        corps.appendChild(el("div", "nom", r.niveau));
        corps.appendChild(el("div", "detail discret petit", nombre(r.total) + " matchs · BO3GG ↔ ODDSPAPI"));
        let sources = "BO3GG " + (pourcent(r.avec_bo3, r.total) ?? "—") + " % · ODDSPAPI " + (pourcent(r.avec_op, r.total) ?? "—") + " %";
        if (r.hltv_attendus > 0) sources += " · HLTV " + r.relies_hltv + "/" + r.hltv_attendus;
        corps.appendChild(el("div", "detail discret petit", sources));
        const barre = el("div", "barre");
        const rempli = el("span", classe);
        rempli.style.width = (p === null ? 0 : p) + "%";
        barre.appendChild(rempli);
        corps.appendChild(barre);
        ligne.appendChild(corps);
        ligne.appendChild(el("span", "pct " + classe, p === null ? "—" : p + " %"));
        ligne.appendChild(el("span", "fleche", "›"));
        carte.appendChild(ligne);
      });
      // Doublons : un même match en deux lignes (facultatif : rien ne s'affiche si la vue ne répond pas)
      let dbl = null;
      try {
        const d = await sb.from("app_liaison_doublons").select("*");
        if (!d.error && d.data && d.data[0]) dbl = d.data[0];
      } catch (e2) { dbl = null; }
      if (dbl) {
        const nb = Number(dbl.nb_doublons) || 0;
        const ligne = el("div", "niveau");
        ligne.setAttribute("role", "button");
        ligne.tabIndex = 0;
        const corps = el("div", "corps");
        corps.appendChild(el("div", "nom", "Doublons"));
        corps.appendChild(el("div", "detail discret petit",
          (nb === 0 ? "Aucun match en double" : nb + (nb > 1 ? " matchs existent en double" : " match existe en double")) +
          (dbl.maj_le ? " · vérifié à " + heureSeule(dbl.maj_le) : "")));
        ligne.appendChild(corps);
        ligne.appendChild(el("span", "pct " + (nb === 0 ? "ok" : "en_retard"), String(nb)));
        if (nb > 0) {
          ligne.appendChild(el("span", "fleche", "›"));
          ligne.addEventListener("click", ouvrirDoublons);
        } else ligne.style.cursor = "default";
        carte.appendChild(ligne);
      }
      carte.appendChild(el("p", "discret petit", "Matchs des 30 derniers jours, commencés il y a plus de 6 h. Touche un niveau pour voir les matchs non reliés."));
      zone.appendChild(carte);
    } catch (err) {
      vider(zone);
      zone.appendChild(el("p", "discret petit", "Liaison des matchs : lecture impossible (" + (err.message || err) + ")."));
    }
  }

  async function ouvrirDoublons() {
    ficheDirectId = null;
    $("fiche-titre").textContent = "Matchs en double";
    $("fiche-sous").textContent = "Même paire d'équipes, deux lignes qui n'ont aucune source en commun.";
    vider($("fiche-badges"));
    const zone = $("fiche-detail");
    vider(zone);
    zone.appendChild(el("p", "discret petit", "Chargement…"));
    $("fiche").classList.remove("cache");
    try {
      const l = await sb.from("app_liaison_doublons_liste").select("*").order("rang", { ascending: true });
      if (l.error) throw l.error;
      vider(zone);
      const lignes = l.data || [];
      if (!lignes.length) { zone.appendChild(el("p", "discret", "Aucun doublon.")); return; }
      lignes.forEach((x) => {
        const c = el("div", "carte");
        c.appendChild(el("strong", null, (x.equipe1_nom || "?") + " – " + (x.equipe2_nom || "?")));
        c.appendChild(el("p", "petit", "Ligne " + x.id_a + " : " + heurePar(x.debut_a) + " · sources : " + (x.sources_a || "—")));
        c.appendChild(el("p", "petit", "Ligne " + x.id_b + " : " + heurePar(x.debut_b) + " · sources : " + (x.sources_b || "—")));
        c.appendChild(el("p", "discret petit", "Écart d'heure : " + (x.ecart_min === null || x.ecart_min === undefined ? "—" : dureeLisible(x.ecart_min))));
        zone.appendChild(c);
      });
      if (lignes.length >= 60) zone.appendChild(el("p", "discret petit", "Les 60 premiers sont affichés."));
    } catch (err) {
      vider(zone);
      zone.appendChild(el("p", "erreur", "Lecture impossible : " + (err.message || err)));
    }
  }

  async function ouvrirLiaison(r) {
    ficheDirectId = null;
    $("fiche-titre").textContent = r.niveau + " : matchs non reliés";
    $("fiche-sous").textContent = "Il manque au moins une source pour ces matchs (les plus récents d'abord).";
    vider($("fiche-badges"));
    const zone = $("fiche-detail");
    vider(zone);
    zone.appendChild(el("p", "discret petit", "Chargement…"));
    $("fiche").classList.remove("cache");
    try {
      const l = await sb.from("app_liaison_non_relies").select("*").eq("niveau", r.niveau).order("debut", { ascending: false });
      if (l.error) throw l.error;
      vider(zone);
      const lignes = l.data || [];
      if (!lignes.length) { zone.appendChild(el("p", "discret", "Aucun match non relié.")); return; }
      lignes.forEach((x) => {
        const c = el("div", "carte");
        c.appendChild(el("strong", null, (x.equipe1_nom || "?") + " – " + (x.equipe2_nom || "?")));
        c.appendChild(el("p", "discret petit", (x.tournoi ? x.tournoi + " · " : "") + heurePar(x.debut)));
        c.appendChild(el("p", "petit", "Manque : " + (x.manque || "—")));
        zone.appendChild(c);
      });
      if (lignes.length >= 60) zone.appendChild(el("p", "discret petit", "Les 60 plus récents sont affichés."));
    } catch (err) {
      vider(zone);
      zone.appendChild(el("p", "erreur", "Lecture impossible : " + (err.message || err)));
    }
  }

  /* ---------- détail d'un envoi vers l'analyse ---------- */
  function ouvrirExport(s) {
    ficheDirectId = null;
    $("fiche-titre").textContent = nomExport(s.source);
    $("fiche-sous").textContent = "Envoi vers l'analyse : fichier préparé sur ton PC";
    vider($("fiche-badges"));
    const zone = $("fiche-detail");
    vider(zone);
    const c = el("div", "carte");
    c.appendChild(el("span", "statut " + s.statut, LIBELLES_STATUT[s.statut] || s.statut));
    c.appendChild(el("p", "petit", "Dernier envoi réussi : " + (s.derniere ? heurePar(s.derniere) + " (il y a " + dureeLisible(s.retard_min) + ")" : "aucun")));
    if (s.derniere_tentative) c.appendChild(el("p", "petit", "Dernière tentative : " + heurePar(s.derniere_tentative) + (s.echec ? " (échec)" : " (réussie)")));
    if (s.lignes !== null && s.lignes !== undefined) c.appendChild(el("p", "petit", "Lignes exportées : " + nombre(s.lignes)));
    if (s.message) c.appendChild(el("p", "discret petit", s.message));
    if (s.seuil_min !== null && s.seuil_min !== undefined)
      c.appendChild(el("p", "discret petit", "Seuil : " + dureeLisible(s.seuil_min) + (s.seuil_nuit_min ? " (" + dureeLisible(s.seuil_nuit_min) + " la nuit)" : "") + ". Un échec du dernier passage met l'envoi « en retard » tout de suite."));
    zone.appendChild(c);
    $("fiche").classList.remove("cache");
  }

  /* ---------- détail d'une source : tout ce qu'elle collecte ---------- */
  function nomExport(src) { const n = src.replace(/^Export /, ""); return n.charAt(0).toUpperCase() + n.slice(1); }
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

  /* ---------- v2.6 : équipes, couleurs, noms ---------- */
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""); }
  function memeEquipe(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x === y || (x.length >= 4 && y.length >= 4 && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1));
  }
  // "a" = équipe 1 du match (vert), "b" = équipe 2 (violet), "" = inconnue
  function rangEquipe(nom, t1, t2) {
    if (memeEquipe(nom, t1)) return "a";
    if (memeEquipe(nom, t2)) return "b";
    return "";
  }
  function nomCarte(c) {
    if (!c) return "carte ?";
    const s = String(c).replace(/^de_/i, "");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // Scores (équipe 1, équipe 2) à partir d'un score donné par camp
  function orienter(t1, t2, ctNom, sc, tNom, st) {
    const rc = rangEquipe(ctNom, t1, t2), rt = rangEquipe(tNom, t1, t2);
    if (rc === "a" || rt === "b") return { s1: sc, s2: st, camp1: "CT", camp2: "T" };
    if (rc === "b" || rt === "a") return { s1: st, s2: sc, camp1: "T", camp2: "CT" };
    return null;
  }

  /* ---------- écran Paris (v2.9) : paris FICTIFS, lecture seule ---------- */
  // Le règlement est fait par la collecte, le robot pose les paris : l'appli ne fait qu'afficher.
  const MARCHES = {
    vainqueur_carte: "Vainqueur de la carte", vainqueur_match: "Vainqueur du match", handicap_cartes: "Handicap de cartes",
    total_cartes: "Total de cartes", handicap_rounds: "Handicap de rounds", total_rounds: "Total de rounds",
    vainqueur_mi_temps: "Vainqueur de la mi-temps", vainqueur_round: "Vainqueur d'un round"
  };
  const FAMILLES = { pre_match: "Avant le match", live_tenu: "En direct", trading: "Trading" };
  const MOMENTS = { avant_match: "avant le match", avant_carte: "avant la carte", en_direct: "en direct" };
  const STATUTS_PARI = { en_cours: ["En cours", "avenir"], gagne: ["Gagné", "juste"], perdu: ["Perdu", "rate"], rembourse: ["Remboursé", "nonev"], annule: ["Annulé", "nonev"], sorti: ["Sorti", "nonev"] };
  let parisDonnees = { paris: [], regles: [], roi: [], courbe: [] };
  let parisGroupe = "regle";

  function euros(x) { return aVal(x) ? fmtNb(x, 2) + " € fictifs" : "—"; }
  function nomRegle(reglesParId, id) {
    const r = reglesParId[id];
    return r ? r.nom + " v" + r.version : "Sans règle";
  }
  function libSelection(p) {
    let sel = p.selection;
    if (sel === "equipe1") sel = p.equipe1 || "équipe 1";
    else if (sel === "equipe2") sel = p.equipe2 || "équipe 2";
    else if (sel === "plus") sel = "Plus de";
    else if (sel === "moins") sel = "Moins de";
    else if (sel === "nul") sel = "Nul";
    if (aVal(p.ligne)) sel += (p.selection === "plus" || p.selection === "moins" ? " " : " (") + fmtNb(p.ligne, 1) + (p.selection === "plus" || p.selection === "moins" ? "" : ")");
    return sel;
  }

  async function chargerParis() {
    const zone = $("paris-contenu");
    const [pa, re, ro, co] = await Promise.all([
      sb.from("app_paris").select("*").in("mode", ["fictif", "ombre"]).order("cree_le", { ascending: false }).limit(200),
      sb.from("app_regles").select("*"),
      sb.from("app_roi").select("*").eq("mode", "fictif"),
      sb.from("app_bankroll_courbe").select("*").eq("mode", "fictif").order("t", { ascending: true })
    ]);
    if (pa.error) throw pa.error;
    parisDonnees = { paris: pa.data || [], regles: re.error ? [] : (re.data || []), roi: ro.error ? [] : (ro.data || []), courbe: co.error ? [] : (co.data || []) };
    dessinerParis();
  }

  function courbeSvg(points) {
    const NS = "http://www.w3.org/2000/svg";
    const W = 320, H = 110, m = 6;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "courbe");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Courbe de la bankroll fictive");
    const v = points.map((p) => Number(p.solde));
    const mn = Math.min.apply(null, v), mx = Math.max.apply(null, v);
    const span = mx - mn || 1;
    const pts = points.map((p, i) => {
      const x = points.length === 1 ? W / 2 : m + (i * (W - 2 * m)) / (points.length - 1);
      const y = H - m - ((Number(p.solde) - mn) / span) * (H - 2 * m);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    if (points.length > 1) {
      const l = document.createElementNS(NS, "polyline");
      l.setAttribute("points", pts.join(" "));
      l.setAttribute("fill", "none"); l.setAttribute("stroke", "currentColor"); l.setAttribute("stroke-width", "2");
      svg.appendChild(l);
    }
    const c = document.createElementNS(NS, "circle");
    const dern = pts[pts.length - 1].split(",");
    c.setAttribute("cx", dern[0]); c.setAttribute("cy", dern[1]); c.setAttribute("r", "3.5"); c.setAttribute("fill", "currentColor");
    svg.appendChild(c);
    return svg;
  }

  function dessinerParis() {
    const zone = $("paris-contenu");
    vider(zone);
    const d = parisDonnees;
    const reglesParId = {};
    d.regles.forEach((r) => { reglesParId[r.id] = r; });

    zone.appendChild(el("div", "bandeau fantome", "👻 FANTÔME : tous ces paris sont fictifs. Aucun argent réel n'est engagé."));

    // Bankroll fictive
    const dernier = d.courbe.length ? d.courbe[d.courbe.length - 1] : null;
    const enCours = d.paris.filter((p) => p.statut === "en_cours");
    const regles = d.paris.filter((p) => p.statut !== "en_cours");
    const c1 = el("div", "carte");
    c1.appendChild(el("strong", null, "Bankroll fictive"));
    c1.appendChild(el("p", "gros-nombre", dernier ? euros(dernier.solde) : "—"));
    if (dernier && Number(dernier.ecart_au_sommet) < 0) c1.appendChild(el("p", "discret petit", "Sous le sommet de " + euros(Math.abs(Number(dernier.ecart_au_sommet)))));
    if (d.courbe.length) c1.appendChild(courbeSvg(d.courbe));
    else c1.appendChild(el("p", "discret petit", "Pas encore de mouvement fictif."));
    c1.appendChild(el("p", "discret petit", enCours.length + " pari(s) en cours · " + regles.length + " réglé(s). Le règlement est automatique, à la fin de la carte ou du match."));
    zone.appendChild(c1);

    // ROI
    const c2 = el("div", "carte");
    c2.appendChild(el("strong", null, "ROI des paris fictifs"));
    const seg = el("div", "segment");
    [["regle", "Règle"], ["marche", "Marché"], ["famille", "Moment"], ["profil", "Profil"]].forEach(([k, t]) => {
      const b = el("button", (parisGroupe === k ? "actif" : "") + (k === "profil" ? " grise" : ""), t);
      b.addEventListener("click", () => { parisGroupe = k; dessinerParis(); });
      seg.appendChild(b);
    });
    c2.appendChild(seg);
    if (parisGroupe === "profil") {
      c2.appendChild(el("p", "discret petit", "Profils safe, modéré et risky : bientôt, dès que les règles de l'analyse (v1 du 24/11) les définissent."));
    } else if (!d.roi.length) {
      c2.appendChild(el("p", "discret petit", "Aucun pari réglé pour l'instant : pas de ROI à afficher."));
    } else {
      const g = {};
      d.roi.forEach((r) => {
        const cle = parisGroupe === "regle" ? nomRegle(reglesParId, r.regle_id) : parisGroupe === "marche" ? (MARCHES[r.marche] || r.marche) : (FAMILLES[r.famille] || r.famille);
        const x = g[cle] || (g[cle] = { n: 0, gagnes: 0, mises: 0, gains: 0 });
        x.n += Number(r.n); x.gagnes += Number(r.gagnes); x.mises += Number(r.mises); x.gains += Number(r.gains);
      });
      Object.keys(g).forEach((cle) => {
        const x = g[cle];
        const roi = x.mises ? (x.gains / x.mises) * 100 : null;
        const l = el("div", "ligne-kv" + (x.n < 30 ? " grise" : ""));
        l.appendChild(el("span", null, cle + " · " + x.n + " pari(s), " + x.gagnes + " gagné(s)"));
        l.appendChild(el("span", null, (roi === null ? "—" : (roi >= 0 ? "+" : "−") + fmtNb(Math.abs(roi), 1) + " %") + (x.n < 30 ? " (échantillon faible)" : "")));
        c2.appendChild(l);
      });
      c2.appendChild(el("p", "discret petit", "Gains divisés par mises. Sous 30 paris, un ROI ne prouve rien. Les intervalles de confiance par match viendront de l'analyse."));
    }
    zone.appendChild(c2);

    // Listes
    const liste = (titre, paris, vide) => {
      zone.appendChild(el("h3", "titre-jour", titre));
      if (!paris.length) { zone.appendChild(el("p", "discret petit", vide)); return; }
      paris.forEach((p) => zone.appendChild(cartePari(p, reglesParId)));
    };
    liste("En cours", enCours, "Aucun pari en cours.");
    liste("Réglés", regles, "Aucun pari réglé pour l'instant. Les premiers paris fictifs sont attendus début novembre.");
  }

  function cartePari(p, reglesParId) {
    const c = el("div", "carte carte-prev");
    const [txt, cl] = STATUTS_PARI[p.statut] || [p.statut, "nonev"];
    const tete = el("div", "prev-tete");
    tete.appendChild(el("strong", null, (p.equipe1 || "?") + " – " + (p.equipe2 || "?")));
    tete.appendChild(el("span", "puce " + cl, txt));
    c.appendChild(tete);
    c.appendChild(el("p", "discret petit", (MARCHES[p.marche] || p.marche) + (Number(p.carte) > 0 ? " · carte " + p.carte : "")));
    c.appendChild(el("p", null, libSelection(p) + " · cote " + fmtNb(p.cote_prise, 2) + " · mise " + euros(p.mise)));
    if (p.statut !== "en_cours" && aVal(p.gain)) c.appendChild(el("p", "petit", "Résultat : " + (Number(p.gain) >= 0 ? "+" : "−") + euros(Math.abs(Number(p.gain)))));
    const pied = el("div", "prev-pied");
    pied.appendChild(el("span", "puce fantome-puce", p.mode === "ombre" ? "FANTÔME · ombre" : "FANTÔME"));
    pied.appendChild(el("span", "discret petit", nomRegle(reglesParId, p.regle_id) + (p.moment ? " · " + MOMENTS[p.moment] : "") + " · " + heurePar(p.cree_le)));
    c.appendChild(pied);
    return c;
  }

  /* ---------- écran Analyse (v2.8) : test à blanc ---------- */
  // L'appli n'affiche que ce que l'analyse exporte : aucune statistique n'est calculée ici.
  let anaPrev = [], anaSyn = null, anaFiltre = "carte", anaLarge = true;
  const LIB_FORCE = { equilibre: "équilibré", leger_favori: "léger favori", favori_net: "favori net" };
  const TIERS = { s: "Tier S", a: "Tier A", b: "Tier B", sa_estime: "S/A (estimé)" };

  function fmtNb(x, d) { return x === null || x === undefined || x === "" ? "—" : Number(x).toLocaleString("fr-FR", { maximumFractionDigits: d === undefined ? 1 : d }); }
  function fmtPct(x) { return x === null || x === undefined || x === "" ? "—" : fmtNb(Number(x) * 100, 1) + " %"; }
  function aVal(x) { return x !== null && x !== undefined && x !== ""; }
  function libTier(t) { return !aVal(t) ? "—" : (TIERS[String(t).toLowerCase()] || String(t)); }
  function listeJson(x) {
    if (Array.isArray(x)) return x;
    if (typeof x === "string") { try { const v = JSON.parse(x); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
    return [];
  }
  function libJour(iso) {
    if (!iso) return "Date inconnue";
    const e = ecartJours(iso);
    if (e === 0) return "Aujourd'hui";
    if (e === -1) return "Hier";
    if (e === 1) return "Demain";
    const j = new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" });
    return j.charAt(0).toUpperCase() + j.slice(1);
  }
  function pointDe(p) { // vue "favori" : équipe 1 si p >= 0,5, sinon équipe 2
    const un = Number(p.p_equipe1) >= 0.5;
    const f = (x) => (!aVal(x) ? null : (un ? Number(x) : 1 - Number(x)));
    return {
      nom: un ? p.equipe1_nom : p.equipe2_nom,
      p: f(p.p_equipe1),
      bas: un ? (aVal(p.p_ic_bas) ? Number(p.p_ic_bas) : null) : (aVal(p.p_ic_haut) ? 1 - Number(p.p_ic_haut) : null),
      haut: un ? (aVal(p.p_ic_haut) ? Number(p.p_ic_haut) : null) : (aVal(p.p_ic_bas) ? 1 - Number(p.p_ic_bas) : null),
      base: f(p.p_base)
    };
  }
  function etatPrevision(p) {
    if (p.comptage === "refusee") return { cl: "refusee", txt: "Refusée" };
    if (p.res_statut === "non_evaluee") return { cl: "nonev", txt: "Non évaluée" };
    if (p.res_statut === "evalue") return p.res_juste ? { cl: "juste", txt: "Juste" } : { cl: "rate", txt: "Raté" };
    return { cl: "avenir", txt: "À venir" };
  }
  function jauge(f) {
    const g = el("div", "jauge");
    if (aVal(f.bas) && aVal(f.haut)) {
      const b = el("div", "jauge-ic");
      b.style.left = (Math.max(0, f.bas) * 100) + "%";
      b.style.width = (Math.max(0, f.haut - f.bas) * 100) + "%";
      g.appendChild(b);
    }
    if (aVal(f.base)) { const t = el("div", "jauge-base"); t.style.left = (f.base * 100) + "%"; g.appendChild(t); }
    if (aVal(f.p)) { const t = el("div", "jauge-p"); t.style.left = (f.p * 100) + "%"; g.appendChild(t); }
    g.appendChild(el("div", "jauge-mi"));
    return g;
  }
  function ligneEcart(f) {
    if (!aVal(f.base) || !aVal(f.p)) return null;
    const pts = (f.p - f.base) * 100;
    let txt = (pts >= 0 ? "+" : "−") + fmtNb(Math.abs(pts), 1) + " points par rapport à la base (" + fmtPct(f.base) + ")";
    if (aVal(f.bas) && aVal(f.haut)) {
      if (f.base < f.bas) txt += " : au-dessus de la base";
      else if (f.base > f.haut) txt += " : en dessous de la base";
      else txt += " : dans la marge";
    }
    return txt;
  }
  function titrePrevision(p) {
    const carte = Number(p.carte_no) > 0 ? "carte " + p.carte_no : "avant le match";
    return (p.equipe1_nom || "?") + " – " + (p.equipe2_nom || "?") + " · " + carte;
  }
  function sousTitrePrevision(p) {
    const morceaux = [];
    if (aVal(p.tournoi)) morceaux.push(p.tournoi);
    if (p.debut_aff) morceaux.push(heureSeule(p.debut_aff));
    if (aVal(p.format_bo)) morceaux.push("BO" + p.format_bo);
    if (aVal(p.tier)) morceaux.push(libTier(p.tier));
    return morceaux.join(" · ");
  }

  async function chargerAnalyse() {
    const zone = $("analyse-contenu");
    const [pr, sy] = await Promise.all([
      sb.from("app_analyse_previsions").select("*").order("debut_retenu_utc", { ascending: false }).limit(300),
      sb.from("app_analyse_synthese").select("*").order("calcule_le", { ascending: false }).limit(1)
    ]);
    vider(zone);
    if (pr.error) {
      const c = el("div", "carte");
      c.appendChild(el("strong", null, "En attente des données"));
      c.appendChild(el("p", "discret petit", "Les prévisions de l'analyse ne sont pas encore copiées dans l'appli. Cette page se remplira toute seule dès que ce sera le cas."));
      zone.appendChild(c);
      return;
    }
    anaPrev = (pr.data || []).slice();
    anaPrev.forEach((p) => { p.debut_aff = p.debut_retenu_utc || p.debut_saisie_utc || null; });
    anaPrev.sort((a, b) => (b.debut_aff || "").localeCompare(a.debut_aff || ""));
    anaSyn = !sy.error && sy.data && sy.data.length ? sy.data[0] : null;
    dessinerAnalyse();
  }

  function dessinerAnalyse() {
    const zone = $("analyse-contenu");
    vider(zone);
    const s = anaSyn || {};

    // Filtres
    const fl = el("div", "filtres");
    [["carte", "Vainqueur de carte"], ["match", "Vainqueur du match (non testée)"]].forEach(([k, t]) => {
      const b = el("button", "filtre" + (anaFiltre === k ? " actif" : "") + (k === "match" ? " grise" : ""), t);
      b.addEventListener("click", () => { anaFiltre = k; dessinerAnalyse(); });
      fl.appendChild(b);
    });
    zone.appendChild(fl);

    if (anaFiltre === "match") {
      zone.appendChild(el("div", "bandeau", "Probabilité de match : non testée. Elle reste indicative tant qu'il y a moins de 30 matchs avec résultat. Elle ne compte dans aucune statistique."));
    }

    // Bandeau échantillon faible
    const nC = aVal(s.n_cartes_principal) ? Number(s.n_cartes_principal) : null;
    const nM = aVal(s.n_matchs_principal) ? Number(s.n_matchs_principal) : null;
    if (nC === null || nM === null || nC < 30 || nM < 20) {
      zone.appendChild(el("div", "bandeau", "Échantillon faible : " + fmtNb(nC, 0) + " cartes et " + fmtNb(nM, 0) + " matchs dans le groupe principal. Il faut au moins 30 cartes et 20 matchs avant de tirer une conclusion."));
    }
    zone.appendChild(el("div", "bandeau fantome", "👻 Test à blanc : prévisions seulement, aucun argent."));

    // Carte résumé
    const aVenir = anaPrev.filter((p) => etatPrevision(p).cl === "avenir").length;
    const r = el("div", "carte");
    r.appendChild(el("strong", null, "Résumé"));
    const lignes = [
      ["Prévisions dans le groupe principal", fmtNb(s.n_cartes_principal, 0) + " cartes · " + fmtNb(s.n_matchs_principal, 0) + " matchs"],
      ["Comptées à part (équipe peu vue)", fmtNb(s.n_cartes_a_part, 0) + " cartes"],
      ["En attente de résultat", String(aVenir)],
      ["Réussite observée", fmtPct(s.reussite) + (aVal(s.reussite_ic_bas) ? " (entre " + fmtPct(s.reussite_ic_bas) + " et " + fmtPct(s.reussite_ic_haut) + ")" : "")],
      ["Taux attendu (moyenne des probabilités annoncées)", fmtPct(s.attendu)],
      ["Brier", aVal(s.brier) && nC !== null && nC >= 30 ? fmtNb(s.brier, 3) + (aVal(s.brier_ic_bas) ? " (entre " + fmtNb(s.brier_ic_bas, 3) + " et " + fmtNb(s.brier_ic_haut, 3) + ")" : "") + " · référence « toujours 50 % » : " + fmtNb(s.brier_ref || 0.25, 3) : "— (dès 30 cartes)"],
      ["Perte logarithmique", aVal(s.log_loss) && nC !== null && nC >= 30 ? fmtNb(s.log_loss, 3) + " · référence : " + fmtNb(s.log_loss_ref || 0.693, 3) : "— (dès 30 cartes)"],
      ["Version des réglages", aVal(s.version_reglages) ? s.version_reglages : "—"],
      ["Version des tranches", aVal(s.version_tranches) ? s.version_tranches : "—"]
    ];
    lignes.forEach(([k, v]) => {
      const l = el("div", "ligne-kv");
      l.appendChild(el("span", "discret petit", k));
      l.appendChild(el("span", null, v));
      r.appendChild(l);
    });
    if (s.intervalle_indicatif) r.appendChild(el("p", "discret petit", "Intervalles indicatifs : moins de 20 matchs. Ils sont calculés par match par l'analyse."));
    else if (aVal(s.reussite_ic_bas)) r.appendChild(el("p", "discret petit", "Intervalles calculés par match par l'analyse."));
    zone.appendChild(r);

    // Calibration
    const toutes = listeJson(s.calibration);
    const aLarges = toutes.some((t) => t.largeur === "large");
    const largeEff = anaLarge && aLarges;
    const cal = toutes.filter((t) => (largeEff ? t.largeur === "large" : t.largeur !== "large"));
    const c = el("div", "carte");
    c.appendChild(el("strong", null, "Prévu contre réalisé"));
    const seg = el("div", "segment");
    [[true, "Tranches larges"], [false, "Tranches de 5 points"]].forEach(([v, t]) => {
      const b = el("button", largeEff === v ? "actif" : null, t);
      b.addEventListener("click", () => { anaLarge = v; dessinerAnalyse(); });
      seg.appendChild(b);
    });
    c.appendChild(seg);
    if (anaLarge && !aLarges) c.appendChild(el("p", "discret petit", "Tranches larges : pas encore définies par l'analyse. Les tranches de 5 points sont affichées."));
    if (!cal.length) c.appendChild(el("p", "discret petit", "Pas encore de tranche à afficher."));
    cal.forEach((t) => {
      const ok = aVal(t.observe) && Number(t.n_cartes) >= 20;
      const l = el("div", "ligne-kv" + (ok ? "" : " grise"));
      l.appendChild(el("span", null, "Tranche " + (t.tranche || "—") + " · " + fmtNb(t.n_cartes, 0) + " cartes, " + fmtNb(t.n_matchs, 0) + (Number(t.n_matchs) > 1 ? " matchs" : " match")));
      l.appendChild(el("span", null, ok ? fmtPct(t.observe) + (aVal(t.ic_bas) ? " (" + fmtPct(t.ic_bas) + " à " + fmtPct(t.ic_haut) + ")" : "") : "— (dès 20 cartes)"));
      c.appendChild(l);
    });
    c.appendChild(el("p", "discret petit", "Une tranche n'est lue qu'à partir de 20 cartes. Pas de conclusion globale avant environ 100 cartes."));
    zone.appendChild(c);

    // Alertes de l'analyse
    const al = [];
    if (s.derive) al.push("Dérive de calibration signalée par l'analyse (calcul du dimanche).");
    if (aVal(s.nouvelle_version_motif)) al.push("Nouvelle version des réglages : " + s.nouvelle_version_motif);
    if (Number(s.n_refus_selection) > 0) al.push(s.n_refus_selection + " match(s) non prévus (équipe à déterminer, tier incertain ou statut non admis).");
    anaPrev.filter((p) => p.comptage === "refusee").forEach((p) => al.push("Prévision refusée : " + titrePrevision(p) + (aVal(p.raison_refus) ? " (" + p.raison_refus + ")" : "")));
    const limite = Date.now() - 48 * 3600 * 1000;
    anaPrev.filter((p) => p.comptage !== "refusee" && !p.res_statut && p.debut_aff && new Date(p.debut_aff).getTime() < limite)
      .forEach((p) => al.push("Résultat manquant depuis plus de 48 h : " + titrePrevision(p)));
    if (al.length) {
      const a = el("div", "carte alerte-ana");
      a.appendChild(el("strong", null, "Alertes de l'analyse"));
      al.forEach((t) => a.appendChild(el("p", "petit", "• " + t)));
      zone.appendChild(a);
    }

    // Cartes de prévision, groupées par jour de Paris
    const liste = anaPrev.filter((p) => p.comptage !== "refusee" && (anaFiltre === "match" ? aVal(p.p_match_equipe1) : p.type_prevision !== "match"));
    if (!liste.length) { zone.appendChild(el("p", "discret", "Aucune prévision à afficher.")); return; }
    let jourCourant = null;
    liste.forEach((p) => {
      const j = p.debut_aff ? jourParis(p.debut_aff) : "?";
      if (j !== jourCourant) { jourCourant = j; zone.appendChild(el("h3", "titre-jour", libJour(p.debut_aff))); }
      zone.appendChild(cartePrevision(p));
    });
  }

  function cartePrevision(p) {
    const b = el("button", "carte carte-prev");
    const e = etatPrevision(p);
    const f = anaFiltre === "match"
      ? pointDe({ equipe1_nom: p.equipe1_nom, equipe2_nom: p.equipe2_nom, p_equipe1: p.p_match_equipe1 })
      : pointDe(p);
    const tete = el("div", "prev-tete");
    tete.appendChild(el("strong", null, titrePrevision(p)));
    tete.appendChild(el("span", "puce " + e.cl, e.txt));
    b.appendChild(tete);
    b.appendChild(el("p", "discret petit", sousTitrePrevision(p)));
    if (aVal(f.p)) {
      b.appendChild(jauge(f));
      let t = (f.nom || "?") + " favorite : " + fmtPct(f.p);
      if (aVal(f.bas) && aVal(f.haut)) t += " (entre " + fmtPct(f.bas) + " et " + fmtPct(f.haut) + ")";
      b.appendChild(el("p", anaFiltre === "match" ? "grise" : null, t));
      const ec = ligneEcart(f);
      if (ec && anaFiltre !== "match") b.appendChild(el("p", "discret petit", ec));
    } else {
      b.appendChild(el("p", "discret", "Probabilité : —"));
    }
    if (p.res_statut === "evalue") {
      const g = p.res_gagnant === 1 ? p.equipe1_nom : p.res_gagnant === 2 ? p.equipe2_nom : null;
      b.appendChild(el("p", "petit", "Gagnant : " + (g || "—") + (aVal(p.res_score1) ? " · " + p.res_score1 + "–" + p.res_score2 : "")));
    } else if (p.res_statut === "non_evaluee") {
      b.appendChild(el("p", "discret petit", "Carte non jouée" + (aVal(p.res_raison) ? " : " + p.res_raison : "") + ". Exclue de tous les calculs."));
    }
    const pied = el("div", "prev-pied");
    if (p.drapeau_peu_vue) pied.appendChild(el("span", "puce peu", "Équipe peu vue" + (aVal(p.equipe_peu_vue) ? " : " + p.equipe_peu_vue : "")));
    pied.appendChild(el("span", "discret petit", aVal(p.version_reglages) ? p.version_reglages : "version —"));
    b.appendChild(pied);
    b.addEventListener("click", () => ouvrirPrevision(p));
    return b;
  }

  function ouvrirPrevision(p) {
    ficheDirectId = null;
    $("fiche-titre").textContent = titrePrevision(p);
    $("fiche-sous").textContent = "Pourquoi cette prévision ?";
    vider($("fiche-badges"));
    const zone = $("fiche-detail");
    vider(zone);
    const f = pointDe(p);
    const bloc = (titre, lignes) => {
      const c = el("div", "carte");
      c.appendChild(el("strong", null, titre));
      lignes.forEach((t) => c.appendChild(el("p", "petit", t)));
      zone.appendChild(c);
    };
    const un = Number(p.p_equipe1) >= 0.5;
    const eq = (n) => p["equipe" + n + "_nom"] || "?";
    let force = "Notes de force : " + eq(1) + " " + fmtNb(p.note1, 0) + " contre " + eq(2) + " " + fmtNb(p.note2, 0);
    if (aVal(p.force_tranche)) force += " (" + (LIB_FORCE[p.force_tranche] || String(p.force_tranche).replace(/_/g, " ")) + ")";
    bloc("Force", [force + "."]);
    bloc("Solidité", [
      eq(1) + " : " + fmtNb(p.nb_cartes_1, 0) + " cartes vues, dernière le " + (aVal(p.derniere_carte_1) ? new Date(p.derniere_carte_1).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : "—"),
      eq(2) + " : " + fmtNb(p.nb_cartes_2, 0) + " cartes vues, dernière le " + (aVal(p.derniere_carte_2) ? new Date(p.derniere_carte_2).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : "—")
    ].concat(p.drapeau_peu_vue ? ["Équipe peu vue : prévision comptée à part, hors calibration principale."] : []));
    bloc("Contexte", [[aVal(p.tournoi) ? p.tournoi : null, aVal(p.format_bo) ? "BO" + p.format_bo : null, aVal(p.tier) ? libTier(p.tier) : null, p.debut_aff ? (p.debut_retenu_utc ? "début retenu " : "début annoncé ") + heurePar(p.debut_aff) : null].filter(Boolean).join(" · ") || "—"]);
    const prob = [(f.nom || "?") + " : " + fmtPct(f.p) + (aVal(f.bas) ? " (entre " + fmtPct(f.bas) + " et " + fmtPct(f.haut) + ")" : "")];
    const ec = ligneEcart(f);
    prob.push(ec || "Base sans condition : —");
    if (aVal(p.tranche)) prob.push("Tranche : " + p.tranche);
    bloc("Probabilité", prob);
    bloc("Version et preuve", [
      "Réglages : " + (aVal(p.version_reglages) ? p.version_reglages : "—") + (aVal(p.version_date) ? " (" + new Date(p.version_date).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) + ")" : ""),
      "Données jusqu'au : " + heurePar(p.donnees_jusqu_au),
      "Prévision créée le : " + heurePar(p.cree_le),
      "Empreinte du fichier (SHA-256) : " + (aVal(p.sha256_fichier) ? p.sha256_fichier : "—"),
      "Fichier : " + (aVal(p.nom_fichier) ? p.nom_fichier : "—")
    ]);
    $("fiche").classList.add("sans-bientot");
    $("fiche").classList.remove("cache");
  }

  /* ---------- écran Matchs ---------- */
  const SOURCES_STATUT = { bo3: "BO3GG", hltv: "HLTV", oddspapi: "ODDSPAPI", heure: "l'heure de début" };
  const LIBELLES_MATCH = { en_cours: "en cours", a_venir: "à venir", termine: "terminé", inconnu: "inconnu" };

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
  function libelleJour(dateIso) {
    const e = ecartJours(dateIso);
    if (e === 0) return "Aujourd'hui";
    if (e === 1) return "Demain";
    if (e === -1) return "Hier";
    return new Date(dateIso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "2-digit", month: "2-digit" });
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

  let filtreMatchs = "jour";
  try { const f = localStorage.getItem("filtre_matchs"); if (f === "jour" || f === "tournoi" || f === "tier") filtreMatchs = f; } catch (e) { /* facultatif */ }
  let replayCartes = []; // résultats par carte des matchs de la fenêtre (vue app_replay_cartes)

  async function chargerMatchs() {
    const [jour] = await Promise.all([
      sb.from("app_matchs").select("*").order("start_time", { ascending: true }),
      chargerDonneesDirect()
    ]);
    if (jour.error) throw jour.error;
    matchsCache = jour.data || [];
    // Résultats carte par carte : facultatif (si la vue n'existe pas encore, la liste reste correcte)
    replayCartes = [];
    try {
      const ids = matchsCache.map((m) => m.hltv_match_id).filter(Boolean);
      if (ids.length) {
        const rc = await sb.from("app_replay_cartes").select("*").in("hltv_match_id", ids).order("carte_no", { ascending: true });
        if (!rc.error) replayCartes = rc.data || [];
      }
    } catch (e) { replayCartes = []; }
    dessinerMatchs();
  }

  function dessinerFiltresMatchs() {
    const f = $("filtres-matchs");
    vider(f);
    [["jour", "Par jour"], ["tournoi", "Par tournoi"], ["tier", "Par tier"]].forEach(([id, nom]) => {
      const b = el("button", "filtre" + (filtreMatchs === id ? " actif" : ""), nom);
      b.type = "button";
      b.addEventListener("click", () => {
        filtreMatchs = id;
        try { localStorage.setItem("filtre_matchs", id); } catch (e) { /* facultatif */ }
        dessinerMatchs();
      });
      f.appendChild(b);
    });
  }

  function groupesMatchs(items) {
    // items : { m, lm } hors direct. Retourne [{ titre, items }]
    const carte = {};
    const ordre = [];
    const ajouter = (cle, titre, it) => {
      if (!carte[cle]) { carte[cle] = { titre, items: [] }; ordre.push(cle); }
      carte[cle].items.push(it);
    };
    items.forEach((it) => {
      const m = it.m;
      if (filtreMatchs === "jour") ajouter(jourParis(m.start_time), libelleJour(m.start_time), it);
      else if (filtreMatchs === "tournoi") ajouter(m.league || "ligue inconnue", m.league || "Ligue inconnue", it);
      else ajouter(m.tier ? String(m.tier).toLowerCase() : "zz", m.tier ? "Tier " + String(m.tier).toUpperCase() : "Sans tier", it);
    });
    const groupes = ordre.map((k) => ({ cle: k, titre: carte[k].titre, items: carte[k].items }));
    const t = (it) => new Date(it.m.start_time).getTime();
    if (filtreMatchs === "jour") {
      const auj = jourParis(new Date().toISOString());
      // aujourd'hui, puis les jours à venir, puis les jours passés (le plus récent d'abord)
      groupes.sort((x, y) => {
        const fx = x.cle >= auj, fy = y.cle >= auj;
        if (fx !== fy) return fx ? -1 : 1;
        return fx ? x.cle.localeCompare(y.cle) : y.cle.localeCompare(x.cle);
      });
      groupes.forEach((g) => g.items.sort((a, b) => t(a) - t(b)));
    } else {
      groupes.forEach((g) => {
        const venir = g.items.filter((it) => it.m.statut_match !== "termine").sort((a, b) => t(a) - t(b));
        const fini = g.items.filter((it) => it.m.statut_match === "termine").sort((a, b) => t(b) - t(a));
        g.items = venir.concat(fini);
        g.cleTri = venir.length ? t(venir[0]) : Infinity;
        g.cleFin = fini.length ? t(fini[0]) : 0;
      });
      if (filtreMatchs === "tier") groupes.sort((x, y) => x.cle.localeCompare(y.cle));
      else groupes.sort((x, y) => (x.cleTri !== y.cleTri) ? (x.cleTri < y.cleTri ? -1 : 1) : y.cleFin - x.cleFin);
    }
    return groupes;
  }

  function dessinerMatchs() {
    dessinerFiltresMatchs();
    const liste = $("liste-matchs");
    vider(liste);
    if (matchsCache.length === 0) {
      liste.appendChild(el("div", "carte discret", "Aucun match entre hier et après-demain."));
    }
    const direct = [], autres = [], inconnu = [];
    matchsCache.forEach((m) => {
      const lm = liveDe(m);
      const cat = categorieMatch(m, lm);
      if (cat === "direct") direct.push({ m, lm });
      else if (cat === "inconnu") inconnu.push({ m, lm });
      else autres.push({ m, lm });
    });
    direct.sort((x, y) => String((y.lm && y.lm.dernier_round_le) || "").localeCompare(String((x.lm && x.lm.dernier_round_le) || "")));

    // 1. En direct : toujours en premier, quel que soit le filtre
    liste.appendChild(el("h3", "groupe-titre", "En direct (" + direct.length + ")"));
    if (!direct.length) liste.appendChild(el("p", "discret petit", "Aucun match en direct pour le moment."));
    direct.forEach(({ m, lm }) => liste.appendChild(lm ? carteDirect(lm) : carteMatch(m)));

    // 2. Le reste, regroupé selon le filtre
    groupesMatchs(autres).forEach((g) => {
      liste.appendChild(el("h3", "groupe-titre", g.titre + " (" + g.items.length + ")"));
      g.items.forEach(({ m }) => liste.appendChild(carteMatch(m)));
    });

    // 3. Sans confirmation (replié)
    if (inconnu.length) {
      const d = el("details", "carte");
      d.appendChild(el("summary", null, "Sans confirmation (" + inconnu.length + ")"));
      d.appendChild(el("p", "discret petit", "Heure de début passée, mais aucune source ne confirme que le match a eu lieu (pas de rounds HLTV, pas de résultat BO3GG ni ODDSPAPI)."));
      inconnu.forEach(({ m }) => d.appendChild(carteMatch(m)));
      liste.appendChild(d);
    }
  }

  function boDe(m) {
    const se = m.hltv_match_id ? serieDe(m) : null;
    return se && se.bo ? Number(se.bo) : null;
  }

  function carteMatch(m) {
    const bouton = el("button", "match");
    bouton.type = "button";
    const fini = m.statut_match === "termine";
    const haut = el("div", "ligne-haut");
    const eq = el("span", "equipes");
    if (fini && m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined) {
      eq.appendChild(el("span", "eq-a" + (m.score1 > m.score2 ? " gagne" : ""), m.team1 || "?"));
      eq.appendChild(el("span", "score-res", " " + m.score1 + " – " + m.score2 + " "));
      eq.appendChild(el("span", "eq-b" + (m.score2 > m.score1 ? " gagne" : ""), m.team2 || "?"));
    } else eq.textContent = (m.team1 || "?") + "  –  " + (m.team2 || "?");
    haut.appendChild(eq);
    const lib = { termine: "Terminé", a_venir: "À venir", en_cours: "● En cours", inconnu: "Sans confirmation" }[m.statut_match || "inconnu"] || "";
    haut.appendChild(el("span", "badge" + (m.statut_match === "en_cours" ? " live" : ""), lib));
    bouton.appendChild(haut);
    const bo = boDe(m);
    const meta = [m.league || "ligue inconnue", heureAvecJour(m.start_time)];
    if (bo) meta.push("BO" + bo);
    if (m.tier) meta.push("Tier " + String(m.tier).toUpperCase());
    bouton.appendChild(el("div", "meta-match", meta.join(" · ")));
    // Une ligne par carte jouée
    if (fini && m.hltv_match_id) {
      const cs = replayCartes.filter((c) => c.hltv_match_id === m.hltv_match_id);
      if (cs.length) {
        const z = el("div", "cartes-liste");
        cs.forEach((c) => {
          const l = el("div", "ligne-carte");
          let g = "Carte " + c.carte_no + " · " + nomCarte(c.carte);
          if (bo && bo >= 3 && Number(c.carte_no) === bo && c.finie) g += " · décisive";
          if (!c.finie) g += " · non terminée";
          l.appendChild(el("span", null, g));
          const o = orienter(m.team1, m.team2, c.equipe_ct, c.score_ct, c.equipe_t, c.score_t);
          const r = el("span", "res-carte");
          if (o) {
            r.appendChild(el("span", o.s1 > o.s2 ? "eq-a gagne" : "", String(o.s1)));
            r.appendChild(document.createTextNode(" – "));
            r.appendChild(el("span", o.s2 > o.s1 ? "eq-b gagne" : "", String(o.s2)));
          } else {
            const ga = c.score_ct > c.score_t ? c.equipe_ct : c.equipe_t;
            r.textContent = (ga || "?") + " " + Math.max(c.score_ct, c.score_t) + " – " + Math.min(c.score_ct, c.score_t);
          }
          l.appendChild(r);
          z.appendChild(l);
        });
        bouton.appendChild(z);
      }
    }
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

  function victoiresOrientees(m) {
    const se = serieDe(m);
    if (!se) return null;
    let v1 = 0, v2 = 0, ok = true;
    Object.keys(se.victoires || {}).forEach((n) => {
      const r = rangEquipe(n, m.team1, m.team2);
      if (r === "a") v1 += Number(se.victoires[n]); else if (r === "b") v2 += Number(se.victoires[n]); else ok = false;
    });
    return ok ? { v1, v2, bo: se.bo } : null;
  }

  function coteEquipeEl(nom, camp, cls) {
    const s = el("span", "cote-equipe " + cls);
    s.appendChild(el("div", "nom-eq", nom || "?"));
    if (camp) s.appendChild(el("div", "camp", camp));
    return s;
  }
  // Score de la carte en cours : équipe 1 à gauche (vert), équipe 2 à droite (violet), camp actuel sous le nom
  function blocScore(m) {
    const sc = el("div", "score-live");
    const o = orienter(m.team1, m.team2, m.ct_team, m.score_ct, m.t_team, m.score_t);
    if (o) {
      sc.appendChild(coteEquipeEl(m.team1, o.camp1, "eq-a"));
      sc.appendChild(el("span", "gros-score", o.s1 + " – " + o.s2));
      sc.appendChild(coteEquipeEl(m.team2, o.camp2, "eq-b"));
    } else {
      sc.appendChild(coteEquipeEl(m.ct_team, "CT", ""));
      sc.appendChild(el("span", "gros-score", m.score_ct + " – " + m.score_t));
      sc.appendChild(coteEquipeEl(m.t_team, "T", ""));
    }
    return sc;
  }
  function texteCartesGagnees(m) {
    const vo = victoiresOrientees(m);
    if (vo) return "Cartes gagnées : " + vo.v1 + " – " + vo.v2 + (vo.bo ? "  (BO" + vo.bo + ")" : "");
    const sc2 = scoreCartes(m);
    const se = serieDe(m);
    return sc2 ? "Cartes gagnées : " + sc2 + (se && se.bo ? "  (BO" + se.bo + ")" : "") : null;
  }

  function carteDirect(m) {
    const b = el("button", "match direct");
    b.type = "button";
    const haut = el("div", "ligne-haut");
    haut.appendChild(el("span", "equipes", (m.team1 || "?") + "  –  " + (m.team2 || "?")));
    const etat = etatSerie(m);
    if (etat === "en_jeu") haut.appendChild(el("span", "badge live", "● En jeu"));
    else if (etat === "entre_cartes") haut.appendChild(el("span", "badge pause", "⏸ Entre deux cartes"));
    else if (etat === "termine") haut.appendChild(el("span", "badge", "Terminé"));
    b.appendChild(haut);
    if (m.dernier_round_fini !== null && m.dernier_round_fini !== undefined) {
      b.appendChild(blocScore(m));
      const se = serieDe(m);
      let infos = nomCarte(m.carte) + " · carte " + m.carte_no + " · round " + m.dernier_round_fini;
      if (etat === "entre_cartes") infos = "Carte " + m.carte_no + " terminée" + (se && se.prochaine_carte ? " · prochaine : " + nomCarte(se.prochaine_carte) : "");
      else if (etat === "termine") infos = "Série terminée · dernière carte : " + nomCarte(m.carte);
      b.appendChild(el("div", "discret petit centre", infos));
      const t = texteCartesGagnees(m);
      if (t) b.appendChild(el("div", "discret petit centre", t));
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
    carteChoisie = null;
    $("fiche-titre").textContent = (m.team1 || "?") + " – " + (m.team2 || "?");
    $("fiche-sous").textContent = "En direct · données HLTV";
    const zb = $("fiche-badges");
    vider(zb);
    const mm = matchsCache.find((x) => x.id === m.maitre_id);
    if (mm) zb.appendChild(badgesLiaison(mm));
    remplirDetailDirect(m);
    $("fiche").classList.remove("cache");
  }

  function remplirDetailDirect(m) {
    const zone = $("fiche-detail");
    vider(zone);
    const rounds = directCache.rounds.filter((r) => r.hltv_match_id === m.hltv_match_id);
    const veto = directCache.vetos.find((v) => v.hltv_match_id === m.hltv_match_id);

    // Score en grand
    const sc = el("div", "carte");
    const etat = etatSerie(m);
    const libEtat = { en_jeu: "● En jeu", entre_cartes: "⏸ Entre deux cartes", termine: "Série terminée", inactif: "Aucune activité récente" }[etat];
    const se = serieDe(m);
    sc.appendChild(el("div", "discret petit", libEtat + (se && se.bo ? " · BO" + se.bo : "")));
    if (m.dernier_round_fini !== null && m.dernier_round_fini !== undefined) {
      sc.appendChild(blocScore(m));
      sc.appendChild(el("div", "discret petit centre", nomCarte(m.carte) + " · carte " + m.carte_no + " · round " + m.dernier_round_fini + " terminé à " + heureSeule(m.dernier_round_le)));
    } else sc.appendChild(el("p", "discret petit", "Pas encore de round lu."));
    const t = texteCartesGagnees(m);
    if (t) sc.appendChild(el("div", "discret petit centre", t));
    if (etat === "entre_cartes" && se && se.prochaine_carte) sc.appendChild(el("div", "petit centre", "Prochaine carte : " + nomCarte(se.prochaine_carte)));
    zone.appendChild(sc);

    dessinerReplay(zone, {
      t1: m.team1, t2: m.team2, rounds: rounds, veto: veto && Array.isArray(veto.veto) ? veto.veto : null, live: etat === "en_jeu"
    }, () => remplirDetailDirect(m));
  }

  /* ---------- déroulé des rounds (direct et replay) ---------- */
  let carteChoisie = null;
  let ficheToken = 0;

  function gagnantRound(r) {
    if (r.winner_team) return r.winner_team;
    const s = String(r.winner_side || "").toUpperCase();
    return s === "CT" ? r.ct_team : (s === "T" ? r.t_team : null);
  }

  // Associe chaque équipe de la carte à une ligne : "a" (équipe 1, vert) ou "b" (équipe 2, violet)
  function rangsCarte(rs, t1, t2) {
    const noms = [];
    rs.forEach((r) => [r.ct_team, r.t_team, r.winner_team].forEach((n) => { if (n && noms.indexOf(n) === -1) noms.push(n); }));
    const rang = {};
    const pris = {};
    noms.forEach((n) => { const x = rangEquipe(n, t1, t2); if (x && !pris[x]) { rang[n] = x; pris[x] = true; } });
    noms.forEach((n) => {
      if (rang[n]) return;
      const x = !pris.a ? "a" : (!pris.b ? "b" : "b");
      rang[n] = x; pris[x] = true;
    });
    let nomA = t1, nomB = t2;
    noms.forEach((n) => { if (rang[n] === "a" && !memeEquipe(n, t1)) nomA = nomA || n; if (rang[n] === "b" && !memeEquipe(n, t2)) nomB = nomB || n; });
    return { rang, nomA: nomA || "Équipe 1", nomB: nomB || "Équipe 2" };
  }

  function dessinerGrille(rs, rg, vivant) {
    const dernier = rs.length ? Number(rs[rs.length - 1].round_no) : 0;
    const cols = Math.max(24, dernier);
    const wrap = el("div", "grille-rounds");
    const leg = el("div", "leg-rounds");
    leg.appendChild(el("span", "eq-a", "■ " + rg.nomA));
    leg.appendChild(el("span", "eq-b", "■ " + rg.nomB));
    wrap.appendChild(leg);
    const g = el("div", "grille");
    g.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    const parNo = {};
    rs.forEach((r) => { parNo[r.round_no] = r; });
    ["a", "b"].forEach((ligne) => {
      for (let i = 1; i <= cols; i++) {
        const r = parNo[i];
        let cl = "cell";
        let txt = "";
        if (!r) cl += " futur";
        else {
          const w = rg.rang[gagnantRound(r)];
          if (w === ligne) { cl += " " + ligne; if (r.pistol) txt = "P"; if (vivant && i === dernier) cl += " cur"; }
          else cl += " vide";
        }
        if (i === 13) cl += " mt";
        g.appendChild(el("div", cl, txt));
      }
    });
    for (let i = 1; i <= cols; i++) {
      const n = el("div", "num" + (i === 13 ? " mt" : ""), (cols <= 24 || i % 3 === 0 || i === 1) ? String(i) : "");
      g.appendChild(n);
    }
    wrap.appendChild(g);
    const r1 = rs[0];
    if (r1) {
      const ctNom = rg.rang[r1.ct_team] === "a" ? rg.nomA : rg.nomB;
      const tNom = rg.rang[r1.ct_team] === "a" ? rg.nomB : rg.nomA;
      const mi = el("div", "mi");
      mi.appendChild(el("span", null, "1re mi-temps · " + ctNom + " CT, " + tNom + " T"));
      mi.appendChild(el("span", null, cols > 24 ? "2e · côtés inversés · prolongation" : "2e · côtés inversés"));
      wrap.appendChild(mi);
    }
    return wrap;
  }

  function dessinerVeto(zone, veto) {
    const vt = el("div", "carte");
    vt.appendChild(el("strong", null, "Picks et bans"));
    const liste = Array.isArray(veto) ? veto.slice().sort((a, b) => a.n - b.n) : [];
    if (!liste.length) vt.appendChild(el("p", "discret petit", "Pas de veto lu sur HLTV."));
    liste.forEach((v) => {
      if (v.action === ACTION_RESTANTE) vt.appendChild(el("p", "petit", v.n + ". " + (v.carte || "?") + " : carte restante (décisive)"));
      else vt.appendChild(el("p", "petit", v.n + ". " + (v.equipe || "?") + " " + (VERBES_VETO[v.action] || v.action || "") + " " + (v.carte || "?")));
    });
    if (liste.length === 6 && !liste.some((v) => v.action === ACTION_RESTANTE)) {
      const vues = liste.map((v) => String(v.carte || "").toLowerCase());
      const reste = POOL_CARTES.filter((c) => vues.indexOf(c.toLowerCase()) === -1);
      const toutesConnues = vues.every((c) => POOL_CARTES.some((p) => p.toLowerCase() === c));
      if (reste.length === 1 && toutesConnues) vt.appendChild(el("p", "petit", "7. " + reste[0] + " : carte restante (décisive), déduite faute de lecture HLTV"));
    }
    zone.appendChild(vt);
  }

  // ctx = { t1, t2, rounds, veto, live }
  function dessinerReplay(zone, ctx, redessiner) {
    const parCarte = {};
    ctx.rounds.forEach((r) => { (parCarte[r.carte_no] = parCarte[r.carte_no] || []).push(r); });
    Object.keys(parCarte).forEach((k) => parCarte[k].sort((a, b) => a.round_no - b.round_no));
    const nums = Object.keys(parCarte).map(Number).sort((a, b) => a - b);
    if (!nums.length) {
      const c = el("div", "carte");
      c.appendChild(el("strong", null, "Rounds"));
      c.appendChild(el("p", "discret petit", "Aucun round enregistré."));
      zone.appendChild(c);
    } else {
      if (carteChoisie === null || !parCarte[carteChoisie]) carteChoisie = nums[nums.length - 1];
      const tabs = el("div", "carte-onglets");
      nums.forEach((n) => {
        const b = el("button", "carte-onglet" + (n === carteChoisie ? " actif" : ""));
        b.type = "button";
        b.appendChild(el("span", null, "Carte " + n));
        b.appendChild(el("small", null, nomCarte(parCarte[n][0].carte)));
        b.addEventListener("click", () => { carteChoisie = n; redessiner(); });
        tabs.appendChild(b);
      });
      zone.appendChild(tabs);

      const rs = parCarte[carteChoisie];
      const rg = rangsCarte(rs, ctx.t1, ctx.t2);
      const dern = rs[rs.length - 1];
      const sCt = Number(dern.score_ct), sT = Number(dern.score_t);
      const sA = rg.rang[dern.ct_team] === "a" ? sCt : sT;
      const sB = rg.rang[dern.ct_team] === "a" ? sT : sCt;
      const c = el("div", "carte");
      const tit = el("strong", null, "Carte " + carteChoisie + " · " + nomCarte(rs[0].carte) + " · ");
      tit.appendChild(el("span", "eq-a", String(sA)));
      tit.appendChild(document.createTextNode(" – "));
      tit.appendChild(el("span", "eq-b", String(sB)));
      c.appendChild(tit);
      c.appendChild(dessinerGrille(rs, rg, ctx.live && carteChoisie === nums[nums.length - 1]));
      zone.appendChild(c);
    }
    dessinerVeto(zone, ctx.veto);
  }

  async function chargerReplay(m, token) {
    const zone = $("fiche-detail");
    vider(zone);
    zone.appendChild(el("p", "discret petit", "Chargement du replay…"));
    let ctx = null, erreur = false;
    try {
      const [r, v] = await Promise.all([
        sb.from("app_replay_rounds").select("*").eq("hltv_match_id", m.hltv_match_id).order("carte_no", { ascending: true }).order("round_no", { ascending: true }),
        sb.from("app_replay_veto").select("*").eq("hltv_match_id", m.hltv_match_id).limit(1)
      ]);
      if (r.error) throw r.error;
      ctx = { t1: m.team1, t2: m.team2, rounds: r.data || [], veto: (!v.error && v.data && v.data[0] && Array.isArray(v.data[0].veto)) ? v.data[0].veto : null, live: false };
    } catch (e) { erreur = true; }
    if (token !== ficheToken) return; // une autre fiche a été ouverte entre-temps
    vider(zone);
    if (erreur) { zone.appendChild(el("p", "discret petit", "Replay indisponible pour l'instant.")); return; }
    const redess = () => {
      vider(zone);
      dessinerReplay(zone, ctx, redess);
    };
    redess();
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
    carteChoisie = null;
    ficheToken++;
    vider($("fiche-detail"));
    const zone = $("fiche-badges");
    vider(zone);
    zone.appendChild(badgesLiaison(m));

    const lignes = el("div", "fiche-lignes");
    const statut = m.statut_match || "inconnu";
    let txt = "Statut du match : " + (LIBELLES_MATCH[statut] || statut);
    if (m.statut_source) txt += " (source " + (SOURCES_STATUT[m.statut_source] || m.statut_source) + ")";
    lignes.appendChild(el("p", "discret petit", txt));
    if (m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined) {
      const p = el("p", "score-fiche");
      p.appendChild(el("span", "eq-a" + (m.score1 > m.score2 ? " gagne" : ""), m.team1 || "?"));
      p.appendChild(el("span", "gros-score", " " + m.score1 + " – " + m.score2 + " "));
      p.appendChild(el("span", "eq-b" + (m.score2 > m.score1 ? " gagne" : ""), m.team2 || "?"));
      lignes.appendChild(p);
    }
    if (m.statut_match === "termine" && m.op_historique)
      lignes.appendChild(el("p", "discret petit", "L'historique des cotes (ODDSPAPI) est disponible pour ce match."));
    zone.appendChild(lignes);
    const lm = liveDe(m);
    if (lm && categorieMatch(m, lm) === "direct") {
      const bt = el("button", "bouton secondaire", "Voir le direct");
      bt.type = "button";
      bt.addEventListener("click", () => ouvrirDirect(lm));
      zone.appendChild(bt);
    } else if (m.hltv_match_id && m.statut_match !== "a_venir") {
      chargerReplay(m, ficheToken);
    }
    $("fiche").classList.remove("cache");
  }
  function fermerFiche() { ficheDirectId = null; $("fiche").classList.add("cache"); $("fiche").classList.remove("sans-bientot"); }
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
