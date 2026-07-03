/**
 * audioDuration.ts — decode the real playback duration of a recorded audio
 * buffer from its container header, so voice-minute metering against the
 * monthly cap reflects actual seconds rather than a byte-size guess.
 *
 * The renderer records with MediaRecorder, which on Electron/Chromium emits
 * WebM/Opus (`audio/webm;codecs=opus`) and, on some platforms, Ogg/Opus. Local
 * whisper.cpp paths may also hand us a WAV. We parse those three container
 * formats with a small, dependency-free reader:
 *
 *   • WAV  — read the `fmt ` byte-rate and `data` size → data / byteRate.
 *   • Ogg  — read the granule position of the last page (samples at the codec
 *            rate; Opus is always 48 kHz).
 *   • WebM — walk the EBML tree for the Segment Duration, or, when a streaming
 *            recorder omits it, the timestamp of the last cluster block.
 *
 * Every parser is defensive: any malformed/short/unknown buffer yields `null`
 * so the caller can fall back to its previous size-based estimate rather than
 * mis-charge the user.
 */

/** Read an unsigned big-endian integer of `len` bytes (len ≤ 6 keeps us inside
 *  Number's safe-integer range, which is all EBML/RIFF fields here need). */
function readUIntBE(buf: Buffer, start: number, len: number): number {
  let value = 0
  for (let i = 0; i < len; i++) value = value * 256 + buf[start + i]
  return value
}

// ── WAV (RIFF/WAVE) ──────────────────────────────────────────────────────────

function wavDuration(buf: Buffer): number | null {
  if (buf.length < 12) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }
  let byteRate = 0
  let dataSize = 0
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      // fmt layout: audioFormat(2) channels(2) sampleRate(4) byteRate(4) …
      byteRate = buf.readUInt32LE(body + 8)
    } else if (id === 'data') {
      // A streaming writer may leave size 0 or overstate it; clamp to what we have.
      dataSize = size === 0 || body + size > buf.length ? buf.length - body : size
    }
    // RIFF chunks are word-aligned — an odd size carries a pad byte.
    off = body + size + (size % 2)
  }
  if (byteRate > 0 && dataSize > 0) return dataSize / byteRate
  return null
}

// ── Ogg (Opus / Vorbis) ──────────────────────────────────────────────────────

/** Sample rate the granule position counts in: 48 kHz for Opus, or the rate in
 *  the Vorbis identification header. Defaults to 48 kHz when undetectable. */
function oggSampleRate(buf: Buffer): number {
  if (buf.indexOf('OpusHead') >= 0) return 48000
  const vorbisId = buf.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])) // 0x01 "vorbis"
  if (vorbisId >= 0 && vorbisId + 16 <= buf.length) {
    // id header: type(1) "vorbis"(6) version(4) channels(1) sampleRate(4) …
    const rate = buf.readUInt32LE(vorbisId + 12)
    if (rate > 0) return rate
  }
  return 48000
}

function oggDuration(buf: Buffer): number | null {
  const last = buf.lastIndexOf('OggS')
  if (last < 0 || last + 14 > buf.length) return null
  // Page header: "OggS"(4) version(1) flags(1) granulePosition(8, LE) …
  const granule = Number(buf.readBigUInt64LE(last + 6))
  if (!Number.isFinite(granule) || granule <= 0) return null
  return granule / oggSampleRate(buf)
}

// ── WebM (EBML / Matroska) ───────────────────────────────────────────────────

const ID_EBML = 0x1a45dfa3
const ID_SEGMENT = 0x18538067
const ID_INFO = 0x1549a966
const ID_CLUSTER = 0x1f43b675
const ID_TIMECODE_SCALE = 0x2ad7b1
const ID_DURATION = 0x4489
const ID_CLUSTER_TIMECODE = 0xe7
const ID_SIMPLE_BLOCK = 0xa3
const ID_BLOCK_GROUP = 0xa0
const ID_BLOCK = 0xa1

