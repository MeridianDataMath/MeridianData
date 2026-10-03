/* MeridianDataHub — Tax center ZIP: every file of a report in one download, written in the browser. Stored entries only
   (no deflate: a report's CSVs are a few hundred kilobytes, and storing keeps this short and free of any dependency),
   UTF-8 file names (general-purpose flag bit 11), no ZIP64 (a report stays far below 4 GB and 65,535 files). Pure: no
   DOM, no network. */
(function () {
  const MD = window.MD; const T = MD.tax;
  const Z = (T.zip = {});

  let TABLE = null;
  const table = () => {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
    return TABLE;
  };
  /** text as UTF-8 bytes */
  Z.utf8 = (s) => new TextEncoder().encode(String(s));
  /** CRC-32 (the one ZIP and zlib use) of bytes */
  Z.crc32 = (bytes) => {
    const tb = table(); let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = tb[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  // MS-DOS time and date (two-second steps, years from 1980) from the UTC fields: the file times are the generation time
  const dos = (d) => {
    const y = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
    return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
  };
  /** A name not taken yet: 'a.csv', then 'a (2).csv', … (two files of one report never overwrite each other) */
  const unique = (name, seen) => {
    let n = name, k = 1;
    while (seen.has(n.toLowerCase())) { k++; n = name.replace(/(\.[a-z0-9]+)?$/i, (m) => ` (${k})` + (m || '')); }
    seen.add(n.toLowerCase());
    return n;
  };

  /**
   * files: [{name, data (text, or bytes)}] → the ZIP's bytes (a Uint8Array). date: the entries' time (a Date or ms;
   * now when left out).
   */
  Z.build = (files, date) => {
    const when = dos(date instanceof Date ? date : new Date(date == null ? Date.now() : date));
    const parts = [], central = [], seen = new Set();
    let off = 0;
    for (const f of files) {
      const name = Z.utf8(unique(String(f.name), seen));
      const data = typeof f.data === 'string' ? Z.utf8(f.data) : f.data;
      const crc = Z.crc32(data);
      // local file header: version 2.0, UTF-8 names, stored
      const loc = new DataView(new ArrayBuffer(30));
      loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true); loc.setUint16(8, 0, true);
      loc.setUint16(10, when.time, true); loc.setUint16(12, when.date, true); loc.setUint32(14, crc, true);
      loc.setUint32(18, data.length, true); loc.setUint32(22, data.length, true); loc.setUint16(26, name.length, true); loc.setUint16(28, 0, true);
      parts.push(new Uint8Array(loc.buffer), name, data);
      // its central directory record
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
      cen.setUint16(12, when.time, true); cen.setUint16(14, when.date, true); cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, name.length, true);
      cen.setUint16(30, 0, true); cen.setUint16(32, 0, true); cen.setUint16(34, 0, true); cen.setUint16(36, 0, true); cen.setUint32(38, 0, true); cen.setUint32(42, off, true);
      central.push(new Uint8Array(cen.buffer), name);
      off += 30 + name.length + data.length;
      if (off > 0xffffffff) throw new Error('the ZIP would be larger than 4 GB');
    }
    if (files.length > 0xffff) throw new Error('too many files for one ZIP');
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true); end.setUint16(20, 0, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
    let i = 0;
    for (const p of all) { out.set(p, i); i += p.length; }
    return out;
  };
})();
