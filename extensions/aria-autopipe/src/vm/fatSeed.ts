/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure-JS FAT12 image builder for cloud-init NoCloud seeds.
//
// cloud-init's NoCloud datasource reads `user-data` / `meta-data` from any
// filesystem whose volume label is `cidata` — it does NOT have to be ISO9660.
// Building a tiny FAT12 image here (standard 1.44 MB floppy geometry) lets us
// produce the seed with ZERO external tools, so the built-in VM works on a
// vanilla Windows machine — which ships no oscdimg / mkisofs / genisoimage and
// otherwise fails to build the seed at all.
//
// The 1.44 MB floppy geometry is used verbatim because every FAT driver
// recognises it, so we never risk a BPB the guest kernel rejects. The two seed
// files are only a few hundred bytes, so the fixed image size is irrelevant.

const SECTOR = 512;
const TOTAL_SECTORS = 2880;      // 1.44 MB floppy
const RSVD_SECTORS = 1;
const NUM_FATS = 2;
const ROOT_ENTRIES = 224;
const SEC_PER_FAT = 9;
const SEC_PER_CLUS = 1;

export interface SeedFile { name: string; data: Buffer; }

/** 8.3 short-name alias (11 bytes: 8 name + 3 ext, space-padded). Our seed file
 *  names (`user-data`, `meta-data`) are known and collision-free, so a fixed
 *  `~1` tail is safe. */
function shortNameFor(name: string): Buffer {
	const base = name.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 6);
	const eightThree = (base + '~1').padEnd(8, ' ').slice(0, 8) + '   ';
	return Buffer.from(eightThree, 'ascii'); // 11 bytes
}

/** Checksum of the 11-byte short name, stored in every LFN entry. */
function lfnChecksum(short11: Buffer): number {
	let sum = 0;
	for (let i = 0; i < 11; i++) {
		sum = (((sum & 1) << 7) + (sum >> 1) + short11[i]) & 0xff;
	}
	return sum;
}

/** Long-file-name directory entries for `longName`, returned in on-disk order
 *  (highest sequence first), to be written immediately before the short entry. */
function lfnEntries(longName: string, checksum: number): Buffer[] {
	const units: number[] = [];
	for (const ch of longName) { units.push(ch.charCodeAt(0)); }
	units.push(0x0000); // NUL terminator
	while (units.length % 13 !== 0) { units.push(0xffff); } // pad the last entry
	const count = units.length / 13;
	const entries: Buffer[] = [];
	for (let seq = 1; seq <= count; seq++) {
		const e = Buffer.alloc(32);
		e[0] = (seq === count ? 0x40 : 0x00) | seq; // 0x40 marks the last entry
		e[11] = 0x0f;        // LFN attribute (RO|HID|SYS|VOL)
		e[12] = 0x00;
		e[13] = checksum;
		// bytes 26-27 (first-cluster) stay 0 for LFN entries
		const chunk = units.slice((seq - 1) * 13, seq * 13);
		const put = (idx: number, off: number) => e.writeUInt16LE(chunk[idx], off);
		put(0, 1); put(1, 3); put(2, 5); put(3, 7); put(4, 9);
		put(5, 14); put(6, 16); put(7, 18); put(8, 20); put(9, 22); put(10, 24);
		put(11, 28); put(12, 30);
		entries.push(e);
	}
	return entries.reverse();
}

function shortEntry(short11: Buffer, firstCluster: number, size: number): Buffer {
	const e = Buffer.alloc(32);
	short11.copy(e, 0, 0, 11);
	e[11] = 0x20; // archive
	e.writeUInt16LE(firstCluster & 0xffff, 26); // first cluster (low word)
	// cluster high (offset 20) stays 0 — FAT12 has no high word.
	e.writeUInt32LE(size >>> 0, 28);
	// date/time fields left 0 — cloud-init ignores them, and no clock is available.
	return e;
}

function volumeLabelEntry(label: string): Buffer {
	const e = Buffer.alloc(32);
	Buffer.from(label.toUpperCase().padEnd(11, ' ').slice(0, 11), 'ascii').copy(e, 0);
	e[11] = 0x08; // volume label
	return e;
}