// Elements that live directly under Segment. Hitting one of these tells us an
// unknown-size Cluster (common in streamed recordings) has ended.
const SEGMENT_CHILD_IDS = new Set<number>([
  ID_INFO,
  ID_CLUSTER,
  0x1654ae6b, // Tracks
  0x1c53bb6b, // Cues
  0x114d9b74, // SeekHead
  0x1254c367, // Tags
  0x1941a469, // Attachments
  0x1043a770 // Chapters
])

/** Byte length of an EBML variable-length integer from its first byte's leading
 *  zero bits, or 0 when the byte is invalid. */
function vintLength(firstByte: number): number {
  for (let len = 1, mask = 0x80; len <= 8; len++, mask >>= 1) {
    if (firstByte & mask) return len
  }
  return 0
}

interface EbmlElement {
  id: number
  dataStart: number
  /** Element body length, or -1 when the size field encodes "unknown". */
  dataSize: number
}

function readElement(buf: Buffer, pos: number): EbmlElement | null {
  if (pos >= buf.length) return null
  const idLen = vintLength(buf[pos])
  if (idLen === 0 || pos + idLen > buf.length) return null
  const id = readUIntBE(buf, pos, idLen) // IDs keep their marker bit (match constants)

  const sp = pos + idLen
  if (sp >= buf.length) return null
  const sizeLen = vintLength(buf[sp])
  if (sizeLen === 0 || sp + sizeLen > buf.length) return null

  // Size value strips the marker bit; all-ones data bits mean "unknown size".
  let size = buf[sp] & (0xff >> sizeLen)
  let allOnes = size === (0xff >> sizeLen)
  for (let i = 1; i < sizeLen; i++) {
    size = size * 256 + buf[sp + i]
    if (buf[sp + i] !== 0xff) allOnes = false
  }
  return { id, dataStart: sp + sizeLen, dataSize: allOnes ? -1 : size }
}

/** Locate the Segment body once the EBML header is consumed. */
function findSegment(buf: Buffer): { start: number; end: number } | null {
  const ebml = readElement(buf, 0)
  if (!ebml || ebml.id !== ID_EBML) return null
  let p = ebml.dataSize < 0 ? ebml.dataStart : ebml.dataStart + ebml.dataSize
  while (p < buf.length) {
    const el = readElement(buf, p)
    if (!el) return null
    if (el.id === ID_SEGMENT) {
      const end = el.dataSize < 0 ? buf.length : Math.min(buf.length, el.dataStart + el.dataSize)
      return { start: el.dataStart, end }
    }
    if (el.dataSize < 0) return null
    p = el.dataStart + el.dataSize
  }
  return null
}

/** Relative int16 timecode carried by a (Simple)Block, after its track vint. */
function blockRelativeTime(buf: Buffer, dataStart: number, dataEnd: number): number | null {
  const trackLen = vintLength(buf[dataStart])
  if (trackLen === 0) return null
  const relPos = dataStart + trackLen
  if (relPos + 2 > dataEnd) return null
  return buf.readInt16BE(relPos)
}

function blockGroupRelativeTime(buf: Buffer, start: number, end: number): number | null {
  let p = start
  while (p < end) {
    const el = readElement(buf, p)
    if (!el) break
    const dataEnd = el.dataSize < 0 ? end : Math.min(end, el.dataStart + el.dataSize)
    if (el.id === ID_BLOCK) return blockRelativeTime(buf, el.dataStart, dataEnd)
    if (el.dataSize < 0) break
    p = el.dataStart + el.dataSize
  }
  return null
}

/** Highest block timestamp (in TimecodeScale ticks) inside one Cluster, plus the
 *  byte offset where the cluster ends (needed for unknown-size clusters). */
