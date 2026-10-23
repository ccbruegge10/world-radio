/*
 * World Radio: music the world owner picks, for everyone in the room. A snippet for SideQuest / Banter.
 *
 *   <bs-snippet name="world-radio" script="https://YOUR-HOST/world-radio.js" ...settings...>
 *
 * - The world owner picks the music: an internet radio station, or their own music files
 *   (links to .mp3 / .m4a / .ogg / .wav files). Everyone hears it: no accounts, no sign-in.
 * - Stations are live, so everyone hears the same moment. Music files play as a playlist and stay in
 *   step for everyone (people who arrive later join mid-song).
 * - Only the owner sees the controls (setting: control="owner" | "host" | "everyone").
 *   The owner is recognised automatically: whoever is signed in to SideQuest as the world's creator.
 * - The owner's stations and music list are saved with the world, and so is what's playing, so the
 *   music carries on next time (even before the owner arrives).
 * - Everyone has their own volume, and the music fades with distance from the speaker.
 */
(() => {
  // ---------- Settings (from the <bs-snippet name="world-radio"> element) ----------
  const EL = document.querySelector('bs-snippet[name="world-radio"]') ||
    [...document.querySelectorAll("bs-snippet")].find((e) => /world-radio(\.min)?\.js(\?|$)/.test(e.getAttribute("script") || ""));
  if (!EL) { console.warn('[World radio] no <bs-snippet name="world-radio"> on the page'); return; }
  const attr = (n, d) => { const v = EL.getAttribute(n); return v === null || v === "" ? d : v; };
  const num = (n, d, lo, hi) => { const v = parseFloat(attr(n, "")); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const bool = (n, d) => { const v = String(attr(n, "")).toLowerCase(); return v === "true" ? true : v === "false" ? false : d; };
  const vec3 = (n, d) => { const a = String(attr(n, "")).trim().split(/\s+/).map(Number); return a.length === 3 && a.every(isFinite) ? a : d; };
  const POS = vec3("position", [0, 1.5, 2]), ROT = vec3("rotation", [0, 0, 0]);
  const fullAt = num("full-volume-distance", 6, 0, 500);
  const WR = {
    key: String(attr("channel", "wr")).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "wr",
    width: num("width", 1.0, 0.3, 5),
    control: String(attr("control", "owner")).toLowerCase(),        // owner | host | everyone
    startVolume: num("volume", 50, 0, 100) / 100,
    fullAt, silentAt: Math.max(fullAt + 0.5, num("silence-distance", 20, 0, 1000)),
    distanceVolume: bool("distance-volume", true),
    drift: num("sync-tolerance", 2.5, 0.5, 10),
    loop: bool("loop", true),
    stations: String(attr("stations", "")),                         // "Name|https://stream, Name|https://stream"
  };
  // Some ad-free, listener-supported stations to start with (SomaFM); replace with the "stations" setting
  const DEFAULT_STATIONS = [
    ["Groove Salad (chill)", "https://ice1.somafm.com/groovesalad-128-mp3"],
    ["Underground 80s", "https://ice1.somafm.com/u80s-128-mp3"],
    ["Indie Pop Rocks!", "https://ice1.somafm.com/indiepop-128-mp3"],
    ["PopTron (electropop)", "https://ice1.somafm.com/poptron-128-mp3"],
    ["Beat Blender (deep house)", "https://ice1.somafm.com/beatblender-128-mp3"],
    ["Lush (vocal chill)", "https://ice1.somafm.com/lush-128-mp3"],
  ];
  const C = { bg: "rgba(24,22,30,0.96)", row: "#2c2936", button: "#3a3646", accent: "#e0457b", text: "#ffffff", dim: "#b9b3c6", muted: "#77708a" };
  const K = { now: WR.key + "_now", host: WR.key + "_host", join: WR.key + "_join_" };
  const FILES = { owner: "worldradio_owner", library: "worldradio_library", now: "worldradio_now" };

  const SCRIPT_SRC = (document.currentScript && document.currentScript.src) ||
    ([...document.scripts].map((s) => s.src).find((s) => /world-radio(\.min)?\.js(\?|$)/.test(s)) || "");
  const PLAYER = attr("player", "") || (SCRIPT_SRC ? new URL("radio-player.html", SCRIPT_SRC).href : "");
  if (!/^https?:\/\//i.test(PLAYER)) { console.warn("[World radio] can't work out where radio-player.html is; set the player attribute"); return; }

  const isAudioFile = (u) => /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(u || "");
  const nameFromUrl = (u) => {
    try { const x = new URL(u); const f = decodeURIComponent(x.pathname.split("/").pop() || x.hostname);
          return f.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_]+/g, " ").trim() || x.hostname; } catch (e) { return String(u).slice(0, 40); }
  };
  const cut = (t, n) => { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const parseStations = (s) => s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [n, u] = x.includes("|") ? x.split("|") : [nameFromUrl(x), x];
    return { n: n.trim(), u: (u || "").trim() };
  }).filter((x) => /^https?:\/\//i.test(x.u));

  window.addEventListener("bs-loaded", () => {
    const scene = BS.Scene.GetInstance();
    const me = () => (scene.localUser ? scene.localUser.uid : "me");
    const share = (p) => scene.SetPublicSpaceProps(p);
    const here = (uid) => !!(uid && (scene.users || {})[uid]);
    const J = (v) => JSON.stringify(v);

    // What's playing, shared: { kind: "station"|"list", name, url, list: [{n,u}], i, paused }
    let now = null;
    let library = { stations: [], list: [] };          // the owner's saved stations and music
    let host = null, override = "", ownerUid = "", isOwner = false;
    let page = null, master = null, browser = null, quietUntil = 0, lastSent = 0, lastEnded = -1;
    let arrived = false, waitingNow = undefined, myStampWritten = false;
    const joins = {}, staleJoin = {}, presentWhenIArrived = new Set();
    let refreshUi = () => {}, sayText = "", sayUntil = 0, tab = "stations";
    const say = (t) => { sayText = t; sayUntil = Date.now() + 3500; refreshUi(); setTimeout(() => refreshUi(), 3600); };
    const isHost = () => host === me();
    const canControl = () => isOwner || WR.control === "everyone" || (WR.control === "host" && isHost());

    // ---------- My (hidden) player ----------
    const run = (code) => { if (browser) browser.RunActions(J({ actions: [{ actionType: "runscript", strParam1: code }] })); };
    const pLoad = (url, at, play, live) => run("window.__wr&&window.__wr.load(" + J(url || "") + "," + (Number(at) || 0) + "," + !!play + "," + !!live + ")");
    const pPlay = () => run("window.__wr&&window.__wr.play()");
    const pPause = () => run("window.__wr&&window.__wr.pause()");
    const pSeek = (t) => run("window.__wr&&window.__wr.seek(" + Number(t) + ")");
    const currentUrl = () => !now ? "" : now.kind === "station" ? now.url : ((now.list || [])[now.i || 0] || {}).u || "";
    const currentName = () => !now ? "" : now.kind === "station" ? now.name : ((now.list || [])[now.i || 0] || {}).n || "";

    // ---------- Who keeps time (the owner when here, else whoever has been here longest) ----------
    const placeInLine = (uid) => {
      if (uid === me()) return myStampWritten ? joins[uid] : Infinity;
      const t = joins[uid];
      if (t && t !== staleJoin[uid]) return t;
      return !myStampWritten || presentWhenIArrived.has(uid) ? 0 : Infinity;
    };
    function recompute() {
      const uids = Object.keys(scene.users || {});
      let h;
      if (here(override)) h = override;
      else if (here(ownerUid)) h = ownerUid;
      else if (!uids.length) h = me();
      else h = uids.slice().sort((a, b) => (placeInLine(a) - placeInLine(b)) || (a < b ? -1 : a > b ? 1 : 0))[0];
      if (h !== host) { host = h; refreshUi(); }
    }
    setInterval(recompute, 1000);

    // ---------- Files saved with the world (only the owner can write them) ----------
    const P = () => BS.PersistFileBridge;
    async function readFile(name) { try { const t = P() && await P().get(scene, name); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
    function writeFile(name, data) { if (isOwner && P()) P().set(scene, name, J(data)).catch(() => {}); }
    async function findOwner() {
      const saved = await readFile(FILES.owner);
      if (saved && typeof saved.uid === "string" && !ownerUid) { ownerUid = saved.uid; recompute(); }
      try {
        const info = P() && await P().info(scene);
        if (!info || !info.canWrite) return;
        isOwner = true; ownerUid = me();
        if (override && override !== me()) share({ [K.host]: "" });
        if (!saved || saved.uid !== me()) writeFile(FILES.owner, { uid: me() });
        try { scene.OneShot({ wr: WR.key, owner: me() }); } catch (e) {}
        recompute(); refreshUi();
      } catch (e) {}
    }

    // ---------- Changing what's playing (controllers only) ----------
    function publish(n) {                 // tell everyone (and save it with the world, if I'm the owner)
      now = n;
      share({ [K.now]: n ? encodeURIComponent(J(n)) : "" });
      if (isOwner) writeFile(FILES.now, n || {});
    }
    function setNow(n) { publish(n); applyNow(true); }
    function applyNow(fresh) {
      master = null; lastEnded = -1;
      const url = currentUrl();
      if (!url) { pLoad("", 0, false, false); refreshUi(); return; }
      pLoad(url, 0, !now.paused, now.kind === "station");
      if (fresh) quietUntil = Date.now() + 3000;
      refreshUi();
    }
    const guard = () => { if (canControl()) return true; say(WR.control === "owner" ? "Only the world owner picks the music" : "Only the host picks the music"); return false; };
    function playStation(s) { if (guard()) setNow({ kind: "station", name: s.n, url: s.u, paused: false }); }
    function playList(i) { if (!guard() || !library.list.length) return; setNow({ kind: "list", list: library.list.slice(0, 200), i: i || 0, paused: false }); }
    function step(by) {
      if (!guard() || !now || now.kind !== "list") return;
      const n = now.list.length; let i = (now.i || 0) + by;
      if (i >= n) { if (!WR.loop) return; i = 0; } if (i < 0) i = n - 1;
      setNow(Object.assign({}, now, { i, paused: false }));
    }
    function togglePause() {                // same song: just pause / carry on, no reload
      if (!guard() || !now) return;
      publish(Object.assign({}, now, { paused: !now.paused }));
      if (now.paused) pPause(); else pPlay();
      lastSent = 0; refreshUi();
    }
    function stop() { if (guard()) setNow(null); }
    function addLink(raw) {
      if (!isOwner) { say("Only the world owner can add music"); return; }
      let u = String(raw || "").trim();
      if (!u) return;
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      if (isAudioFile(u)) {
        if (library.list.some((x) => x.u === u)) { say("Already in your music"); return; }
        library.list.push({ n: nameFromUrl(u), u }); say("Added to your music"); tab = "music";
      } else {
        if (library.stations.some((x) => x.u === u)) { say("Already in your stations"); return; }
        library.stations.push({ n: nameFromUrl(u), u }); say("Added to your stations"); tab = "stations";
      }
      writeFile(FILES.library, library); refreshUi();
    }
    function removeItem(which, i) {
      if (!isOwner) return;
      library[which].splice(i, 1); writeFile(FILES.library, library); refreshUi();
    }

    // ---------- Shared values and messages ----------
    scene.On("space-state-changed", (e) => {
      for (const ch of e.detail.changes) {
        const v = ch.newValue, p = ch.property || "";
        if (p === K.now) {
          let n = null; try { n = v ? JSON.parse(decodeURIComponent(v)) : null; } catch (err) {}
          if (!arrived) { waitingNow = n; continue; }
          const changed = J(n) !== J(now);
          const urlChanged = !now || !n || currentUrl() !== (n.kind === "station" ? n.url : ((n.list || [])[n.i || 0] || {}).u);
          now = n;
          if (urlChanged) applyNow(true);
          else if (changed) { if (now && now.paused) pPause(); else pPlay(); refreshUi(); }
        } else if (p === K.host) { override = v || ""; recompute(); }
        else if (p.indexOf(K.join) === 0) {
          const uid = p.slice(K.join.length);
          if (uid !== me() || myStampWritten) { joins[uid] = Number(v); recompute(); }
        }
      }
    });
    const uidOf = (e) => { const d = e && e.detail; return d && (d.uid || (d.user && d.user.uid)); };
    scene.On("user-left", (e) => { const uid = uidOf(e); if (uid && uid === override) { override = ""; share({ [K.host]: "" }); } recompute(); });
    scene.On("user-joined", (e) => {
      const uid = uidOf(e);
      if (uid && joins[uid]) staleJoin[uid] = joins[uid];
      if (uid && isOwner) try { scene.OneShot({ wr: WR.key, owner: me() }); } catch (err) {}
      lastSent = 0; recompute();
    });
    scene.On("one-shot", (e) => {
      let m; try { m = JSON.parse(e.detail.data); } catch (err) { return; }
      if (!m || m.wr !== WR.key) return;
      if (m.owner) { if (e.detail.fromAdmin) { ownerUid = m.owner; recompute(); } return; }
      if (m.sync && m.uid === host) onSync(m);
    });

    // Arriving: take my place in line; pick up what was playing (or what the owner left saved)
    setTimeout(async () => {
      for (const uid of Object.keys(scene.users || {})) if (uid !== me()) presentWhenIArrived.add(uid);
      let latest = Date.now();
      for (const uid in joins) if (uid !== me() && here(uid) && placeInLine(uid) !== Infinity) latest = Math.max(latest, joins[uid] + 1);
      joins[me()] = latest; myStampWritten = true;
      share({ [K.join + me()]: String(latest) });
      if (override === me()) share({ [K.host]: "" });
      arrived = true;
      await findOwner();
      library = (await readFile(FILES.library)) || library;
      library.stations = Array.isArray(library.stations) ? library.stations : [];
      library.list = Array.isArray(library.list) ? library.list : [];
      if (waitingNow !== undefined && waitingNow) { now = waitingNow; applyNow(false); }
      else {
        const saved = await readFile(FILES.now);            // nothing in the room yet: carry on with the owner's last pick
        if (saved && (saved.url || (saved.list && saved.list.length))) { now = saved; if (now.kind === "list") now.paused = false; share({ [K.now]: encodeURIComponent(J(now)) }); applyNow(false); }
      }
      recompute(); refreshUi();
    }, 3000);

    // ---------- Keeping music files in step (live stations are in step by themselves) ----------
    function onPage(m) {
      page = { url: m.url, t: m.t, d: m.d, paused: m.paused, err: m.err, live: m.live, at: Date.now() };
      if (!now || now.kind !== "list") { refreshUi(); return; }
      if (isHost()) {
        if (Date.now() - lastSent > 2000) {
          lastSent = Date.now();
          scene.OneShot({ wr: WR.key, sync: 1, uid: me(), i: now.i || 0, t: m.t, paused: m.paused });
        }
        // a song finished (or won't play): the time-keeper moves everyone to the next one
        if ((m.ended || m.err) && lastEnded !== (now.i || 0) && m.url === currentUrl()) {
          lastEnded = now.i || 0;
          const n = now.list.length; let i = (now.i || 0) + 1;
          if (i >= n) { if (!WR.loop) { publish(Object.assign({}, now, { paused: true })); pPause(); return; } i = 0; }
          setNow(Object.assign({}, now, { i, paused: false }));
        }
      } else follow();
      refreshUi();
    }
    function onSync(m) { master = { i: m.i, t: m.t, paused: m.paused, at: Date.now() }; follow(); }
    function follow() {
      if (isHost() || !master || !page || !now || now.kind !== "list") return;
      if ((now.i || 0) !== master.i || Date.now() < quietUntil || page.url !== currentUrl()) return;
      const expected = master.t + (master.paused ? 0 : (Date.now() - master.at) / 1000);
      const mine = page.t + (page.paused ? 0 : (Date.now() - page.at) / 1000);
      if (!master.paused && page.paused) { pSeek(expected); pPlay(); quietUntil = Date.now() + 2500; return; }
      if (master.paused && !page.paused) { pPause(); return; }
      if (!master.paused && Math.abs(expected - mine) > WR.drift) { pSeek(expected + 0.3); quietUntil = Date.now() + 3000; }
    }

    // ---------- Building it ----------
    scene.On("unity-loaded", async () => {
      const anchor = new BS.GameObject({ name: "WorldRadio", localPosition: new BS.Vector3(POS[0], POS[1], POS[2]),
                                         localEulerAngles: new BS.Vector3(ROT[0], ROT[1], ROT[2]) });
      const at = (x, y, z) => ({ parent: anchor, localPosition: new BS.Vector3(x, y, z) });

      // The hidden player (tiny page, far out of sight: it only makes sound)
      const pObj = new BS.GameObject({ name: "WorldRadioPlayer", localScale: new BS.Vector3(0.01, 0.01, 0.01), ...at(0, -50, 0) });
      browser = await pObj.AddComponent(new BS.Browser({ url: PLAYER, pageWidth: 64, pageHeight: 64 }));
      try { browser.pageWidth = 64; browser.pageHeight = 64; } catch (e) {}
      pObj.On("browser-message", (e) => { let m; try { m = JSON.parse(e.detail); } catch (err) { return; } if (m && m.from === "wr") onPage(m); });
      setTimeout(() => { if (now) applyNow(false); }, 2500);

      // My volume x distance from the speaker
      let myVolume = WR.startVolume, muted = false, factor = 1, sent = -1, sentAt = 0;
      scene.On("pose-update", (e) => {
        const hd = e.detail && e.detail.head; const h = hd && (hd.position || (hd.x !== undefined ? hd : null));
        if (!h || !WR.distanceVolume) return;
        const d = Math.sqrt((h.x - POS[0]) ** 2 + (h.y - POS[1]) ** 2 + (h.z - POS[2]) ** 2);
        const v = Math.max(0, Math.min(1, 1 - (d - WR.fullAt) / (WR.silentAt - WR.fullAt)));
        factor = v * v;
      });
      setInterval(() => {
        const want = muted ? 0 : Math.round(myVolume * factor * 100) / 100;
        if (Math.abs(want - sent) < 0.01 && Date.now() - sentAt < 2000) return;
        sent = want; sentAt = Date.now();
        run("window.__wr&&window.__wr.vol(" + want + ")");
        try { browser.RunActions(J({ actions: [{ actionType: "postmessage", strParam1: J({ wrvol: want }) }] })); } catch (e) {}
      }, 200);

      // ---------- The panel ----------
      const PW = 1000, PH = 640, ps = WR.width / (PW / 100);
      const panelObj = new BS.GameObject({ name: "WorldRadioPanel", localScale: new BS.Vector3(ps, ps, ps), ...at(0, 0, 0) });
      const ui = new BS.UI(new BS.Vector2(PW, PH));
      await panelObj.AddComponent(ui);
      ui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
      const box = (parent, st) => { const e = ui.CreateVisualElement(parent); if (st) e.SetStyles(st); return e; };
      const text = (parent, t, st) => { const e = ui.CreateLabel(t, parent);
        e.SetStyles(Object.assign({ color: C.text, fontSize: 22, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, st || {})); return e; };
      const btn = (parent, t, f, st) => { const b = ui.CreateButtonWithText(t, "", parent);
        b.SetStyles(Object.assign({ height: 54, minWidth: 54, marginLeft: 4, marginRight: 4, paddingLeft: 14, paddingRight: 14, fontSize: 21,
          color: C.text, backgroundColor: C.button, borderRadius: 27, borderWidth: 0 }, st || {})); b.OnClick(f); return b; };
      const root = box(null, { width: "100%", height: "100%", backgroundColor: C.bg, borderRadius: 24, padding: 20, flexDirection: "column" });

      // Now playing
      const top = box(root, { flexDirection: "row", alignItems: "center", marginBottom: 10 });
      const disc = box(top, { width: 64, height: 64, borderRadius: 32, backgroundColor: C.accent, marginRight: 16, alignItems: "center", justifyContent: "center" });
      text(disc, "♪", { fontSize: 34, overflow: "visible" });
      const nowCol = box(top, { flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "hidden" });
      text(nowCol, "WORLD RADIO", { fontSize: 15, fontWeight: "bold", color: C.dim });
      const nowTitle = text(nowCol, "", { fontSize: 28, fontWeight: "bold" });
      const nowSub = text(nowCol, "", { fontSize: 17, color: C.dim });

      // Everyone: my volume
      const volRow = box(root, { flexDirection: "row", alignItems: "center", marginBottom: 8 });
      const muteBtn = btn(volRow, "Mute", () => { muted = !muted; refreshUi(); });
      text(volRow, "My volume", { fontSize: 18, color: C.dim, marginLeft: 8, marginRight: 8 });
      const vol = ui.CreateSlider(0, 100, volRow);
      vol.SetStyles({ flexGrow: 1 });
      vol.SetValue(Math.round(myVolume * 100));
      vol.OnChange((e) => { myVolume = Math.max(0, Math.min(1, Number(e.value) / 100)); muted = false; refreshUi(); });

      // Controllers: transport, tabs, list, add link
      const ctl = box(root, { flexDirection: "column", flexGrow: 1 });
      const tr = box(ctl, { flexDirection: "row", alignItems: "center", marginBottom: 8 });
      const prevB = btn(tr, "⏮", () => step(-1));
      const ppB = btn(tr, "Pause", () => togglePause(), { backgroundColor: C.accent, minWidth: 120 });
      const nextB = btn(tr, "⏭", () => step(1));
      btn(tr, "Stop", () => stop());
      box(tr, { flexGrow: 1 });
      const tabB = { stations: btn(tr, "Stations", () => { tab = "stations"; page_ = 0; refreshUi(); }),
                     music: btn(tr, "My music", () => { tab = "music"; page_ = 0; refreshUi(); }) };
      const listBox = box(ctl, { flexDirection: "column", flexGrow: 1 });
      const addRow = box(ctl, { flexDirection: "row", alignItems: "center" });
      let typed = "";
      const field = new BS.UITextField(ui, addRow);
      field.placeholder = "Add a station stream or a music file link (.mp3, .m4a, .ogg)...";
      field.SetStyles({ flexGrow: 1, height: 52, fontSize: 18, borderRadius: 26, backgroundColor: "#211f29", color: C.text, paddingLeft: 16 });
      field.OnChange((e) => { typed = e.value || ""; });
      btn(addRow, "Add", () => addLink(typed), { backgroundColor: C.accent });
      const note = text(root, "", { fontSize: 17, color: C.muted, marginTop: 6 });

      let kids = [], page_ = 0, lastKey = "";
      const PER = 4;
      function renderList() {
        const builtIn = parseStations(WR.stations);
        const stations = builtIn.length ? builtIn : DEFAULT_STATIONS.map(([n, u]) => ({ n, u }));
        const items = tab === "stations"
          ? stations.map((s) => ({ s, saved: false })).concat(library.stations.map((s, i) => ({ s, saved: true, i })))
          : library.list.map((s, i) => ({ s, saved: true, i }));
        const key = [tab, page_, J(items.map((x) => x.s.u)), currentUrl(), isOwner, canControl()].join("§");
        if (key === lastKey) return;
        lastKey = key;
        for (const k of kids) try { k.Destroy(); } catch (e) {}
        kids = [];
        const pages = Math.max(1, Math.ceil(items.length / PER));
        page_ = Math.min(page_, pages - 1);
        if (!items.length) {
          kids.push(text(listBox, tab === "music" ? "No music yet. Add links to your music files (.mp3 etc.) below." : "No stations.",
            { fontSize: 19, color: C.muted, whiteSpace: "normal", marginTop: 10 }));
        }
        items.slice(page_ * PER, page_ * PER + PER).forEach((it) => {
          const playing = currentUrl() === it.s.u;
          const r = box(listBox, { flexDirection: "row", alignItems: "center", height: 62, marginBottom: 6, paddingLeft: 14, paddingRight: 6,
            backgroundColor: playing ? "rgba(224,69,123,0.28)" : C.row, borderRadius: 14 });
          kids.push(r);
          text(r, cut(it.s.n, 44), { fontSize: 21, flexGrow: 1, flexShrink: 1 });
          if (playing) text(r, "PLAYING", { fontSize: 14, fontWeight: "bold", color: C.accent, marginRight: 8 });
          btn(r, "Play", () => tab === "stations" ? playStation(it.s) : playList(it.i), { height: 46, fontSize: 19, backgroundColor: C.accent });
          if (it.saved && isOwner) btn(r, "✕", () => removeItem(tab === "stations" ? "stations" : "list", it.i), { height: 46, fontSize: 19 });
        });
        if (pages > 1) {
          const pr = box(listBox, { flexDirection: "row", alignItems: "center", justifyContent: "flex-end" });
          kids.push(pr);
          btn(pr, "◀", () => { page_ = Math.max(0, page_ - 1); refreshUi(); }, { height: 42 });
          btn(pr, "▶", () => { page_ = Math.min(pages - 1, page_ + 1); refreshUi(); }, { height: 42 });
          text(pr, "Page " + (page_ + 1) + " of " + pages, { fontSize: 17, color: C.dim, marginLeft: 6 });
        }
      }

      refreshUi = () => {
        try { nowTitle.text = now ? cut(currentName(), 40) : "Nothing playing"; } catch (e) {}
        const sub = !now ? (canControl() ? "Pick a station or your music below" : (WR.control === "owner" ? "The world owner picks the music" : "The host picks the music"))
          : now.kind === "station" ? "Live radio" + (now.paused ? "  ·  paused" : "")
          : "Song " + ((now.i || 0) + 1) + " of " + now.list.length + (now.paused ? "  ·  paused" : "");
        try { nowSub.text = Date.now() < sayUntil ? sayText : sub; } catch (e) {}
        try { muteBtn.text = muted ? "Unmute" : "Mute"; } catch (e) {}
        try { ctl.visible = canControl(); } catch (e) {}
        try { ppB.text = now && now.paused ? "Play" : "Pause"; prevB.visible = nextB.visible = !!(now && now.kind === "list"); } catch (e) {}
        for (const t in tabB) try { tabB[t].SetStyles({ backgroundColor: t === tab ? C.accent : C.button }); } catch (e) {}
        try { note.text = canControl() ? (isOwner ? "You're the world owner: your stations, music and what's playing are saved with the world." : "") : ""; } catch (e) {}
        if (canControl()) renderList();
      };
      refreshUi();
    });
  });
})();
