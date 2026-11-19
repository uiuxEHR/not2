/* EMR Assesmen Monitor - content script
   1) PENGINGAT : berlaku untuk semua pasien. Bubble merah HANYA tampil di halaman List Pasien (bukan Detail Pasien / dashboard).
   0) JAM KERJA : ekstensi hanya aktif antara CFG.JAM_MULAI dan CFG.JAM_BERHENTI, lalu aktif lagi sendiri keesokan harinya.
   2) PEREKAMAN : setiap pasien yang diproses dicatat 1 baris; membuka NoRM yang sama lagi = memperbarui baris itu. */
(() => {
  "use strict";

  /* ================= PENGATURAN ================= */
  const CFG = {
    BATAS_MENIT: 10,          // wajib asesmen maks. 10 menit sejak waktu kunjung
    MULAI_NOTIF_MENIT: 7,     // bubble muncul saat selisih >= 7 menit
    MAX_MENIT_NOTIF: 240,     // lebih dari ini dianggap kunjungan lama, bubble disembunyikan
    KOREKSI_MENIT: 1,         // jam komputer lebih cepat 1 menit dari jam RME -> waktu klik & hitung mundur dikurangi ini
    JEDA_KIRIM_DETIK: 3,      // setelah ada klik, baris di sheet dibuat & diperbarui ~3 detik setelah data berubah
    JEDA_KELUAR_DETIK: 10,    // data dikirim bila petugas meninggalkan pasien selama ini
    JAM_MULAI: "00:00",       // aktif mulai jam ini (24 jam "HH:MM", mengikuti jam RME). Mis. "07:00" bila ingin ada jam mulai
    JAM_BERHENTI: "12:30",    // otomatis berhenti jam ini (tanpa bubble & tanpa perekaman); aktif lagi sendiri esok hari. Kosongkan "" = tanpa batas jam
    DEBUG: true               // true = tulis log ke Console (F12) untuk mengecek selector
  };

  /* ================= SELECTOR (disederhanakan dari selectorRME.xlsx) =================
     Selector "copy selector" yang panjang rapuh (class Tailwind bisa berubah), jadi dipendekkan. */
  const SEL = {
    ROLE:           "aside div.min-w-0.flex-1 span.truncate",   // teks "Perawat" / "Bidan"
    NAMA_LOGIN:     "aside div.min-w-0.flex-1 p.truncate",      // nama petugas yang login
    KARTU:          '[role="listitem"]',                        // kartu pasien di ListPasien
    NORM_KARTU:     "p span.font-bold",                         // NoRM di kartu
    NORM_DETAIL:    "header span.font-mono.text-blue-700",      // NoRM di header DetailPasien
    TEMPAT_LAYANAN: "header span.truncate.font-mono.font-medium:not(.inline-flex)",
    PILIH_ASESMEN:  '[aria-label="Pilih Pengkajian Umum"]',     // kartu/tombol "Pilih" Pengkajian Umum
    TTV_BTN:        "div.w-10 button",                          // tombol pen (kandidat)
    TTV_ANCHOR:     "#tensi"                                    // elemen khas kartu hasil TTV
  };
  const PEN_PATH = "M4 21a1 1 0 0 0 .24 0l4-1"; // awal path SVG ikon pen
  const DOKTER_RE = /^\s*(dr|drg)(\.|\s|$)/i;   // awalan nama dokter / dokter gigi: dr, dr., drg, drg. (Dra./Drs./Drajat TIDAK ikut)
  const COPY_PATH = "M20 2H10c-1.103 0-2 .897-2 2v4H4c-1.103"; // awal path SVG ikon copy (tombol di header Pengkajian Umum)

  /* ================= UTIL ================= */
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const txt = el => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const pad = n => String(n).padStart(2, "0");
  const hhmm  = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const stamp = (d = new Date()) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ymd = () => stamp().slice(0, 10);
  const nowRME = () => Date.now() - CFG.KOREKSI_MENIT * 60000;          // "sekarang" menurut jam RME
  const hhmmRME = () => hhmm(new Date(nowRME()));
  const dalamJamKerja = () => { if (!CFG.JAM_BERHENTI) return true; const j = hhmmRME(); return j >= CFG.JAM_MULAI && j < CFG.JAM_BERHENTI; };
  const log = (...a) => { if (CFG.DEBUG) console.log("[EMR]", ...a); };
  const BULAN = { januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5, juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11 };

  /* ================= STATE (disimpan di chrome.storage agar tahan reload) ================= */
  let S = { visit: null, rec: null };
  const ctx = { aktif: false, role: "", nama: "", id: Math.random().toString(36).slice(2), timer: null, n: 0 };
  // NoRM yang sudah terkirim ke sheet HARI INI -> { rid, tgl } (untuk memperbarui baris yang sama).
  // Entri hari sebelumnya dibuang: pasien yang kontrol lagi di hari lain dicatat sebagai kunjungan (baris) baru, bukan menimpa baris lama.
  const sudah = () => {
    const m = (S.sudah = S.sudah || {}), h = ymd();
    for (const k in m) if (!m[k] || m[k].tgl !== h) delete m[k];
    return m;
  };
  const simpan = () => { try { S.w = ctx.id; chrome.storage.local.set({ emrState: S }); } catch (e) { /* konteks ekstensi mati */ } };

  /* ================= ROBOT ================= */
  const ROBOT = `
  <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <line x1="32" y1="7" x2="32" y2="15" stroke="#0b5a6b" stroke-width="3" stroke-linecap="round"/>
    <circle class="emr-led" cx="32" cy="6" r="4"/>
    <rect x="4" y="27" width="6" height="14" rx="3" fill="#0b5a6b"/>
    <rect x="54" y="27" width="6" height="14" rx="3" fill="#0b5a6b"/>
    <rect x="10" y="15" width="44" height="40" rx="13" fill="#e8f6f5" stroke="#0b7a75" stroke-width="3"/>
    <rect x="16" y="25" width="32" height="16" rx="8" fill="#0f2a33"/>
    <circle class="emr-eye" cx="26" cy="33" r="4"/>
    <circle class="emr-eye" cx="38" cy="33" r="4"/>
    <rect x="24" y="46" width="16" height="3" rx="1.5" fill="#0b7a75"/>
  </svg>`;

  function widget(tampil) {
    let w = $("#emr-widget");
    if (!w && !tampil) return;
    if (!w) {
      w = document.createElement("div");
      w.id = "emr-widget";
      w.innerHTML = `<div id="emr-bubble" role="status" aria-live="polite"></div><div id="emr-icon" title="EMR Assesmen Monitor">${ROBOT}</div><img id="emr-maskot" alt="" draggable="false" src="${self.EMR_MASKOT || ""}">`;
      document.body.appendChild(w);
    }
    w.style.display = tampil ? "flex" : "none";
  }

  /* ================= PARSER ================= */
  const diListPasien = () => /\/ListPasien(\/|$)/i.test(location.pathname);   // .../EHR/ListPasien/17-#POLI  (bukan DetailPasien / RME)
  const normDariUrl = () => { const m = location.pathname.match(/\/DetailPasien\/[^/]+\/(\d+)/i); return m ? m[1] : ""; };
  const normDom = () => { const t = txt($(SEL.NORM_DETAIL)); return /^\d+$/.test(t) ? t : ""; };

  // "Senin, 9 November 2026 pukul 10.45" -> { ms, label:"10:45" }
  function parseKunjung(kartu) {
    for (const s of $$("span", kartu)) {
      const m = txt(s).match(/(?:(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+)?pukul\s+(\d{1,2})[.:](\d{2})/i);
      if (!m) continue;
      const d = new Date();
      const bln = m[2] ? BULAN[m[2].toLowerCase()] : undefined;
      if (m[1] && bln !== undefined) d.setFullYear(+m[3], bln, +m[1]);
      d.setHours(+m[4], +m[5], 0, 0);
      return { ms: d.getTime(), label: `${pad(m[4])}:${m[5]}` };
    }
    return null;
  }
  function normKartu(kartu) {
    const t = txt($(SEL.NORM_KARTU, kartu));
    if (/^\d+$/.test(t)) return t;
    const m = txt($("p", kartu)).match(/·\s*(\d{4,})\s*·/);
    return m ? m[1] : "";
  }

  // Header "Pengkajian Umum": judul + <p>nama</p> + <p>unit · tanggal, 09:28</p>
  // Bila ada beberapa catatan, pilih yang waktunya >= waktu klik (catatan baru), jika tidak ada pakai yang pertama.
  function bacaAsesmen(minWaktu) {
    const cands = [];
    for (const h of $$("h1, h2, h3")) {
      if (!/^Pengkajian Umum$/i.test(txt(h)) || !h.parentElement) continue;
      const ps = $$("p", h.parentElement);
      const wp = ps.find(p => /·.*\d{1,2}[.:]\d{2}\s*$/.test(txt(p)));
      if (!wp) continue;
      const m = txt(wp).match(/(\d{1,2})[.:](\d{2})\s*$/);
      const up = ps.find(p => p !== wp);
      const user = txt(up);
      if (DOKTER_RE.test(user)) continue;               // catatan dokter diabaikan (nama & jamnya): fokus hanya perawat/bidan
      cands.push({ user, waktu: `${pad(m[1])}:${m[2]}` });
    }
    return cands.find(c => !minWaktu || c.waktu >= minWaktu) || cands[0] || { user: "", waktu: "" };
  }
  // Kartu hasil TTV: <h6>tgl</h6><h4>2026-11-09 09:26:50</h4>  -> "09:26"
  function bacaTTV() {
    const anchor = $(SEL.TTV_ANCHOR);
    const li = anchor && anchor.closest("li");
    if (!li) return "";
    const h6 = $$("h6", li).find(h => /^tgl$/i.test(txt(h)));
    const m = txt(h6 && h6.nextElementSibling).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
    return m ? `${pad(m[1])}:${m[2]}` : "";
  }

  // Pen ikon dipakai banyak form, jadi pastikan pen ini milik bagian TTV.
  function konteksPen(btn) {
    const out = [];
    for (let a = btn.parentElement, i = 0; a && i < 7; a = a.parentElement, i++)
      out.push(`${a.tagName.toLowerCase()}.${Array.from(a.classList).slice(0, 3).join(".")}: ${txt(a).slice(0, 50)}`);
    return out;
  }
  function isTTVPen(btn) {
    const path = $("svg path", btn);
    if (!path || !(path.getAttribute("d") || "").startsWith(PEN_PATH)) return false;
    if (!btn.closest("div.w-10")) return false;
    let a = btn;
    for (let i = 0; i < 7 && a.parentElement; i++) {          // naik maks. 7 level
      a = a.parentElement;
      if (i < 4 && /\bTTV\b|tanda[\s-]*vital/i.test(a.textContent)) return true;  // judul "TTV" di kolom pen
      if (a.querySelector(SEL.TTV_ANCHOR)) return true;                            // atau satu blok dengan hasil TTV
    }
    // Fallback: pasien baru belum punya hasil TTV (#tensi belum ada). Pakai posisi struktur sesuai selector asli:
    // div.p-1.5 > div.my-2 > div > div.md:w-4/12 > div > div.w-10 > div > button
    const my2 = btn.closest("div.my-2");
    if (my2 && my2.parentElement && my2.parentElement.classList.contains("p-1.5") && btn.closest("div.md\\:w-4\\/12")) {
      log("pen TTV dikenali lewat struktur (fallback). Konteks:", konteksPen(btn));
      return true;
    }
    log("pen TIDAK dikenali sebagai TTV. Konteks:", konteksPen(btn));
    return false;
  }

  // Tombol copy di header kartu "Pengkajian Umum": dikenali dari ikon copy + judul kartunya (bukan dari class Tailwind yang bisa berubah).
  // Ikon yang sama di kartu lain (mis. Pengkajian Medis) sengaja diabaikan.
  function isCopyAsesmen(btn) {
    const path = $("svg path", btn);
    if (!path || !(path.getAttribute("d") || "").startsWith(COPY_PATH)) return false;
    for (let a = btn.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {   // naik ke blok header terdekat yang punya judul
      const hs = $$("h1, h2, h3", a);
      if (hs.length) {
        const ok = hs.some(h => /^Pengkajian Umum$/i.test(txt(h)));
        if (!ok) log("tombol copy bukan milik Pengkajian Umum, diabaikan:", hs.map(txt));
        return ok;
      }
    }
    return false;
  }

  // Cari peran & nama petugas dari teks "Perawat"/"Bidan" (tidak bergantung pada class)
  function cariPeran() {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => /^\s*(perawat|bidan)\s*$/i.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    const n = tw.nextNode();
    if (!n || !n.parentElement) return { role: "", nama: "" };
    const role = n.nodeValue.trim();
    let nama = "";
    for (let a = n.parentElement.parentElement, i = 0; a && i < 4 && !nama; a = a.parentElement, i++) {
      const sisa = txt(a).replace(role, "").trim();
      if (sisa && sisa.length < 60) nama = sisa;
    }
    return { role, nama };
  }

  /* ================= KLIK ================= */
  function onClick(e) {
    if (!ctx.aktif) return;
    scrapeNow();            // fase capture: baca label sekarang, sebelum tampilan berganti
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.closest(SEL.PILIH_ASESMEN)) return klikPilihAsesmen();
    const btn = el.closest("button");
    if (btn && isCopyAsesmen(btn)) return klikPilihAsesmen("copy");   // alternatif (OR): tombol copy di header Pengkajian Umum
    if (btn && isTTVPen(btn)) return klikTTV();
    const kartu = el.closest(SEL.KARTU);
    if (kartu) klikKartu(kartu);
  }

  function klikKartu(kartu) {
    const k = parseKunjung(kartu), n = normKartu(kartu);
    if (!k || !n) return log("kartu pasien tidak terbaca", { k, n });
    const v = S.visit;
    if (v && v.norm === n && v.ms === k.ms && v.stop) return;     // sudah asesmen, jangan aktifkan lagi
    S.visit = { norm: n, ms: k.ms, label: k.label, stop: false };
    simpan();
    log("pengingat aktif", S.visit);
  }

  // Waktu klik asesmen (WaktuKlikAssesmenKep) dicatat dari SALAH SATU aksi (kondisi OR):
  //   - klik "Pilih" Pengkajian Umum, atau
  //   - klik tombol copy di header Pengkajian Umum.
  // HANYA klik PERTAMA yang dicatat. Klik berikutnya pada tombol mana pun tidak menimpa waktu itu
  // (server juga menolak menimpa, jadi aman dari komputer/sesi lain).
  function klikPilihAsesmen(sumber) {
    const norm = normDariUrl(), copy = sumber === "copy";
    const v = S.visit;
    if (v && !v.stop && (!norm || v.norm === norm)) v.stop = true;      // hentikan notifikasi
    const r = S.rec;
    if (r && !r.done && r.key === norm) {
      if (!r.klikAs) { r.klikAs = true; r.d.WaktuKlikAssesmenKep = hhmmRME(); r.ubah = Date.now(); }
      else log("klik berikutnya diabaikan, waktu pertama dipertahankan:", r.d.WaktuKlikAssesmenKep);
    }
    simpan();
    log(copy ? "klik tombol copy Pengkajian Umum" : "klik Pilih Pengkajian Umum", norm);
  }

  function klikTTV() {
    const r = S.rec;
    if (r && !r.done && r.key === normDariUrl() && (!r.klikTTV || r.d.WaktuInputTTV)) { r.klikTTV = true; r.d.WaktuKlikTTV = hhmmRME(); r.ubah = Date.now(); simpan(); }   // klik ulang setelah tersimpan = edit
    log("klik pen TTV");
  }

  /* ================= PEREKAMAN ================= */
  // lama = entri dari sudah() bila NoRM ini pernah terkirim -> pakai RowId yang sama (mode edit/lanjut)
  function rekamBaru(norm, lama) {
    const resume = !!lama;
    return {
      id: (lama && lama.rid) || ((self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + "-" + Math.random()),
      resume, key: norm, done: false, klikAs: false, klikTTV: false, hb: Date.now(), ubah: Date.now(), sentJson: "",
      d: { Timestamp: resume ? "" : stamp(), norm: normDom() || norm, Tempatlayanan: "", WaktuKunjung: "",
           WaktuKlikAssesmenKep: "", WaktuInputAssesmenKep: "", UserPembuat: "", WaktuKlikTTV: "", WaktuInputTTV: "" }
    };
  }
  function isi(r, k, v) { if (v && r.d[k] !== v) { r.d[k] = v; r.ubah = Date.now(); simpan(); } }

  // Baca label Pengkajian Umum & TTV. Dipanggil saat DOM berubah dan saat klik, jadi tidak ada yang terlewat.
  function scrapeNow() {
    const r = S.rec;
    if (!r || r.done || !ctx.aktif || r.key !== normDariUrl()) return;
    const a = bacaAsesmen(r.d.WaktuKlikAssesmenKep);
    isi(r, "WaktuInputAssesmenKep", a.waktu);
    isi(r, "UserPembuat", a.user);
    isi(r, "WaktuInputTTV", bacaTTV());
  }

  // Kirim data. Baris di sheet diidentifikasi oleh rid, jadi pengiriman berikutnya MEMPERBARUI baris yang sama.
  function kirimData(r, alasan) {
    const payload = Object.assign({ id: r.id + ":" + Date.now(), rid: r.id, alasan }, r.d);
    r.sentJson = JSON.stringify(r.d);
    sudah()[r.key] = { rid: r.id, tgl: ymd() };
    simpan();
    try { chrome.runtime.sendMessage({ type: "SEND_ROW", payload }); } catch (e) { log(e); }
    log("data dikirim:", alasan, payload);
  }
  // Selesai dengan pasien ini. Hanya dikirim bila ada aksi (klik Pilih / pen TTV) dan ada data yang belum terkirim.
  function kirim(r, alasan) {
    r.done = true;
    if ((r.klikAs || r.klikTTV) && JSON.stringify(r.d) !== r.sentJson) kirimData(r, alasan);
    else { simpan(); log("selesai tanpa data baru:", alasan, r.key); }
  }

  // Lewat jam kerja: kirim dulu data pasien yang masih diproses (sekali saja), lalu ekstensi diam sampai jam mulai berikutnya.
  function selesaiJam() { const r = S.rec; if (r && !r.done) kirim(r, "jam-selesai"); }

  function kelolaRekam(norm) {
    const now = Date.now();
    let r = S.rec;
    // selesai dengan pasien sebelumnya: pindah ke pasien lain, atau sudah lama tidak di halaman detail
    if (r && !r.done) {
      if (norm && r.key !== norm) kirim(r, "ganti-pasien");
      else if (!norm && now - r.hb > CFG.JEDA_KELUAR_DETIK * 1000) kirim(r, "keluar");
    }
    if (!norm) return;

    r = S.rec;
    if (!r || r.done || r.key !== norm) {                // buka pasien: baru, atau NoRM lama -> lanjut baris yang sama
      const lama = sudah()[norm];
      r = S.rec = rekamBaru(norm, lama);
      simpan();
      log(lama ? "NoRM sudah pernah tercatat, mode edit (baris diperbarui):" : "perekaman dimulai untuk NoRM", norm);
    }

    if (now - r.hb > 3000) { r.hb = now; simpan(); if (CFG.DEBUG && now - (ctx.lastLog || 0) > 10000) { ctx.lastLog = now; log("isi data saat ini:", JSON.stringify(r.d), "| judul di halaman:", $$("h1,h2,h3").map(txt).filter(Boolean).slice(0, 8)); } }    // "denyut" bahwa petugas masih di pasien ini

    isi(r, "Tempatlayanan", txt($(SEL.TEMPAT_LAYANAN)));
    const nd = normDom(); if (nd) isi(r, "norm", nd);
    if (S.visit && S.visit.norm === r.key) isi(r, "WaktuKunjung", S.visit.label);
    scrapeNow();

    // kirim/perbarui baris di sheet segera setelah ada perubahan (setelah petugas mulai klik)
    if ((r.klikAs || r.klikTTV) && JSON.stringify(r.d) !== r.sentJson && now - r.ubah > CFG.JEDA_KIRIM_DETIK * 1000) kirimData(r, "update");
  }

  /* ================= BUBBLE ================= */
  function renderBubble() {
    const el = $("#emr-bubble"), w = $("#emr-widget");
    if (!el || !w) return;
    const v = S.visit;
    let teks = "", late = false;
    if (diListPasien() && v && !v.stop) {             // bubble HANYA di List Pasien
      const mnt = Math.floor((nowRME() - v.ms) / 60000);
      if (mnt >= CFG.MULAI_NOTIF_MENIT && mnt <= CFG.MAX_MENIT_NOTIF) {
        late = mnt >= CFG.BATAS_MENIT;
        teks = late ? "Batas waktu assesmen sudah terlewat" : `Kurang ${CFG.BATAS_MENIT - mnt} menit wajib melakukan assesmen`;
      }
    }
    if (el.textContent !== teks) el.textContent = teks;
    el.classList.toggle("show", !!teks);
    el.classList.toggle("late", late);
    w.classList.toggle("emr-warn", !!teks);
  }

  /* ================= LOOP UTAMA ================= */
  function tick() {
    try {
      ctx.n++;
      const { role, nama } = cariPeran();
      if (role) {
        if (role !== ctx.role || (nama && nama !== ctx.nama)) {
          ctx.role = role; ctx.nama = nama || ctx.nama;
          try { chrome.storage.local.set({ emrRole: { role, nama: ctx.nama, t: Date.now() } }); } catch (e) { /* abaikan */ }
        }
      } else if (ctx.role && $$('input[type="password"]').some(i => i.offsetParent !== null)) {
        ctx.role = ""; ctx.nama = "";                         // form login tampil = sudah logout
        try { chrome.storage.local.remove("emrRole"); } catch (e) { /* abaikan */ }
      }
      // Peran diingat: label "Perawat" tidak selalu tampil (sidebar diciutkan, pindah halaman, baru login).
      const peranOk = /^(perawat|bidan)$/i.test(ctx.role) && /\/EHR(\/|$)/i.test(location.pathname);
      const aktif = peranOk && dalamJamKerja();                // di luar jam kerja: tidak ada bubble, tidak ada perekaman
      if (peranOk && !aktif) selesaiJam();
      if (aktif !== ctx.aktif) { ctx.aktif = aktif; log("aktif:", aktif, ctx.role, ctx.nama); }
      widget(aktif);
      if (aktif) {                                            // List Pasien = maskot; halaman lain (awal/detail) = robot
        const w = $("#emr-widget"), list = diListPasien();
        if (w && w.classList.contains("emr-list") !== list) w.classList.toggle("emr-list", list);
      }
      if (!aktif) {
        if (!peranOk && ctx.n === 20) console.info("[EMR] belum menemukan label Perawat/Bidan di halaman ini:", location.href);
        return;
      }
      if (!ctx.nama) ctx.nama = "petugas";
      kelolaRekam(normDariUrl());
      renderBubble();
    } catch (e) {
      if (/context invalidated/i.test(String(e))) clearInterval(ctx.timer); else console.warn("[EMR] error", e);
    }
  }

  function mulai() {
    chrome.storage.local.get(["emrState", "emrRole"], v => {
      if (v && v.emrState) S = v.emrState;
      const er = v && v.emrRole;
      if (er && Date.now() - er.t < 12 * 3600 * 1000) { ctx.role = er.role; ctx.nama = er.nama || ""; }
      document.addEventListener("click", onClick, true);   // fase capture: tetap terbaca walau React menghentikan event
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === "local" && ch.emrState && ch.emrState.newValue && ch.emrState.newValue.w !== ctx.id) S = ch.emrState.newValue;
      });
      // Pantau perubahan DOM supaya label Pengkajian Umum / TTV terbaca seketika (sebelum hilang saat petugas pindah bagian)
      let tunggu = false;
      new MutationObserver(() => {
        if (tunggu) return;
        tunggu = true;
        setTimeout(() => { tunggu = false; try { scrapeNow(); } catch (e) { log(e); } }, 50);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
      ctx.timer = setInterval(tick, 500);
      tick();
    });
  }
  console.info("[EMR] Assesmen Monitor dimuat di", location.href);
  mulai();
})();