function parseCluster(
  buf: Buffer,
  start: number,
  hardEnd: number
): { maxTime: number | null; endPos: number } {
  let clusterTime = 0
  let hasClusterTime = false
  let maxRel: number | null = null
  let p = start
  while (p < hardEnd) {
    const el = readElement(buf, p)
    if (!el) {
      p = hardEnd
      break
    }
    if (SEGMENT_CHILD_IDS.has(el.id)) break // next sibling — cluster is over
    const dataEnd = el.dataSize < 0 ? hardEnd : Math.min(hardEnd, el.dataStart + el.dataSize)
    if (el.id === ID_CLUSTER_TIMECODE) {
      clusterTime = readUIntBE(buf, el.dataStart, dataEnd - el.dataStart)
      hasClusterTime = true
    } else if (el.id === ID_SIMPLE_BLOCK) {
      const rel = blockRelativeTime(buf, el.dataStart, dataEnd)
      if (rel !== null) maxRel = maxRel === null ? rel : Math.max(maxRel, rel)
    } else if (el.id === ID_BLOCK_GROUP) {
      const rel = blockGroupRelativeTime(buf, el.dataStart, dataEnd)
      if (rel !== null) maxRel = maxRel === null ? rel : Math.max(maxRel, rel)
    }
    if (el.dataSize < 0) {
      p = dataEnd
      break
    }
    p = el.dataStart + el.dataSize
  }
  const maxTime = hasClusterTime
    ? clusterTime + (maxRel ?? 0)
    : null
  return { maxTime, endPos: p }
}

function webmDuration(buf: Buffer): number | null {
  if (buf.length < 4 || buf.readUInt32BE(0) !== ID_EBML) return null
  const segment = findSegment(buf)
  if (!segment) return null

  let timecodeScale = 1_000_000 // ns per tick; Matroska default
  let durationTicks: number | null = null
  let maxClusterTime: number | null = null

  let p = segment.start
  while (p < segment.end) {
    const el = readElement(buf, p)
    if (!el) break
    const dataEnd = el.dataSize < 0 ? segment.end : Math.min(segment.end, el.dataStart + el.dataSize)

    if (el.id === ID_INFO) {
      // Read TimecodeScale + Duration from the Info block.
      let ip = el.dataStart
      while (ip < dataEnd) {
        const info = readElement(buf, ip)
        if (!info) break
        const infoEnd = info.dataSize < 0 ? dataEnd : Math.min(dataEnd, info.dataStart + info.dataSize)
        if (info.id === ID_TIMECODE_SCALE) {
          const scale = readUIntBE(buf, info.dataStart, infoEnd - info.dataStart)
          if (scale > 0) timecodeScale = scale
        } else if (info.id === ID_DURATION) {
          const len = infoEnd - info.dataStart
          if (len === 4) durationTicks = buf.readFloatBE(info.dataStart)
          else if (len === 8) durationTicks = buf.readDoubleBE(info.dataStart)
        }
        if (info.dataSize < 0) break
        ip = info.dataStart + info.dataSize
      }
    } else if (el.id === ID_CLUSTER) {
      const { maxTime, endPos } = parseCluster(buf, el.dataStart, dataEnd)
      if (maxTime !== null) {
        maxClusterTime = maxClusterTime === null ? maxTime : Math.max(maxClusterTime, maxTime)
      }
      if (el.dataSize < 0) {
        p = endPos
        continue
      }
    } else if (el.dataSize < 0) {
      break // can't safely skip an unknown-size non-cluster element
    }
    p = el.dataStart + el.dataSize
  }

  // Prefer the authoritative Segment Duration; fall back to the last block's
  // timestamp when a streaming recorder didn't write one.
  const ticks = durationTicks ?? maxClusterTime
  if (ticks === null || ticks <= 0) return null
  return (ticks * timecodeScale) / 1e9
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode the playback duration, in seconds, of a recorded audio buffer by
 * inspecting its container header. Returns `null` when the format is
 * unrecognised or lacks timing info, so callers can fall back to an estimate.
 */
export function decodeAudioDurationSeconds(buf: Buffer): number | null {
  if (!buf || buf.length < 12) return null
  try {
    if (buf.toString('ascii', 0, 4) === 'RIFF') return wavDuration(buf)
    if (buf.toString('ascii', 0, 4) === 'OggS') return oggDuration(buf)
    if (buf.readUInt32BE(0) === ID_EBML) return webmDuration(buf)
  } catch {
    return null
  }
  return null
}
