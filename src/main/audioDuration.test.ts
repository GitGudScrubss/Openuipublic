import { describe, it, expect } from 'vitest'
import { decodeAudioDurationSeconds } from './audioDuration'

/** Build a minimal but valid WAV file of `dataBytes` PCM at the given format. */
function makeWav(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}

/** Build a single-page Ogg buffer whose last page carries `granule` samples,
 *  tagged as Opus so the reader assumes a 48 kHz rate. */
function makeOgg(granule: number): Buffer {
  const page = Buffer.alloc(28 + 8)
  page.write('OggS', 0, 'ascii')
  page.writeUInt8(0, 4) // version
  page.writeUInt8(0, 5) // header type
  page.writeBigUInt64LE(BigInt(granule), 6)
  // remaining header bytes (serial, seq, checksum, segment table) left zero
  page.write('OpusHead', 28, 'ascii')
  return page
}

/** Build a WebM file carrying only EBML + Segment > Info(TimecodeScale, Duration). */
function makeWebmWithDuration(timecodeScale: number, durationTicks: number): Buffer {
  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]) // empty EBML header

  const scaleBody = Buffer.alloc(4)
  scaleBody.writeUInt32BE(timecodeScale, 0)
  const scaleEl = Buffer.concat([Buffer.from([0x2a, 0xd7, 0xb1, 0x84]), scaleBody]) // 4-byte uint

  const durBody = Buffer.alloc(8)
  durBody.writeDoubleBE(durationTicks, 0)
  const durEl = Buffer.concat([Buffer.from([0x44, 0x89, 0x88]), durBody]) // 8-byte float

  const infoContent = Buffer.concat([scaleEl, durEl])
  const info = Buffer.concat([Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | infoContent.length]), infoContent])
  const segment = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x80 | info.length]), info])
  return Buffer.concat([ebml, segment])
}

describe('decodeAudioDurationSeconds', () => {
  it('returns null for empty or too-short buffers', () => {
    expect(decodeAudioDurationSeconds(Buffer.alloc(0))).toBeNull()
    expect(decodeAudioDurationSeconds(Buffer.from('short'))).toBeNull()
  })

  it('returns null for an unrecognised container', () => {
    expect(decodeAudioDurationSeconds(Buffer.alloc(64, 0x7a))).toBeNull()
  })

  it('decodes a WAV from byte-rate and data size', () => {
    // 16 kHz mono 16-bit → 32000 bytes/sec; 64000 data bytes → 2.0 s
    const wav = makeWav(16000, 1, 16, 64000)
    expect(decodeAudioDurationSeconds(wav)).toBeCloseTo(2.0, 5)
  })

  it('decodes an Opus/Ogg from the last granule position (48 kHz)', () => {
    const ogg = makeOgg(96000) // 96000 / 48000 = 2.0 s
    expect(decodeAudioDurationSeconds(ogg)).toBeCloseTo(2.0, 5)
  })

  it('decodes a WebM Segment Duration scaled by TimecodeScale', () => {
    // Duration 2000 ticks × 1_000_000 ns/tick = 2.0 s
    const webm = makeWebmWithDuration(1_000_000, 2000)
    expect(decodeAudioDurationSeconds(webm)).toBeCloseTo(2.0, 5)
  })
})