/** Pack a 12-bit FAT entry (two entries share every 3 bytes). */
function setFat12(fat: Buffer, cluster: number, value: number): void {
	const off = Math.floor((cluster * 3) / 2);
	if (cluster & 1) {
		fat[off] = (fat[off] & 0x0f) | ((value << 4) & 0xf0);
		fat[off + 1] = (value >> 4) & 0xff;
	} else {
		fat[off] = value & 0xff;
		fat[off + 1] = (fat[off + 1] & 0xf0) | ((value >> 8) & 0x0f);
	}
}

/** Build a raw FAT12 disk image (label `cidata`) holding the given files. The
 *  result is written straight to disk and attached to QEMU as a raw drive. */
export function buildFatSeedImage(files: SeedFile[], volumeLabel = 'cidata'): Buffer {
	const img = Buffer.alloc(TOTAL_SECTORS * SECTOR); // zero-filled
	const rootDirSectors = Math.ceil((ROOT_ENTRIES * 32) / SECTOR); // 14
	const dataStartSector = RSVD_SECTORS + NUM_FATS * SEC_PER_FAT + rootDirSectors; // 33

	// --- boot sector / BPB ---
	img[0] = 0xeb; img[1] = 0x3c; img[2] = 0x90;
	Buffer.from('MSWIN4.1', 'ascii').copy(img, 3);
	img.writeUInt16LE(SECTOR, 11);
	img[13] = SEC_PER_CLUS;
	img.writeUInt16LE(RSVD_SECTORS, 14);
	img[16] = NUM_FATS;
	img.writeUInt16LE(ROOT_ENTRIES, 17);
	img.writeUInt16LE(TOTAL_SECTORS, 19);
	img[21] = 0xf0; // media descriptor
	img.writeUInt16LE(SEC_PER_FAT, 22);
	img.writeUInt16LE(18, 24); // sectors per track
	img.writeUInt16LE(2, 26);  // heads
	img.writeUInt32LE(0, 28);  // hidden sectors
	img.writeUInt32LE(0, 32);  // total sectors (32-bit) — 0, the 16-bit field is used
	img[36] = 0x00; // drive number
	img[38] = 0x29; // extended boot signature
	img.writeUInt32LE(0x41524941, 39); // volume id ("ARIA", fixed — no RNG available)
	Buffer.from(volumeLabel.toUpperCase().padEnd(11, ' ').slice(0, 11), 'ascii').copy(img, 43);
	Buffer.from('FAT12   ', 'ascii').copy(img, 54);
	img[510] = 0x55; img[511] = 0xaa;

	// --- FAT + file data + root directory entries ---
	const fat = Buffer.alloc(SEC_PER_FAT * SECTOR);
	setFat12(fat, 0, 0xff0); // media byte in the low 8 bits
	setFat12(fat, 1, 0xfff); // end-of-chain marker for the reserved entry
	let nextCluster = 2;
	const rootEntries: Buffer[] = [volumeLabelEntry(volumeLabel)];
	for (const f of files) {
		const clustersNeeded = Math.max(1, Math.ceil(f.data.length / SECTOR));
		const first = nextCluster;
		for (let i = 0; i < clustersNeeded; i++) {
			const cur = nextCluster++;
			setFat12(fat, cur, i === clustersNeeded - 1 ? 0xfff : cur + 1);
		}
		const dataOffset = (dataStartSector + (first - 2) * SEC_PER_CLUS) * SECTOR;
		f.data.copy(img, dataOffset);
		const short11 = shortNameFor(f.name);
		for (const e of lfnEntries(f.name, lfnChecksum(short11))) { rootEntries.push(e); }
		rootEntries.push(shortEntry(short11, first, f.data.length));
	}

	// Both FAT copies are identical.
	for (let n = 0; n < NUM_FATS; n++) {
		fat.copy(img, (RSVD_SECTORS + n * SEC_PER_FAT) * SECTOR);
	}

	// Root directory follows the FATs.
	let p = (RSVD_SECTORS + NUM_FATS * SEC_PER_FAT) * SECTOR;
	for (const e of rootEntries) { e.copy(img, p); p += 32; }

	return img;
}
