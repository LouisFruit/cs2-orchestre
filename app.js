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

  /* ---------- fiche d'un match ---------- */
  function ouvrirFiche(m) {
    $("fiche-titre").textContent = (m.team1 || "?") + " – " + (m.team2 || "?");
    $("fiche-sous").textContent = (m.league || "ligue inconnue") + " · " + heurePar(m.start_time);
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
  $("fiche-fermer").addEventListener("click", () => $("fiche").classList.add("cache"));
  $("fiche").addEventListener("click", (e) => { if (e.target === $("fiche")) $("fiche").classList.add("cache"); });

  /* ---------- démarrage ---------- */
  (async function init() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) montrerApp(); else montrerConnexion();
    sb.auth.onAuthStateChange((evenement) => { if (evenement === "SIGNED_OUT") montrerConnexion(); });
  })();
})();
